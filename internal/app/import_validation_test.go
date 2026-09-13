package app

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"testing"

	"github.com/bitofbytes-io/noted/internal/assets"
)

func TestImportRealFixtures(t *testing.T) {
	for _, test := range []struct {
		path, mime string
		pages      int
	}{{"noted-valid-ccitt.pdf", "application/pdf", 1}, {"noted-photo-exif-6.jpg", "image/jpeg", 1}, {"noted-photo-exif-8.jpg", "image/jpeg", 1}} {
		data, err := os.ReadFile("../../testdata/fixtures/" + test.path)
		if err != nil {
			t.Fatal(err)
		}
		mime, count, _, _, err := ValidateImportBytes(data)
		if err != nil || mime != test.mime || count != test.pages {
			t.Fatalf("%s: %s %d %v", test.path, mime, count, err)
		}
		if test.mime == "image/jpeg" {
			if _, _, _, _, err = ValidateImportBytes(data[:len(data)/2]); err == nil {
				t.Fatal("truncated photo accepted")
			}
		}
	}
}
func TestImportManifestValidation(t *testing.T) {
	source := ImportAsset{ID: "25c675db-6d18-4d36-b9e1-2810a859b199", MIME: "image/jpeg", PageCount: 1}
	base := PageEdit{ID: "d10a2d43-bde2-4249-b645-3f2e746c61ea", SourceID: source.ID, Page: 0}
	for _, mutate := range []func(*PageEdit){func(p *PageEdit) { p.Page = 1 }, func(p *PageEdit) { p.SourceID = "foreign" }, func(p *PageEdit) { p.Crop = []float64{.8, 0, .2, 1} }, func(p *PageEdit) { p.Corners = [][]float64{{0, 0}, {1, 1}, {1, 0}, {0, 1}} }, func(p *PageEdit) { p.Angle = 11 }, func(p *PageEdit) { p.OutputWidth = 612 }, func(p *PageEdit) { p.OutputWidth = 612; p.OutputHeight = 20000 }} {
		p := base
		mutate(&p)
		if err := validateManifest(EditManifest{Version: 1, Pages: []PageEdit{p}}, []ImportAsset{source}, false); err == nil {
			t.Fatalf("accepted %+v", p)
		}
	}
	if err := validateManifest(EditManifest{Version: 1, Pages: []PageEdit{base, base}}, []ImportAsset{source}, false); err == nil {
		t.Fatal("duplicate IDs accepted")
	}
}

// The wrapper lets the integration lifecycle test inject a filesystem deletion failure.
type failingDeleteStore struct {
	assets.Store
	failures int
}

func (s *failingDeleteStore) Delete(ctx context.Context, key string) error {
	if s.failures > 0 {
		s.failures--
		return errors.New("temporary filesystem failure")
	}
	return s.Store.Delete(ctx, key)
}
func TestBinaryAssetsRetainLegacyPDFKeys(t *testing.T) {
	store, err := assets.NewLocalStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	input := []byte("binary image bytes")
	object, err := store.Save(context.Background(), bytes.NewReader(input))
	if err != nil {
		t.Fatal(err)
	}
	reader, err := store.Open(context.Background(), object.Key)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	actual, err := io.ReadAll(reader)
	if err != nil || !bytes.Equal(actual, input) {
		t.Fatal("binary asset not preserved")
	}
}
