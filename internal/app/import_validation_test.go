package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
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
	cleaned := base
	cleaned.PaperCleanup = true
	if err := validateManifest(EditManifest{Version: 1, Pages: []PageEdit{cleaned}}, []ImportAsset{source}, false); err != nil {
		t.Fatal(err)
	}
	pdfSource := source
	pdfSource.MIME = "application/pdf"
	if err := validateManifest(EditManifest{Version: 1, Pages: []PageEdit{cleaned}}, []ImportAsset{pdfSource}, false); err == nil {
		t.Fatal("PDF paper cleanup accepted")
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

// Each all-white Group 4 row is V(0), padded to the next byte. This original
// minimal fixture deliberately has decoding dimensions distinct from image size.
func TestCCITTDecodeParameters(t *testing.T) {
	for _, params := range []string{
		"/Columns 16 /Rows 2 /EncodedByteAlign true",
		"/Rows 2 /EncodedByteAlign true",             // PDF default Columns is 1728.
		"/Columns 16 /Rows 0 /EncodedByteAlign true", // unknown Rows uses image height.
	} {
		data := ccittTestPDF(params, []byte{0x80, 0x80, 0x00, 0x10, 0x01})
		if _, _, _, _, err := ValidateImportBytes(data); err != nil {
			t.Fatalf("%s: %v", params, err)
		}
	}
	// Horizontal mode: white run 0, black run 16; then two V(0) codes
	// repeat that black row. A decoder incorrectly using image Width 8 fails.
	blackRows := []byte{0x26, 0xa0, 0xb8, 0xc0, 0x00, 0x10, 0x01}
	if _, _, _, _, err := ValidateImportBytes(ccittTestPDF("/Columns 16 /Rows 2 /EncodedByteAlign true", blackRows)); err != nil {
		t.Fatalf("explicit decoding width: %v", err)
	}
	if _, _, _, _, err := ValidateImportBytes(ccittTestPDF("/Columns 8 /Rows 2 /EncodedByteAlign true", blackRows)); err == nil {
		t.Fatal("width regression fixture is not sensitive to Columns")
	}
	if _, _, _, _, err := ValidateImportBytes(ccittTestPDF("/Columns 16 /Rows 2 /EncodedByteAlign true", []byte{0x80})); err == nil {
		t.Fatal("truncated aligned stream accepted")
	}
	if _, _, _, _, err := ValidateImportBytes(ccittTestPDF("/Columns 16 /Rows 2 /EncodedByteAlign false", []byte{0x80, 0x80, 0x00, 0x10, 0x01})); err == nil {
		t.Fatal("alignment test would pass without honoring EncodedByteAlign")
	}
}

func ccittTestPDF(params string, raw []byte) []byte {
	content := "q 16 0 0 2 0 0 cm /Im0 Do Q"
	objects := []string{
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>",
		fmt.Sprintf("<< /Type /XObject /Subtype /Image /Width 8 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /CCITTFaxDecode /DecodeParms << /K -1 %s >> /Length %d >>\nstream\n%s\nendstream", params, len(raw), raw),
		fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", len(content), content),
	}
	var pdf bytes.Buffer
	pdf.WriteString("%PDF-1.4\n")
	offsets := []int{0}
	for i, object := range objects {
		offsets = append(offsets, pdf.Len())
		fmt.Fprintf(&pdf, "%d 0 obj\n%s\nendobj\n", i+1, object)
	}
	xref := pdf.Len()
	fmt.Fprintf(&pdf, "xref\n0 6\n0000000000 65535 f \n")
	for _, offset := range offsets[1:] {
		fmt.Fprintf(&pdf, "%010d 00000 n \n", offset)
	}
	fmt.Fprintf(&pdf, "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", xref)
	return pdf.Bytes()
}

func TestPreparationStrengthAndMarginValidation(t *testing.T) {
	source := ImportAsset{ID: "25c675db-6d18-4d36-b9e1-2810a859b199", MIME: "image/jpeg", PageCount: 1}
	base := PageEdit{ID: "d10a2d43-bde2-4249-b645-3f2e746c61ea", SourceID: source.ID, FitEdges: true}
	for _, strength := range []float64{-.01, 1.01, math.NaN(), math.Inf(1)} {
		p := base
		p.PaperCleanupStrength = &strength
		if validateManifest(EditManifest{Version: 1, Pages: []PageEdit{p}}, []ImportAsset{source}, false) == nil {
			t.Fatalf("accepted strength %v", strength)
		}
	}
	for _, margins := range [][]float64{{0, 0, 0}, {-1, 0, 0, 0}, {0, 143, 0, 0}, {0, 0, math.NaN(), 0}} {
		p := base
		p.Margins = margins
		if validateManifest(EditManifest{Version: 1, Pages: []PageEdit{p}}, []ImportAsset{source}, false) == nil {
			t.Fatalf("accepted margins %v", margins)
		}
	}
	zero := 0.
	base.PaperCleanup = true
	base.PaperCleanupStrength = &zero
	base.Margins = []float64{0, 72, 0, 0}
	if err := validateManifest(EditManifest{Version: 1, Pages: []PageEdit{base}}, []ImportAsset{source}, false); err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(base)
	if err != nil || !bytes.Contains(data, []byte(`"paperCleanupStrength":0`)) {
		t.Fatalf("zero override lost: %s %v", data, err)
	}
}
