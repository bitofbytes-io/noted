package app

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"strings"
	"time"

	"github.com/bitofbytes-io/noted/internal/assets"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrNotFound = errors.New("not found")

type PDFSource struct {
	OriginalFilename string
	StorageKey       string
	UploadedAt       time.Time
}

type Service struct {
	pool           *pgxpool.Pool
	store          assets.Store
	maxUploadBytes int64
}

func NewService(pool *pgxpool.Pool, store assets.Store, limits ...int64) *Service {
	s := &Service{pool: pool, store: store}
	if len(limits) > 0 {
		s.maxUploadBytes = limits[0]
	}
	return s
}

const pieceColumns = `
	p.id, p.title, p.composer, p.favorite, p.source_url, p.listening_url, p.notes,
	p.created_at, p.updated_at,
	f.original_filename, f.size_bytes, f.checksum_sha256, f.page_count, f.uploaded_at`

func (s *Service) ListPieces(
	ctx context.Context,
	userID, query string,
	favorite *bool,
) ([]Piece, error) {
	args := []any{userID}
	clauses := []string{"p.user_id=$1"}
	if query = strings.TrimSpace(query); query != "" {
		args = append(args, "%"+query+"%")
		clauses = append(clauses, fmt.Sprintf("(p.title ILIKE $%d OR p.composer ILIKE $%d)", len(args), len(args)))
	}
	if favorite != nil {
		args = append(args, *favorite)
		clauses = append(clauses, fmt.Sprintf("p.favorite = $%d", len(args)))
	}
	rows, err := s.pool.Query(ctx, `
		SELECT `+pieceColumns+`
		FROM pieces p LEFT JOIN piece_pdfs f ON f.piece_id=p.id
		WHERE `+strings.Join(clauses, " AND ")+`
		ORDER BY p.favorite DESC, lower(p.title), lower(p.composer)`, args...)
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
	return pieces, rows.Err()
}

func (s *Service) GetPiece(ctx context.Context, userID, id string) (Piece, error) {
	row := s.pool.QueryRow(ctx, `
		SELECT `+pieceColumns+`
		FROM pieces p LEFT JOIN piece_pdfs f ON f.piece_id=p.id
		WHERE p.id=$1 AND p.user_id=$2`, id, userID)
	piece, err := scanPiece(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return Piece{}, ErrNotFound
	}
	return piece, err
}

func (s *Service) CreatePiece(ctx context.Context, userID string, input PieceInput) (Piece, error) {
	input, err := validatePiece(input)
	if err != nil {
		return Piece{}, err
	}
	var id string
	id = uuid.NewString()
	err = s.pool.QueryRow(ctx, `
		INSERT INTO pieces
			(id, user_id, title, composer, favorite, source_url, listening_url, notes)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
		id, userID, input.Title, input.Composer, input.Favorite, input.SourceURL,
		input.ListeningURL, input.Notes,
	).Scan(&id)
	if err != nil {
		return Piece{}, err
	}
	return s.GetPiece(ctx, userID, id)
}

func (s *Service) UpdatePiece(
	ctx context.Context,
	userID, id string,
	patch PiecePatch,
) (Piece, error) {
	current, err := s.GetPiece(ctx, userID, id)
	if err != nil {
		return Piece{}, err
	}
	input := PieceInput{
		Title: current.Title, Composer: current.Composer, Favorite: current.Favorite,
		SourceURL: current.SourceURL, ListeningURL: current.ListeningURL, Notes: current.Notes,
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
	if patch.SourceURL != nil {
		input.SourceURL = *patch.SourceURL
	}
	if patch.ListeningURL != nil {
		input.ListeningURL = *patch.ListeningURL
	}
	if patch.Notes != nil {
		input.Notes = *patch.Notes
	}
	input, err = validatePiece(input)
	if err != nil {
		return Piece{}, err
	}
	tag, err := s.pool.Exec(ctx, `
		UPDATE pieces SET title=$2, composer=$3, favorite=$4, source_url=$5,
			listening_url=$6, notes=$7, content_revision=content_revision+1, updated_at=now() WHERE id=$1 AND user_id=$8`,
		id, input.Title, input.Composer, input.Favorite, input.SourceURL,
		input.ListeningURL, input.Notes, userID)
	if err != nil {
		return Piece{}, err
	}
	if tag.RowsAffected() == 0 {
		return Piece{}, ErrNotFound
	}
	return s.GetPiece(ctx, userID, id)
}

func (s *Service) DeletePiece(ctx context.Context, userID, id string) error {
	tx, err := s.importTx(ctx, userID)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
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

func (s *Service) UploadPDF(
	ctx context.Context,
	userID, id, filename string,
	pageCount int,
	source io.Reader,
) (Piece, error) {
	if pageCount < 1 || pageCount > 10000 {
		return Piece{}, fmt.Errorf("page count must be between 1 and 10000")
	}
	data, err := io.ReadAll(io.LimitReader(source, s.importLimit()+1))
	if err != nil {
		return Piece{}, err
	}
	if int64(len(data)) > s.importLimit() {
		return Piece{}, ErrImportLimit
	}
	mime, actualCount, _, _, err := ValidateImportBytes(data)
	if err != nil {
		return Piece{}, err
	}
	if mime != "application/pdf" || actualCount != pageCount {
		return Piece{}, fmt.Errorf("PDF page count must match the actual file")
	}
	object, err := s.store.Save(ctx, bytes.NewReader(data))
	if err != nil {
		return Piece{}, err
	}
	cleanup := true
	defer func() {
		if cleanup {
			_ = s.store.Delete(ctx, object.Key)
		}
	}()
	tx, err := s.importTx(ctx, userID)
	if err != nil {
		return Piece{}, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, id); err != nil {
		return Piece{}, err
	}
	var exists bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM pieces WHERE id=$1 AND user_id=$2)`,
		id, userID).Scan(&exists); err != nil {
		return Piece{}, err
	}
	if !exists {
		return Piece{}, ErrNotFound
	}
	var oldKey string
	err = tx.QueryRow(ctx, `SELECT storage_key FROM piece_pdfs WHERE piece_id=$1`, id).Scan(&oldKey)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return Piece{}, err
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO piece_pdfs
			(piece_id, storage_key, original_filename, size_bytes, checksum_sha256, page_count)
		VALUES ($1,$2,$3,$4,$5,$6)
		ON CONFLICT (piece_id) DO UPDATE SET
			storage_key=excluded.storage_key,
			original_filename=excluded.original_filename,
			size_bytes=excluded.size_bytes,
			checksum_sha256=excluded.checksum_sha256,
			page_count=excluded.page_count,
			uploaded_at=now()`,
		id, object.Key, filename, object.Size, object.Checksum, pageCount)
	if err != nil {
		return Piece{}, err
	}
	if _, err = tx.Exec(ctx, `UPDATE pieces SET content_revision=content_revision+1,preparation_manifest=NULL WHERE id=$1`, id); err != nil {
		return Piece{}, err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM piece_sources WHERE piece_id=$1`, id); err != nil {
		return Piece{}, err
	}
	if err = collectOrphans(ctx, tx); err != nil {
		return Piece{}, err
	}
	if oldKey != "" {
		if err = queueKey(ctx, tx, oldKey); err != nil {
			return Piece{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Piece{}, err
	}
	cleanup = false
	return s.GetPiece(ctx, userID, id)
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
		SELECT r.piece_id, r.mode, r.last_page, r.scroll_position, r.zoom, r.scroll_speed,
			r.scroll_paused, r.updated_at
		FROM reader_states r
		JOIN pieces p ON p.id=r.piece_id
		WHERE r.piece_id=$1 AND p.user_id=$2`, id, userID,
	).Scan(&state.PieceID, &state.Mode, &state.LastPage, &state.ScrollPosition,
		&state.Zoom, &state.ScrollSpeed, &state.ScrollPaused, &state.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		var exists bool
		if scanErr := s.pool.QueryRow(ctx, `
			SELECT EXISTS (SELECT 1 FROM pieces WHERE id=$1 AND user_id=$2)`,
			id, userID).Scan(&exists); scanErr != nil {
			return ReaderState{}, scanErr
		}
		if !exists {
			return ReaderState{}, ErrNotFound
		}
		return ReaderState{
			PieceID: id, Mode: "page", LastPage: 1, Zoom: 1,
			ScrollSpeed: 32, ScrollPaused: true,
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
	var owned bool
	if err := s.pool.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM pieces WHERE id=$1 AND user_id=$2)`,
		id, userID).Scan(&owned); err != nil {
		return ReaderState{}, err
	}
	if !owned {
		return ReaderState{}, ErrNotFound
	}
	err := s.pool.QueryRow(ctx, `
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
	}
	return state, err
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
		&piece.ID, &piece.Title, &piece.Composer, &piece.Favorite,
		&piece.SourceURL, &piece.ListeningURL, &piece.Notes, &piece.CreatedAt, &piece.UpdatedAt,
		&filename, &size, &checksum, &pages, &uploaded,
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
