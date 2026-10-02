package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/bitofbytes-io/noted/internal/assets"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type failingSaveStore struct{ assets.Store }

func (failingSaveStore) Save(context.Context, io.Reader) (assets.Object, error) {
	return assets.Object{}, errors.New("disk full")
}

// TestIntegrationShortcutImport walks the Send to Noted decision tree against
// PostgreSQL, the local asset store and a fake Special:ReverseLookup.
func TestIntegrationShortcutImport(t *testing.T) {
	url := os.Getenv("NOTED_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("NOTED_TEST_DATABASE_URL is not set")
	}
	ctx, cancelTest := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancelTest()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	store, err := assets.NewLocalStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	lookups := map[string]int{}
	imslp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		number := strings.TrimPrefix(r.URL.Path, "/wiki/Special:ReverseLookup/")
		lookups[number]++
		switch number {
		case "1240":
			replyRedirect("//imslp.org/wiki/Clair_de_lune_(Debussy,_Claude)#IMSLP01240")(w, r)
		case "2733":
			replyRedirect(quasiValseLocation)(w, r)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer imslp.Close()
	s := NewService(pool, store)
	s.imslp = newIMSLPSearcher(IMSLPSearchConfig{WikiURL: imslp.URL + "/wiki/", Client: imslp.Client()})

	owner, other := uuid.NewString(), uuid.NewString()
	for i, id := range []string{owner, other} {
		if _, err = pool.Exec(ctx, `INSERT INTO users(id,email,display_name,auth_provider) VALUES($1,$2,'Shortcut tester','development')`, id, fmt.Sprintf("shortcut-%d-%s@example.test", i, id)); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id=ANY($1::uuid[])`, []string{owner, other})
	})
	pdf, err := os.ReadFile("../../testdata/fixtures/noted-exercise.pdf")
	if err != nil {
		t.Fatal(err)
	}
	jpeg, err := os.ReadFile("../../testdata/fixtures/noted-photo-exif-6.jpg")
	if err != nil {
		t.Fatal(err)
	}
	send := func(s *Service, filename string, body []byte) (ShortcutImport, error) {
		return s.ShortcutImport(ctx, owner, filename, strings.NewReader(string(body)))
	}
	openDrafts := func(user string) int {
		drafts, err := s.ListImports(ctx, user)
		if err != nil {
			t.Fatal(err)
		}
		return len(drafts)
	}
	const clair = "https://imslp.org/wiki/Clair_de_lune_(Debussy,_Claude)"
	// The plan's illustrative filename. On the real IMSLP, file 01240 is a Bach
	// cantata; the fake ReverseLookup above maps it to Clair de lune.
	const clairFile = "IMSLP01240-Debussy_-_Suite_bergamasque_-_3_Clair_de_lune.pdf"

	// Open drafts for the same work: the other user's, one of the owner's with
	// no file yet, and one that edits a saved piece. None of them is touched;
	// every shared PDF starts a new draft.
	if _, err = s.CreateImport(ctx, other, CreateImport{SourceURL: clair}); err != nil {
		t.Fatal(err)
	}
	existing, err := s.CreateImport(ctx, owner, CreateImport{SourceURL: clair})
	if err != nil {
		t.Fatal(err)
	}
	piece, err := s.CreatePiece(ctx, owner, PieceInput{Title: "Saved Clair de lune", SourceURL: clair})
	if err != nil {
		t.Fatal(err)
	}
	pieceDraft, err := s.CreateImport(ctx, owner, CreateImport{PieceID: piece.ID})
	if err != nil || pieceDraft.Metadata.SourceURL != clair {
		t.Fatalf("piece draft: %+v %v", pieceDraft.Metadata, err)
	}
	before := openDrafts(owner)

	title, composer := "Clair de lune", "Debussy, Claude"
	result, err := send(s, clairFile, pdf)
	if err != nil || result.DraftID == existing.ID || result.DraftID == pieceDraft.ID ||
		result.DraftPath != "/prepare/"+result.DraftID || result.Title != title || result.Composer != composer ||
		result.Filename != clairFile || result.Headline != "Clair de lune — Debussy, Claude" || result.Message != "New draft created." {
		t.Fatalf("IMSLP file: %+v %v", result, err)
	}
	created, err := s.GetImport(ctx, owner, result.DraftID)
	if err != nil || created.Metadata.SourceURL != clair || len(created.Sources) != 1 ||
		created.Sources[0].Filename != clairFile || created.Sources[0].MIME != "application/pdf" ||
		len(created.Manifest.Pages) != created.Sources[0].PageCount ||
		created.IMSLPAutoFill.Title == nil || *created.IMSLPAutoFill.Title != title ||
		created.IMSLPAutoFill.Composer == nil || *created.IMSLPAutoFill.Composer != composer {
		t.Fatalf("new draft from an IMSLP file: %+v %v", created, err)
	}
	// The stored object is the uploaded file, read back through the asset store.
	_, reader, err := s.ImportSource(ctx, owner, created.ID, created.Sources[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	stored, err := io.ReadAll(reader)
	reader.Close()
	if err != nil || string(stored) != string(pdf) {
		t.Fatalf("stored source differs from the upload: %d bytes, %v", len(stored), err)
	}

	// A second copy starts a second draft rather than filling the first.
	second, err := send(s, clairFile, pdf)
	if err != nil || second.DraftID == result.DraftID || second.DraftID == existing.ID || second.Title != title {
		t.Fatalf("second copy: %+v %v", second, err)
	}
	if got := openDrafts(owner); got != before+2 {
		t.Fatalf("open drafts = %d, want %d", got, before+2)
	}
	if lookups["1240"] != 1 {
		t.Fatalf("the cached file number was looked up %d times", lookups["1240"])
	}
	for _, want := range []ImportDraft{existing, pieceDraft} {
		d, err := s.GetImport(ctx, owner, want.ID)
		if err != nil || len(d.Sources) != 0 || d.Revision != want.Revision {
			t.Fatalf("an existing draft for the work changed: %+v %v", d, err)
		}
	}
	others, err := s.ListImports(ctx, other)
	if err != nil || len(others) != 1 || len(others[0].Manifest.Pages) != 0 {
		t.Fatalf("another user's draft changed: %+v %v", others, err)
	}

	// Another work: new draft with its link, title, composer and IMSLP provenance.
	result, err = send(s, "IMSLP02733-Scriabin_-_Quasi_valse.pdf", pdf)
	if err != nil || result.Title != quasiValse.Title || result.Composer != quasiValse.Composer ||
		result.Headline != "Quasi valse, Op.47 — Scriabin, Aleksandr" || result.Message != "New draft created." {
		t.Fatalf("new work: %+v %v", result, err)
	}
	created, err = s.GetImport(ctx, owner, result.DraftID)
	if err != nil || created.Metadata.SourceURL != quasiValse.URL || created.IMSLPAutoFill.Title == nil ||
		*created.IMSLPAutoFill.Title != quasiValse.Title || *created.IMSLPAutoFill.Composer != quasiValse.Composer {
		t.Fatalf("prefilled draft: %+v %v", created, err)
	}

	// No work (an unknown IMSLP number or any other PDF): titled from the
	// filename, with no link and no composer.
	for filename, want := range map[string]string{
		"IMSLP99999-Unknown_piece.pdf": "IMSLP99999-Unknown_piece",
		"Bach - Prelude in C.pdf":      "Bach - Prelude in C",
	} {
		result, err = send(s, filename, pdf)
		if err != nil || result.Title != want || result.Composer != "" || result.Headline != want || result.Message != "New draft created." {
			t.Fatalf("%s: %+v %v", filename, result, err)
		}
		created, err = s.GetImport(ctx, owner, result.DraftID)
		if err != nil || created.Metadata.SourceURL != "" || created.IMSLPAutoFill.Composer != nil || len(created.Sources) != 1 {
			t.Fatalf("%s draft: %+v %v", filename, created, err)
		}
	}

	before = openDrafts(owner)
	if _, err = send(s, "IMSLP02733-photo.pdf", jpeg); !errors.Is(err, ErrNotPDF) {
		t.Fatalf("image sent as a PDF: %v", err)
	}
	broken := NewService(pool, failingSaveStore{store})
	broken.imslp = s.imslp
	if _, err = send(broken, "Lost score.pdf", pdf); !errors.Is(err, ErrAssetStore) {
		t.Fatalf("asset store failure: %v", err)
	}
	if got := openDrafts(owner); got != before {
		t.Fatalf("a failed import left drafts behind: %d → %d", before, got)
	}

	// At 20 open drafts nothing new starts, even for a work with an open draft.
	if _, err = s.CreateImport(ctx, owner, CreateImport{SourceURL: quasiValse.URL}); err != nil {
		t.Fatal(err)
	}
	for openDrafts(owner) < 20 {
		if _, err = s.CreateImport(ctx, owner, CreateImport{}); err != nil {
			t.Fatal(err)
		}
	}
	for _, filename := range []string{"Bach - Invention.pdf", "IMSLP02733-Scriabin_-_Quasi_valse.pdf"} {
		if _, err = send(s, filename, pdf); !errors.Is(err, ErrDraftLimit) || !errors.Is(err, ErrImportLimit) {
			t.Fatalf("21st draft from %s: %v", filename, err)
		}
	}
	if got := openDrafts(owner); got != 20 {
		t.Fatalf("open drafts = %d, want 20", got)
	}
}
