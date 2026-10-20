package app

import (
	"context"
	"errors"
	"fmt"
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
var ErrPDFChanged = errors.New("score PDF changed; reload before saving reader state")

type PDFSource struct {
	OriginalFilename string
	StorageKey       string
	UploadedAt       time.Time
}

type Service struct {
	pool           *pgxpool.Pool
	store          assets.Store
	maxUploadBytes int64
	imslp          *imslpSearcher
	shortcuts      *userLimiter
	exports        *exportLimiter
}

func NewService(pool *pgxpool.Pool, store assets.Store, limits ...int64) *Service {
	s := &Service{
		pool: pool, store: store, imslp: newIMSLPSearcher(IMSLPSearchConfig{}),
		shortcuts: newUserLimiter(10.0/60, 10, 10*time.Minute, time.Now),
		exports:   newExportLimiter(time.Now),
	}
	if len(limits) > 0 {
		s.maxUploadBytes = limits[0]
	}
	return s
}

// PingDatabase and CheckAssetStore back the API's readiness probe.
func (s *Service) PingDatabase(ctx context.Context) error {
	return s.pool.Ping(ctx)
}

func (s *Service) CheckAssetStore(ctx context.Context) error {
	return s.store.Check(ctx)
}

const pieceColumns = `
	p.id, p.title, p.composer, p.favorite, p.status, p.source_url, p.listening_url, p.notes,
	p.aliases, p.created_at, p.updated_at,
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
		args = append(args, "%"+likeEscape(token)+"%")
		clauses = append(clauses, fmt.Sprintf(`p.search_text LIKE $%d ESCAPE '\'`, len(args)))
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
				aliases, search_text, composer_sort, composer_sort_source, composer_sort_version)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$4,$13) RETURNING id`,
		id, userID, input.Title, input.Composer, input.Favorite, *input.Status, input.SourceURL,
		input.ListeningURL, input.Notes, input.Aliases, searchText(input), composerSortKey(input.Composer), composerKeyVersion,
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
		Notes: current.Notes, Aliases: current.Aliases,
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
			listening_url=$6, notes=$7, status=$9, aliases=$10, search_text=$11, composer_sort=$12, composer_sort_source=$3, composer_sort_version=$13, updated_at=now()
		WHERE id=$1 AND user_id=$8`,
		id, input.Title, input.Composer, input.Favorite, input.SourceURL,
		input.ListeningURL, input.Notes, userID, *input.Status, input.Aliases, searchText(input), composerSortKey(input.Composer), composerKeyVersion)
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

func (s *Service) GetPreferences(ctx context.Context, userID string) (Preferences, error) {
	var preferences Preferences
	err := s.pool.QueryRow(ctx, `SELECT library_filter, library_sort FROM users WHERE id=$1`, userID).
		Scan(&preferences.LibraryFilter, &preferences.LibrarySort)
	if errors.Is(err, pgx.ErrNoRows) {
		return Preferences{}, ErrNotFound
	}
	return preferences, err
}

// PutPreferences saves the preferences the patch sets and keeps the others.
func (s *Service) PutPreferences(
	ctx context.Context,
	userID string,
	patch PreferencesPatch,
) (Preferences, error) {
	if err := validatePreferences(patch); err != nil {
		return Preferences{}, err
	}
	var preferences Preferences
	err := s.pool.QueryRow(ctx, `
		UPDATE users SET
			library_filter=COALESCE($2, library_filter),
			library_sort=COALESCE($3, library_sort)
		WHERE id=$1 RETURNING library_filter, library_sort`,
		userID, patch.LibraryFilter, patch.LibrarySort,
	).Scan(&preferences.LibraryFilter, &preferences.LibrarySort)
	if errors.Is(err, pgx.ErrNoRows) {
		return Preferences{}, ErrNotFound
	}
	return preferences, err
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
		&piece.SourceURL, &piece.ListeningURL, &piece.Notes, &piece.Aliases, &piece.CreatedAt, &piece.UpdatedAt,
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
