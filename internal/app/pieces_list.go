package app

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
)

const pieceColumns = `
	p.id, p.title, p.composer, p.favorite, p.status, p.source_url, p.listening_url, p.notes,
	p.aliases, p.opus, p.music_key, p.created_at, p.updated_at,
	f.original_filename, f.size_bytes, f.checksum_sha256, f.page_count, f.uploaded_at,
	r.updated_at`

// The reader saves its state on every checkpoint, so r.updated_at is when the
// piece was last played.
const pieceTables = `
	pieces p
	LEFT JOIN piece_pdfs f ON f.piece_id=p.id
	LEFT JOIN reader_states r ON r.piece_id=p.id`

const titleOrder = `lower(p.title), lower(p.composer), p.id`

// pieceOrders are the library's sorts. Composer starts in title order and is
// then sorted by surname, which SQL cannot pick out reliably. Fresh leaves
// pieces without a PDF, which cannot be played, until last.
var pieceOrders = map[string]string{
	SortTitle:    titleOrder,
	SortComposer: titleOrder,
	SortRecent:   `r.updated_at DESC NULLS LAST, ` + titleOrder,
	SortAdded:    `p.created_at DESC, ` + titleOrder,
	SortFresh:    `f.piece_id IS NULL, r.updated_at ASC NULLS FIRST, ` + titleOrder,
}

// ListPieces lists the user's pieces that match the options, in their sort.
func (s *Service) ListPieces(ctx context.Context, userID string, options ListOptions) ([]Piece, error) {
	where, order, args, err := listClauses(userID, options)
	if err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `
		SELECT `+pieceColumns+`
		FROM `+pieceTables+`
		WHERE `+where+`
		ORDER BY `+order, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	pieces := []Piece{}
	for rows.Next() {
		piece, err := scanPiece(rows)
		if err != nil {
			return nil, err
		}
		pieces = append(pieces, piece)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if options.Sort == SortComposer {
		sortByComposer(pieces, func(piece Piece) string { return piece.Composer })
	}
	terms := searchTerms(options.Query)
	if len(terms) > 0 {
		ranks := make(map[string]int, len(pieces))
		for _, p := range pieces {
			ranks[p.ID] = exactTermRank(searchText(PieceInput{Title: p.Title, Composer: p.Composer, Aliases: p.Aliases, Notes: p.Notes, Opus: p.Opus, MusicKey: p.MusicKey}), terms)
		}
		sort.SliceStable(pieces, func(i, j int) bool { return ranks[pieces[i].ID] < ranks[pieces[j].ID] })
	}

	return pieces, nil
}

// ListPieceSummaries lists the same pieces as ListPieces, as summaries.
func (s *Service) ListPieceSummaries(
	ctx context.Context,
	userID string,
	options ListOptions,
) ([]PieceSummary, error) {
	where, order, args, err := listClauses(userID, options)
	if err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `
		SELECT p.id, p.title, p.composer, p.aliases, p.favorite, p.status, p.listening_url,
			f.page_count, r.updated_at, p.created_at, p.search_text
		FROM `+pieceTables+`
		WHERE `+where+`
		ORDER BY `+order, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	summaries := []PieceSummary{}
	for rows.Next() {
		var summary PieceSummary
		var pages *int
		if err := rows.Scan(
			&summary.ID, &summary.Title, &summary.Composer, &summary.Aliases, &summary.Favorite,
			&summary.Status, &summary.ListeningURL, &pages, &summary.LastPlayedAt, &summary.CreatedAt,
			&summary.SearchText,
		); err != nil {
			return nil, err
		}
		if pages != nil {
			summary.PDF = &SummaryPDF{PageCount: *pages, ContentURL: "/api/pieces/" + summary.ID + "/pdf"}
		}
		summaries = append(summaries, summary)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if options.Sort == SortComposer {
		sortByComposer(summaries, func(summary PieceSummary) string { return summary.Composer })
	}
	terms := searchTerms(options.Query)
	if len(terms) > 0 {
		sort.SliceStable(summaries, func(i, j int) bool {
			return exactTermRank(summaries[i].SearchText, terms) < exactTermRank(summaries[j].SearchText, terms)
		})
	}
	return summaries, nil
}

// listClauses are the WHERE and ORDER BY of the user's pieces that match the
// options, and their arguments.
func listClauses(userID string, options ListOptions) (string, string, []any, error) {
	order, ok := pieceOrders[options.Sort]
	if !ok {
		return "", "", nil, invalid("sort must be title, composer, recent, added or fresh")
	}
	args := []any{userID}
	clauses := []string{"p.user_id=$1"}
	// Each word may match anywhere, so "chopin nocturne" finds the Chopin
	// nocturnes, "dvorak" finds Dvořák and "op28/4" finds Op. 28 No. 4.
	for _, token := range searchTerms(options.Query) {
		column, pattern := searchPattern(token)
		args = append(args, pattern)
		clauses = append(clauses, fmt.Sprintf(column+` LIKE $%d ESCAPE '\'`, len(args)))
	}
	if options.Favorite != nil {
		args = append(args, *options.Favorite)
		clauses = append(clauses, fmt.Sprintf("p.favorite = $%d", len(args)))
	}
	if options.Statuses != nil {
		args = append(args, options.Statuses)
		clauses = append(clauses, fmt.Sprintf("p.status = ANY($%d)", len(args)))
	}
	return strings.Join(clauses, " AND "), order, args, nil
}

// ContinueWithinDays is how recently a piece must have been played for the
// library to offer it under Continue.
const ContinueWithinDays = 14

// ContinuePiece is the user's most recently played piece with a PDF, from the
// whole library whatever its status, if it was played in the last
// ContinueWithinDays days; nil otherwise.
func (s *Service) ContinuePiece(ctx context.Context, userID string) (*Piece, error) {
	piece, err := scanPiece(s.pool.QueryRow(ctx, `
		SELECT `+pieceColumns+`
		FROM `+pieceTables+`
		WHERE p.user_id=$1 AND f.piece_id IS NOT NULL
			AND r.updated_at >= now() - make_interval(days => $2)
		ORDER BY r.updated_at DESC, `+titleOrder+`
		LIMIT 1`, userID, ContinueWithinDays))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &piece, nil
}
