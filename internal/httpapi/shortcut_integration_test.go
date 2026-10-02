package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/bitofbytes-io/noted/internal/app"
	"github.com/bitofbytes-io/noted/internal/assets"
	"github.com/bitofbytes-io/noted/internal/auth"
	"github.com/bitofbytes-io/noted/internal/config"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// TestIntegrationShortcutImportEndToEnd sends a PDF through the real router,
// token store, import service and local asset store. IMSLP matching is covered
// in internal/app, so this file name has no IMSLP number.
func TestIntegrationShortcutImportEndToEnd(t *testing.T) {
	url := os.Getenv("NOTED_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("NOTED_TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	store, err := assets.NewLocalStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	email := "shortcut-e2e-" + uuid.NewString() + "@example.test"
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE email=$1`, email) })
	router := NewRouter(app.NewService(pool, store, 1<<20), auth.NewService(pool, nil, time.Hour), config.Config{
		AppEnv: "test", AuthMode: "development", DevUserEmail: email,
		MaxUploadBytes: 1 << 20, AllowedOrigin: testAllowedOrigin,
	})
	pdf, err := os.ReadFile("../../testdata/fixtures/noted-exercise.pdf")
	if err != nil {
		t.Fatal(err)
	}

	response := serve(router, httptest.NewRequest(http.MethodPost, "/api/account/shortcut-token", nil))
	var created struct {
		Token      string  `json:"token"`
		InstallURL *string `json:"installUrl"`
	}
	if response.Code != http.StatusCreated || json.Unmarshal(response.Body.Bytes(), &created) != nil ||
		len(created.Token) != 43 || created.InstallURL == nil || *created.InstallURL != "" {
		t.Fatalf("create token: %d %s", response.Code, response.Body.String())
	}

	response = serve(router, shortcutUpload(created.Token, "Prelude - Example.pdf", "application/pdf", string(pdf)))
	var result app.ShortcutImport
	if response.Code != http.StatusCreated || json.Unmarshal(response.Body.Bytes(), &result) != nil ||
		result.Matched || result.Title != "Prelude - Example" || result.DraftPath != "/prepare/"+result.DraftID {
		t.Fatalf("import: %d %s", response.Code, response.Body.String())
	}
	response = serve(router, httptest.NewRequest(http.MethodGet, "/api/imports/"+result.DraftID+"/", nil))
	var draft app.ImportDraft
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &draft) != nil ||
		len(draft.Sources) != 1 || draft.Sources[0].Size != int64(len(pdf)) || len(draft.Manifest.Pages) == 0 {
		t.Fatalf("draft after import: %d %s", response.Code, response.Body.String())
	}
	response = serve(router, httptest.NewRequest(http.MethodGet,
		"/api/imports/"+result.DraftID+"/sources/"+draft.Sources[0].ID, nil))
	if response.Code != http.StatusOK || response.Body.String() != string(pdf) {
		t.Fatalf("stored source: %d, %d bytes", response.Code, response.Body.Len())
	}

	var status auth.ShortcutTokenStatus
	response = serve(router, httptest.NewRequest(http.MethodGet, "/api/account/shortcut-token", nil))
	if json.Unmarshal(response.Body.Bytes(), &status) != nil || !status.Active || status.LastUsedAt == nil {
		t.Fatalf("token status after use: %s", response.Body.String())
	}

	if response = serve(router, shortcutUpload(created.Token, "notes.txt", "text/plain", "hello")); response.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("text file: %d %s", response.Code, response.Body.String())
	}
	if response = serve(router, shortcutUpload(created.Token, "fake.pdf", "application/pdf", "not a pdf")); response.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("non-PDF bytes: %d %s", response.Code, response.Body.String())
	}

	if response = serve(router, httptest.NewRequest(http.MethodDelete, "/api/account/shortcut-token", nil)); response.Code != http.StatusNoContent {
		t.Fatalf("turn off: %d", response.Code)
	}
	if response = serve(router, shortcutUpload(created.Token, "Prelude - Example.pdf", "application/pdf", string(pdf))); response.Code != http.StatusUnauthorized {
		t.Fatalf("turned-off token: %d %s", response.Code, response.Body.String())
	}
}
