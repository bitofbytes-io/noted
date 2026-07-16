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
	if err := validateRecognitionScore(path); err == nil || !strings.Contains(err.Error(), "no pitched notes") {
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
