package httptransport

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/bitofbytes-io/noted/internal/app"
	"github.com/bitofbytes-io/noted/internal/assets"
	"github.com/bitofbytes-io/noted/internal/auth"
	"github.com/bitofbytes-io/noted/internal/config"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/joho/godotenv"
)

const integrationXMLAssetID = "10000000-0000-4000-8000-000000000008"

func integrationHTTPRouter(t *testing.T) http.Handler {
	t.Helper()
	if os.Getenv("NOTED_INTEGRATION") != "1" {
		t.Skip("set NOTED_INTEGRATION=1 with a migrated and seeded PostgreSQL database")
	}
	_ = godotenv.Load("../../../.env")
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	pool, err := pgxpool.New(context.Background(), cfg.DatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	store, err := assets.NewFilesystemStore(cfg.AssetRoot)
	if err != nil {
		t.Fatal(err)
	}
	service := app.NewService(pool, store)
	authService := auth.NewService(pool, cfg.AllowedEmails, cfg.SessionTTL)
	return NewRouter(service, authService, cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func TestIntegrationAssetDownloadSupportsAttachmentAndRanges(t *testing.T) {
	router := integrationHTTPRouter(t)
	request := httptest.NewRequest(http.MethodGet, "/api/assets/"+integrationXMLAssetID+"/download", nil)
	request.Header.Set("Range", "bytes=0-3")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)

	if response.Code != http.StatusPartialContent {
		t.Fatalf("status = %d, want %d; body=%s", response.Code, http.StatusPartialContent, response.Body.String())
	}
	if got := response.Header().Get("Content-Disposition"); !strings.HasPrefix(got, "attachment;") || !strings.Contains(got, "noted-exercise.musicxml") {
		t.Fatalf("Content-Disposition = %q", got)
	}
	if got := response.Header().Get("Content-Type"); got != "application/vnd.recordare.musicxml+xml" {
		t.Fatalf("Content-Type = %q", got)
	}
	if response.Body.Len() != 4 {
		t.Fatalf("range response bytes = %d, want 4", response.Body.Len())
	}
}

func TestIntegrationAssetResponseIncludesDownloadAndValidation(t *testing.T) {
	router := integrationHTTPRouter(t)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/assets/"+integrationXMLAssetID, nil))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d; body=%s", response.Code, response.Body.String())
	}
	var asset app.Asset
	if err := json.NewDecoder(response.Body).Decode(&asset); err != nil {
		t.Fatal(err)
	}
	if asset.DownloadURL != "/api/assets/"+integrationXMLAssetID+"/download" || asset.PlaybackValidation.Status != "ready" {
		t.Fatalf("asset response = %+v", asset)
	}
}
