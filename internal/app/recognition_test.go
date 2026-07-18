package app

import (
	"archive/zip"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestValidateRecognitionScoreRejectsRestOnlyExport(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rests.musicxml")
	contents := `<score-partwise><part><measure><note><rest/></note></measure></part></score-partwise>`
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := validateRecognitionScore(path); err == nil || !strings.Contains(err.Error(), "no_playable_notes") {
		t.Fatalf("rest-only export validation = %v", err)
	}
}

func TestValidateRecognitionScoreAcceptsCompressedPitchedExport(t *testing.T) {
	path := filepath.Join(t.TempDir(), "score.mxl")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	archive := zip.NewWriter(file)
	container, err := archive.Create("META-INF/container.xml")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := container.Write([]byte(`<container><rootfiles><rootfile full-path="score.xml"/></rootfiles></container>`)); err != nil {
		t.Fatal(err)
	}
	entry, err := archive.Create("score.xml")
	if err != nil {
		t.Fatal(err)
	}
	contents := `<score-partwise><part><measure><note><pitch><step>C</step><octave>4</octave></pitch></note></measure></part></score-partwise>`
	if _, err := entry.Write([]byte(contents)); err != nil {
		t.Fatal(err)
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	if err := validateRecognitionScore(path); err != nil {
		t.Fatalf("pitched export validation = %v", err)
	}
}

func TestValidateRecognitionScoreRejectsOversizedRawExport(t *testing.T) {
	path := filepath.Join(t.TempDir(), "large.musicxml")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteString(`<score-partwise><part><measure><note><pitch/></note></measure></part></score-partwise>`); err != nil {
		t.Fatal(err)
	}
	if err := file.Truncate(maxRecognitionOutputBytes + 1); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	if err := validateRecognitionScore(path); err == nil || !strings.Contains(err.Error(), "too large") {
		t.Fatalf("oversized export validation = %v", err)
	}
}

func TestNormalizeRecognitionFailureCode(t *testing.T) {
	if got := normalizeRecognitionFailureCode(" unplayable_output "); got != "unplayable_output" {
		t.Fatalf("normalized failure code = %q", got)
	}
	for _, invalid := range []string{"", "contains-dash", strings.Repeat("x", 101)} {
		if got := normalizeRecognitionFailureCode(invalid); got != "recognition_failed" {
			t.Fatalf("invalid failure code %q normalized to %q", invalid, got)
		}
	}
}
