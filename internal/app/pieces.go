package app

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (s *Service) GetPiece(ctx context.Context, userID, id string) (Piece, error) {
	row := s.pool.QueryRow(ctx, `
		SELECT `+pieceColumns+`
		FROM `+pieceTables+`
		WHERE p.id=$1 AND p.user_id=$2`, id, userID)
	piece, err := scanPiece(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return Piece{}, ErrNotFound
	}
	return piece, err
}

func (s *Service) CreatePiece(ctx context.Context, userID string, input PieceInput) (Piece, error) {
	if input.Status == nil {
		playing := StatusPlaying
		input.Status = &playing
	}
	input, err := validatePiece(input)
	if err != nil {
		return Piece{}, err
	}
	tx, err := s.importTx(ctx, userID)
	if err != nil {
		return Piece{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // Best-effort cleanup, including already-committed transactions.
	id := uuid.NewString()
	err = tx.QueryRow(ctx, `
		INSERT INTO pieces
			(id, user_id, title, composer, favorite, status, source_url, listening_url, notes,
				aliases, search_text, composer_sort, composer_sort_source, composer_sort_version, opus, music_key)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$4,$13,$14,$15) RETURNING id`,
		id, userID, input.Title, input.Composer, input.Favorite, *input.Status, input.SourceURL,
		input.ListeningURL, input.Notes, input.Aliases, searchText(input), composerSortKey(input.Composer), composerKeyVersion, input.Opus, input.MusicKey,
	).Scan(&id)
	if err != nil {
		return Piece{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Piece{}, err
	}
	return s.GetPiece(ctx, userID, id)
}

func (s *Service) UpdatePiece(
	ctx context.Context,
	userID, id string,
	patch PiecePatch,
) (Piece, error) {
	tx, err := s.importTx(ctx, userID)
	if err != nil {
		return Piece{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // Best-effort transaction cleanup; keep the operation error and allow already-committed transactions.
	current, err := scanPiece(tx.QueryRow(ctx, `SELECT `+pieceColumns+` FROM `+pieceTables+` WHERE p.id=$1 AND p.user_id=$2`, id, userID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Piece{}, ErrNotFound
	}
	if err != nil {
		return Piece{}, err
	}
	input := PieceInput{
		Title: current.Title, Composer: current.Composer, Favorite: current.Favorite,
		Status: &current.Status, SourceURL: current.SourceURL, ListeningURL: current.ListeningURL,
		Notes: current.Notes, Aliases: current.Aliases, Opus: current.Opus, MusicKey: current.MusicKey,
	}
	if patch.Opus != nil {
		input.Opus = *patch.Opus
	}
	if patch.MusicKey != nil {
		input.MusicKey = *patch.MusicKey
	}
	if patch.Title != nil {
		input.Title = *patch.Title
	}
	if patch.Composer != nil {
		input.Composer = *patch.Composer
	}
	if patch.Favorite != nil {
		input.Favorite = *patch.Favorite
	}
	if patch.Status != nil {
		input.Status = patch.Status
	}
	if patch.SourceURL != nil {
		input.SourceURL = *patch.SourceURL
	}
	if patch.ListeningURL != nil {
		input.ListeningURL = *patch.ListeningURL
	}
	if patch.Notes != nil {
		input.Notes = *patch.Notes
	}
	if patch.Aliases != nil {
		input.Aliases = *patch.Aliases
	}
	input, err = validatePiece(input)
	if err != nil {
		return Piece{}, err
	}
	tag, err := tx.Exec(ctx, `
		UPDATE pieces SET title=$2, composer=$3, favorite=$4, source_url=$5,
			listening_url=$6, notes=$7, status=$9, aliases=$10, search_text=$11, composer_sort=$12, composer_sort_source=$3, composer_sort_version=$13, opus=$14, music_key=$15, updated_at=now()
		WHERE id=$1 AND user_id=$8`,
		id, input.Title, input.Composer, input.Favorite, input.SourceURL,
		input.ListeningURL, input.Notes, userID, *input.Status, input.Aliases, searchText(input), composerSortKey(input.Composer), composerKeyVersion, input.Opus, input.MusicKey)
	if err != nil {
		return Piece{}, err
	}
	if tag.RowsAffected() == 0 {
		return Piece{}, ErrNotFound
	}
	if err = tx.Commit(ctx); err != nil {
		return Piece{}, err
	}
	return s.GetPiece(ctx, userID, id)
}

func (s *Service) DeletePiece(ctx context.Context, userID, id string) error {
	tx, err := s.importTx(ctx, userID)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // Best-effort transaction cleanup; keep the operation error and allow already-committed transactions.
	var key *string
	err = tx.QueryRow(ctx, `
		SELECT f.storage_key FROM pieces p
		LEFT JOIN piece_pdfs f ON f.piece_id=p.id
		WHERE p.id=$1 AND p.user_id=$2 FOR UPDATE OF p`, id, userID).Scan(&key)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM pieces WHERE id=$1 AND user_id=$2`, id, userID); err != nil {
		return err
	}
	if err := collectOrphans(ctx, tx); err != nil {
		return err
	}
	if key != nil {
		if err := queueKey(ctx, tx, *key); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

type rowScanner interface {
	Scan(...any) error
}

func scanPiece(row rowScanner) (Piece, error) {
	var piece Piece
	var filename, checksum *string
	var size *int64
	var pages *int
	var uploaded *time.Time
	err := row.Scan(
		&piece.ID, &piece.Title, &piece.Composer, &piece.Favorite, &piece.Status,
		&piece.SourceURL, &piece.ListeningURL, &piece.Notes, &piece.Aliases, &piece.Opus, &piece.MusicKey, &piece.CreatedAt, &piece.UpdatedAt,
		&filename, &size, &checksum, &pages, &uploaded, &piece.LastPlayedAt,
	)
	if err != nil {
		return Piece{}, err
	}
	if filename != nil && size != nil && checksum != nil && pages != nil && uploaded != nil {
		piece.PDF = &PDF{
			OriginalFilename: *filename, SizeBytes: *size, ChecksumSHA256: *checksum,
			PageCount: *pages, UploadedAt: *uploaded,
			ContentURL: "/api/pieces/" + piece.ID + "/pdf",
		}
	}
	return piece, nil
}
