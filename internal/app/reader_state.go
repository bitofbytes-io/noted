package app

import (
	"context"
	"errors"
	"io/fs"
	"time"

	"github.com/bitofbytes-io/noted/internal/assets"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

var ErrPDFChanged = errors.New("score PDF changed; reload before saving reader state")

type PDFSource struct {
	OriginalFilename string
	StorageKey       string
	UploadedAt       time.Time
}

func (s *Service) PDFSource(
	ctx context.Context,
	userID, id string,
) (PDFSource, assets.ReadSeekCloser, error) {
	var source PDFSource
	err := s.pool.QueryRow(ctx, `
		SELECT f.original_filename, f.storage_key, f.uploaded_at
		FROM piece_pdfs f
		JOIN pieces p ON p.id=f.piece_id
		WHERE f.piece_id=$1 AND p.user_id=$2`, id, userID,
	).Scan(&source.OriginalFilename, &source.StorageKey, &source.UploadedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return PDFSource{}, nil, ErrNotFound
	}
	if err != nil {
		return PDFSource{}, nil, err
	}
	reader, err := s.store.Open(ctx, source.StorageKey)
	if errors.Is(err, fs.ErrNotExist) {
		return PDFSource{}, nil, ErrNotFound
	}
	return source, reader, err
}

func (s *Service) GetReaderState(ctx context.Context, userID, id string) (ReaderState, error) {
	var state ReaderState
	err := s.pool.QueryRow(ctx, `
		SELECT r.piece_id, f.checksum_sha256, r.mode, r.last_page, r.scroll_position, r.zoom, r.scroll_speed,
			r.scroll_paused, r.updated_at
		FROM reader_states r
		JOIN pieces p ON p.id=r.piece_id
		JOIN piece_pdfs f ON f.piece_id=r.piece_id
		WHERE r.piece_id=$1 AND p.user_id=$2`, id, userID,
	).Scan(&state.PieceID, &state.PDFChecksumSHA256, &state.Mode, &state.LastPage, &state.ScrollPosition,
		&state.Zoom, &state.ScrollSpeed, &state.ScrollPaused, &state.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		var checksum string
		if scanErr := s.pool.QueryRow(ctx, `
			SELECT f.checksum_sha256 FROM pieces p
			JOIN piece_pdfs f ON f.piece_id=p.id
			WHERE p.id=$1 AND p.user_id=$2`,
			id, userID).Scan(&checksum); scanErr != nil {
			if errors.Is(scanErr, pgx.ErrNoRows) {
				return ReaderState{}, ErrNotFound
			}
			return ReaderState{}, scanErr
		}
		return ReaderState{
			PieceID: id, PDFChecksumSHA256: checksum, Mode: "page", LastPage: 1, Zoom: 1,
			ScrollSpeed: 5, ScrollPaused: true,
		}, nil
	}
	return state, err
}

func (s *Service) PutReaderState(
	ctx context.Context,
	userID, id string,
	state ReaderState,
) (ReaderState, error) {
	state.PieceID = id
	if err := ValidateReaderState(state); err != nil {
		return ReaderState{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ReaderState{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // Best-effort transaction cleanup; keep the operation error and allow already-committed transactions.
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, id); err != nil {
		return ReaderState{}, err
	}
	var checksum string
	err = tx.QueryRow(ctx, `
		SELECT f.checksum_sha256 FROM pieces p
		JOIN piece_pdfs f ON f.piece_id=p.id
		WHERE p.id=$1 AND p.user_id=$2
		FOR UPDATE OF p,f`, id, userID).Scan(&checksum)
	if errors.Is(err, pgx.ErrNoRows) {
		return ReaderState{}, ErrNotFound
	}
	if err != nil {
		return ReaderState{}, err
	}
	if checksum != state.PDFChecksumSHA256 {
		return ReaderState{}, ErrPDFChanged
	}
	err = tx.QueryRow(ctx, `
		INSERT INTO reader_states
			(piece_id, mode, last_page, scroll_position, zoom, scroll_speed, scroll_paused)
		VALUES ($1,$2,$3,$4,$5,$6,$7)
		ON CONFLICT (piece_id) DO UPDATE SET
			mode=excluded.mode, last_page=excluded.last_page,
			scroll_position=excluded.scroll_position, zoom=excluded.zoom,
			scroll_speed=excluded.scroll_speed, scroll_paused=excluded.scroll_paused,
			updated_at=now()
		RETURNING piece_id, mode, last_page, scroll_position, zoom, scroll_speed,
			scroll_paused, updated_at`,
		id, state.Mode, state.LastPage, state.ScrollPosition, state.Zoom,
		state.ScrollSpeed, state.ScrollPaused,
	).Scan(&state.PieceID, &state.Mode, &state.LastPage, &state.ScrollPosition,
		&state.Zoom, &state.ScrollSpeed, &state.ScrollPaused, &state.UpdatedAt)
	if err != nil {
		var databaseError *pgconn.PgError
		if errors.As(err, &databaseError) && databaseError.Code == "23503" {
			return ReaderState{}, ErrNotFound
		}
		return ReaderState{}, err
	}
	state.PDFChecksumSHA256 = checksum
	if err = tx.Commit(ctx); err != nil {
		return ReaderState{}, err
	}
	return state, nil
}
