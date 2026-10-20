package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

const composerKeyVersion = 1
const composerRepairBatch = 250

var ErrComposerChanged = errors.New("composer selection changed; review a fresh preview before merging")

type ComposerPiece struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	Composer string `json:"composer"`
	HasPDF   bool   `json:"hasPdf"`
}
type ComposerEntry struct {
	Name   string          `json:"name"`
	Key    string          `json:"key"`
	Group  string          `json:"group"`
	Count  int             `json:"count"`
	Pieces []ComposerPiece `json:"pieces"`
}
type ComposerMerge struct {
	Spellings   []string `json:"spellings"`
	Target      string   `json:"target"`
	Fingerprint string   `json:"fingerprint,omitempty"`
}
type ComposerPreview struct {
	Fingerprint string          `json:"fingerprint"`
	Count       int             `json:"count"`
	Pieces      []ComposerPiece `json:"pieces"`
}

// ListComposers preserves each exact display spelling, including the unnamed
// group. Old replicas can leave keys stale at any time during rollout.
func (s *Service) ListComposers(ctx context.Context, owner string) ([]ComposerEntry, error) {
	rows, err := s.pool.Query(ctx, `SELECT p.id,p.title,p.composer,p.composer_sort,p.composer_sort_source,p.composer_sort_version,
 EXISTS(SELECT 1 FROM piece_pdfs f WHERE f.piece_id=p.id) FROM pieces p WHERE p.user_id=$1
 ORDER BY lower(p.title),p.id`, owner)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	entries := []ComposerEntry{}
	indexes := map[string]int{}
	for rows.Next() {
		var p ComposerPiece
		var key, source string
		var version int
		if err := rows.Scan(&p.ID, &p.Title, &p.Composer, &key, &source, &version, &p.HasPDF); err != nil {
			return nil, err
		}
		if version != composerKeyVersion || source != p.Composer {
			key = composerSortKey(p.Composer)
		}
		i, ok := indexes[p.Composer]
		if !ok {
			group, _, _ := strings.Cut(key, " ")
			i = len(entries)
			indexes[p.Composer] = i
			entries = append(entries, ComposerEntry{Name: p.Composer, Key: key, Group: group, Pieces: []ComposerPiece{}})
		}
		entries[i].Count++
		entries[i].Pieces = append(entries[i].Pieces, p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	slices.SortFunc(entries, func(a, b ComposerEntry) int {
		if (a.Group == "") != (b.Group == "") {
			if a.Group == "" {
				return 1
			}
			return -1
		}
		if order := strings.Compare(a.Key, b.Key); order != 0 {
			return order
		}
		return strings.Compare(a.Name, b.Name)
	})
	return entries, nil
}

// RepairComposerKeys repairs at most one batch per transaction. Row locks skip
// concurrent repairers, while the source comparison also protects newer writes.
// Repair touches only derived columns: never a display value or updated_at.
func (s *Service) RepairComposerKeys(ctx context.Context) (int, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // Best-effort transaction cleanup, including committed transactions.
	rows, err := tx.Query(ctx, `SELECT id,composer FROM pieces WHERE composer_sort_version<>$1 OR composer_sort_source<>composer
 ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED`, composerKeyVersion, composerRepairBatch)
	if err != nil {
		return 0, err
	}
	type stale struct{ id, name string }
	batch := []stale{}
	for rows.Next() {
		var p stale
		if err := rows.Scan(&p.id, &p.name); err != nil {
			rows.Close()
			return 0, err
		}
		batch = append(batch, p)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return 0, err
	}
	for _, p := range batch {
		if _, err := tx.Exec(ctx, `UPDATE pieces SET composer_sort=$3,composer_sort_source=$2,composer_sort_version=$4 WHERE id=$1 AND composer=$2`, p.id, p.name, composerSortKey(p.name), composerKeyVersion); err != nil {
			return 0, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return len(batch), nil
}

// Each batch has a short deadline. The next batch resumes after interruption;
// periodic passes repair writes made by old replicas after startup too.
func (s *Service) RunComposerRepair(ctx context.Context) {
	delay := time.Duration(0)
	for {
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
		batchCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		count, err := s.RepairComposerKeys(batchCtx)
		cancel()
		delay = time.Minute
		if err != nil && ctx.Err() == nil {
			slog.Warn("Composer key repair failed")
		}
		if err == nil && count == composerRepairBatch {
			delay = time.Second
		}
	}
}

func validateComposerMerge(input ComposerMerge) (ComposerMerge, error) {
	if len(input.Spellings) < 1 || len(input.Spellings) > 100 {
		return input, invalid("select between 1 and 100 composer spellings")
	}
	input.Spellings = slices.Clone(input.Spellings)
	slices.Sort(input.Spellings)
	input.Spellings = slices.Compact(input.Spellings)
	// These are exact persisted identities, including legacy surrounding whitespace.
	for _, name := range input.Spellings {
		if !utf8.ValidString(name) || len(name) > 300 {
			return input, invalid("invalid composer spelling")
		}
	}
	input.Target = strings.TrimSpace(input.Target)
	if input.Target == "" || !utf8.ValidString(input.Target) || len(input.Target) > 300 {
		return input, invalid("target composer must contain 1 to 300 characters")
	}
	return input, nil
}

func composerPreview(ctx context.Context, tx pgx.Tx, owner string, input ComposerMerge) (ComposerPreview, error) {
	rows, err := tx.Query(ctx, `SELECT p.id,p.title,p.composer,EXISTS(SELECT 1 FROM piece_pdfs f WHERE f.piece_id=p.id)
 FROM pieces p WHERE p.user_id=$1 AND p.composer=ANY($2::text[]) ORDER BY p.id FOR UPDATE OF p`, owner, input.Spellings)
	if err != nil {
		return ComposerPreview{}, err
	}
	defer rows.Close()
	result := ComposerPreview{Pieces: []ComposerPiece{}}
	present := map[string]bool{}
	// Fingerprint includes the owner, exact selection, target, and current ID/name
	// pairs. Title changes do not alter which pieces a spelling merge affects.
	identity := struct {
		Owner     string
		Target    string
		Spellings []string
		Pieces    [][2]string
	}{Owner: owner, Target: input.Target, Spellings: input.Spellings}
	for rows.Next() {
		var p ComposerPiece
		if err := rows.Scan(&p.ID, &p.Title, &p.Composer, &p.HasPDF); err != nil {
			return result, err
		}
		result.Pieces = append(result.Pieces, p)
		present[p.Composer] = true
		identity.Pieces = append(identity.Pieces, [2]string{p.ID, p.Composer})
	}
	if err := rows.Err(); err != nil {
		return result, err
	}
	if len(present) != len(input.Spellings) {
		return result, ErrComposerChanged
	}
	encoded, err := json.Marshal(identity)
	if err != nil {
		return result, err
	}
	sum := sha256.Sum256(encoded)
	result.Fingerprint = hex.EncodeToString(sum[:])
	result.Count = len(result.Pieces)
	return result, nil
}

func (s *Service) PreviewComposerMerge(ctx context.Context, owner string, input ComposerMerge) (ComposerPreview, error) {
	input, err := validateComposerMerge(input)
	if err != nil {
		return ComposerPreview{}, err
	}
	tx, err := s.importTx(ctx, owner)
	if err != nil {
		return ComposerPreview{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // Read-only preview releases its locks on return.
	return composerPreview(ctx, tx, owner, input)
}

func (s *Service) MergeComposers(ctx context.Context, owner string, input ComposerMerge) (ComposerPreview, error) {
	input, err := validateComposerMerge(input)
	if err != nil {
		return ComposerPreview{}, err
	}
	if len(input.Fingerprint) != 64 {
		return ComposerPreview{}, invalid("a current merge preview is required")
	}
	tx, err := s.importTx(ctx, owner)
	if err != nil {
		return ComposerPreview{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // Best-effort cleanup, including committed transactions.
	// Older replicas create pieces without the owner advisory lock. Their FK
	// check takes KEY SHARE on this user row, so lock it before selecting the
	// merge set. An earlier insert is visible to that selection; a later insert
	// waits until this merge commits. Keep advisory -> user -> piece lock order.
	var lockedOwner string
	if err := tx.QueryRow(ctx, `SELECT id FROM users WHERE id=$1 FOR UPDATE`, owner).Scan(&lockedOwner); err != nil {
		return ComposerPreview{}, err
	}
	preview, err := composerPreview(ctx, tx, owner, input)
	if err != nil {
		return ComposerPreview{}, err
	}
	if input.Fingerprint != preview.Fingerprint {
		return ComposerPreview{}, ErrComposerChanged
	}
	for _, p := range preview.Pieces {
		var metadata PieceInput
		// Preserve every field used by search. The owner lock and row locks keep
		// concurrent metadata edits from being overwritten while this merge commits.
		if err := tx.QueryRow(ctx, `SELECT title,aliases,notes FROM pieces WHERE id=$1 AND user_id=$2`, p.ID, owner).Scan(&metadata.Title, &metadata.Aliases, &metadata.Notes); err != nil {
			return ComposerPreview{}, err
		}
		metadata.Composer = input.Target
		if _, err := tx.Exec(ctx, `UPDATE pieces SET composer=$3,composer_sort=$4,composer_sort_source=$3,composer_sort_version=$5,search_text=$6,updated_at=now() WHERE id=$1 AND user_id=$2`, p.ID, owner, input.Target, composerSortKey(input.Target), composerKeyVersion, searchText(metadata)); err != nil {
			return ComposerPreview{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return ComposerPreview{}, err
	}
	return preview, nil
}
