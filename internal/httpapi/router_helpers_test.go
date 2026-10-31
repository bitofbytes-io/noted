package httpapi

import (
	"bytes"
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/bitofbytes-io/noted/internal/app"
	"github.com/bitofbytes-io/noted/internal/assets"
	"github.com/bitofbytes-io/noted/internal/auth"
	"github.com/bitofbytes-io/noted/internal/config"
)

const testPieceID = "4f607127-fb97-4b22-90f5-1b9bec77b739"
const testUserID = "db53bb2a-b720-407a-8941-cd4459f69e79"
const testAllowedOrigin = "https://noted.example.test"

type fakeBackend struct {
	listQuery    string
	listFavorite *bool
	listUserID   string
	listStatuses []string
	listSort     string
	listCalls    int
	summaryCalls int
	summaries    []app.PieceSummary
	createInput  app.PieceInput
	createUserID string
	createErr    error
	patchInput   app.PiecePatch
	patchUserID  string
	patchPieceID string
	pdfFilename  string
	pdfBody      []byte
	pdfError     error
	pdfUserID    string
	pdfPieceID   string
	readerState  app.ReaderState
	readerError  error
	imslpQuery   string
	imslpUserID  string
	imslpErr     error

	preferencesPatch  app.PreferencesPatch
	preferencesUserID string
	preferencesErr    error

	continued      *app.Piece
	continueUserID string
}

func (fake *fakeBackend) ListPieces(_ context.Context, userID string, options app.ListOptions) ([]app.Piece, error) {
	fake.listUserID, fake.listQuery, fake.listFavorite = userID, options.Query, options.Favorite
	fake.listStatuses, fake.listSort = options.Statuses, options.Sort
	fake.listCalls++
	return []app.Piece{}, nil
}
func (fake *fakeBackend) ListPieceSummaries(_ context.Context, userID string, options app.ListOptions) ([]app.PieceSummary, error) {
	fake.listUserID, fake.listQuery, fake.listFavorite = userID, options.Query, options.Favorite
	fake.listStatuses, fake.listSort = options.Statuses, options.Sort
	fake.summaryCalls++
	if fake.summaries == nil {
		return []app.PieceSummary{}, nil
	}
	return fake.summaries, nil
}
func (fake *fakeBackend) ContinuePiece(_ context.Context, userID string) (*app.Piece, error) {
	fake.continueUserID = userID
	return fake.continued, nil
}
func (fake *fakeBackend) GetPreferences(_ context.Context, userID string) (app.Preferences, error) {
	fake.preferencesUserID = userID
	return app.Preferences{LibraryFilter: "current", LibrarySort: "title"}, nil
}
func (fake *fakeBackend) PutPreferences(_ context.Context, userID string, patch app.PreferencesPatch) (app.Preferences, error) {
	fake.preferencesUserID, fake.preferencesPatch = userID, patch
	preferences := app.Preferences{LibraryFilter: "current", LibrarySort: "title"}
	if patch.LibraryFilter != nil {
		preferences.LibraryFilter = *patch.LibraryFilter
	}
	if patch.LibrarySort != nil {
		preferences.LibrarySort = *patch.LibrarySort
	}
	return preferences, fake.preferencesErr
}
func (*fakeBackend) GetPiece(context.Context, string, string) (app.Piece, error) {
	return app.Piece{ID: testPieceID}, nil
}
func (fake *fakeBackend) CreatePiece(_ context.Context, userID string, input app.PieceInput) (app.Piece, error) {
	fake.createUserID, fake.createInput = userID, input
	return app.Piece{ID: testPieceID, ListeningURL: input.ListeningURL}, fake.createErr
}
func (fake *fakeBackend) UpdatePiece(_ context.Context, userID, pieceID string, patch app.PiecePatch) (app.Piece, error) {
	fake.patchUserID, fake.patchPieceID, fake.patchInput = userID, pieceID, patch
	piece := app.Piece{ID: testPieceID}
	if patch.ListeningURL != nil {
		piece.ListeningURL = *patch.ListeningURL
	}
	return piece, nil
}
func (*fakeBackend) DeletePiece(context.Context, string, string) error { return nil }
func (fake *fakeBackend) PDFSource(
	_ context.Context,
	userID, pieceID string,
) (app.PDFSource, assets.ReadSeekCloser, error) {
	fake.pdfUserID, fake.pdfPieceID = userID, pieceID
	if fake.pdfError != nil {
		return app.PDFSource{}, nil, fake.pdfError
	}
	filename := fake.pdfFilename
	if filename == "" {
		filename = "score.pdf"
	}
	body := fake.pdfBody
	if body == nil {
		body = []byte("0123456789")
	}
	reader := &seekReadCloser{Reader: bytes.NewReader(body)}
	return app.PDFSource{OriginalFilename: filename, UploadedAt: time.Unix(1, 0)}, reader, nil
}
func (*fakeBackend) GetReaderState(context.Context, string, string) (app.ReaderState, error) {
	return app.ReaderState{PieceID: testPieceID, PDFChecksumSHA256: strings.Repeat("a", 64), Mode: "page", LastPage: 1, Zoom: 1, ScrollSpeed: 5}, nil
}
func (fake *fakeBackend) PutReaderState(_ context.Context, _, _ string, state app.ReaderState) (app.ReaderState, error) {
	fake.readerState = state
	return state, fake.readerError
}
func (fake *fakeBackend) SearchIMSLP(_ context.Context, userID, query string) (app.IMSLPSearch, error) {
	fake.imslpUserID, fake.imslpQuery = userID, query
	if fake.imslpErr != nil {
		return app.IMSLPSearch{}, fake.imslpErr
	}
	return app.IMSLPSearch{Status: "ready", Results: []app.IMSLPWork{{Title: "Prelude", Composer: "Example, Ada", URL: "https://imslp.org/wiki/Prelude_(Example,_Ada)"}}}, nil
}

// fakeAuthenticator succeeds unless one of its error fields is set, and
// records what the OAuth callback passed it.
type fakeAuthenticator struct {
	ensureDevelopmentUserCalls int

	returnPath string // from ConsumeLoginState; "/" when empty
	consumeErr error
	authErr    error
	sessionErr error

	consumedState    string
	identity         *auth.GoogleIdentity
	sessionUserID    string
	sessionIP        string
	sessionExpiresAt time.Time
}

func (fake *fakeAuthenticator) EnsureDevelopmentUser(context.Context, string) (app.User, error) {
	fake.ensureDevelopmentUserCalls++
	return app.User{ID: testUserID, Email: "learner@noted.local", DisplayName: "Learner"}, nil
}
func (*fakeAuthenticator) NewLoginState(context.Context, string) (string, error) {
	return "state", nil
}
func (fake *fakeAuthenticator) ConsumeLoginState(_ context.Context, state string) (string, error) {
	fake.consumedState = state
	if fake.returnPath == "" {
		return "/", fake.consumeErr
	}
	return fake.returnPath, fake.consumeErr
}
func (fake *fakeAuthenticator) AuthenticateGoogle(_ context.Context, identity auth.GoogleIdentity) (app.User, error) {
	fake.identity = &identity
	return app.User{ID: testUserID}, fake.authErr
}
func (fake *fakeAuthenticator) NewSession(_ context.Context, userID, _, ip string) (string, time.Time, error) {
	fake.sessionUserID = userID
	fake.sessionIP = ip
	return "token", time.Now().Add(time.Hour), fake.sessionErr
}
func (fake *fakeAuthenticator) ResolveSession(context.Context, string) (app.User, time.Time, error) {
	expiresAt := fake.sessionExpiresAt
	if expiresAt.IsZero() {
		expiresAt = time.Now().Add(90 * 24 * time.Hour)
	}
	return app.User{ID: testUserID}, expiresAt, nil
}
func (*fakeAuthenticator) DeleteSession(context.Context, string) error { return nil }

func testRouter(backend Backend, maxUploadBytes int64) http.Handler {
	return NewRouter(backend, &fakeAuthenticator{}, config.Config{
		AppEnv: "test", AuthMode: "development", DevUserEmail: "learner@noted.local",
		MaxUploadBytes: maxUploadBytes, AllowedOrigin: testAllowedOrigin,
	}, nil)
}

type seekReadCloser struct{ *bytes.Reader }

func (*seekReadCloser) Close() error { return nil }
