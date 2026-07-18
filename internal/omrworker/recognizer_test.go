package omrworker

import (
	"archive/zip"
	"bytes"
	"context"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCommandRecognizerRunsBoundedAudiverisArguments(t *testing.T) {
	root := t.TempDir()
	pdfInfo := writeExecutable(t, root, "pdfinfo", "#!/bin/sh\nprintf 'Pages: 2\\n'\n")
	audiveris := writeExecutable(t, root, "audiveris", `#!/bin/sh
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-output" ]; then
    shift
    output=$1
  fi
  shift
done
printf '<score-partwise><part><measure><note><pitch><step>C</step></pitch></note></measure></part></score-partwise>' > "$output/score.musicxml"
`)
	input := filepath.Join(root, "unsafe name; touch escaped.pdf")
	if err := os.WriteFile(input, minimalPDF(), 0o600); err != nil {
		t.Fatal(err)
	}
	output := filepath.Join(root, "output")
	if err := os.Mkdir(output, 0o700); err != nil {
		t.Fatal(err)
	}
	recognizer := &CommandRecognizer{Command: audiveris, PDFInfoCommand: pdfInfo, Version: EngineVersion, MaxPages: DefaultMaxPages, MaxOutputBytes: DefaultMaxOutputBytes}
	result, err := recognizer.Recognize(context.Background(), input, output)
	if err != nil {
		t.Fatal(err)
	}
	if result.Extension != ".musicxml" {
		t.Fatalf("result = %+v", result)
	}
	if _, err := os.Stat(filepath.Join(root, "escaped.pdf")); !os.IsNotExist(err) {
		t.Fatal("input filename was interpreted by a shell")
	}
}

func TestValidateMusicXMLAcceptsRestOnlyScore(t *testing.T) {
	score := `<score-partwise><part><measure><note><rest/></note></measure></part></score-partwise>`
	if err := validateMusicXML(strings.NewReader(score), DefaultMaxOutputBytes); err != nil {
		t.Fatalf("rest-only score validation = %v", err)
	}
}

func TestReplaceEnvironmentIsolatesAudiverisState(t *testing.T) {
	current := []string{"HOME=/shared", "PATH=/bin", "XDG_CACHE_HOME=/shared/cache"}
	replaced := replaceEnvironment(current, map[string]string{"HOME": "/job/home", "XDG_CACHE_HOME": "/job/cache"})
	values := map[string]string{}
	for _, entry := range replaced {
		key, value, _ := strings.Cut(entry, "=")
		values[key] = value
	}
	if values["HOME"] != "/job/home" || values["XDG_CACHE_HOME"] != "/job/cache" || values["PATH"] != "/bin" {
		t.Fatalf("environment = %#v", values)
	}
	if len(values) != len(replaced) {
		t.Fatalf("environment contains duplicate keys: %#v", replaced)
	}
}

func TestValidateJobFootprintRejectsOversizedTemporaryData(t *testing.T) {
	path := filepath.Join(t.TempDir(), "oversized.tmp")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Truncate(maxJobBytes + 1); err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	err = validateJobFootprint(filepath.Dir(path))
	if codeForError(err, "") != "output_too_large" {
		t.Fatalf("error = %v", err)
	}
}

func TestCommandRecognizerRejectsPageLimitBeforeAudiveris(t *testing.T) {
	root := t.TempDir()
	pdfInfo := writeExecutable(t, root, "pdfinfo", "#!/bin/sh\nprintf 'Pages: 26\\n'\n")
	marker := filepath.Join(root, "audiveris-ran")
	audiveris := writeExecutable(t, root, "audiveris", "#!/bin/sh\ntouch \""+marker+"\"\n")
	input := filepath.Join(root, "score.pdf")
	if err := os.WriteFile(input, minimalPDF(), 0o600); err != nil {
		t.Fatal(err)
	}
	recognizer := &CommandRecognizer{Command: audiveris, PDFInfoCommand: pdfInfo, Version: EngineVersion, MaxPages: DefaultMaxPages, MaxOutputBytes: DefaultMaxOutputBytes}
	_, err := recognizer.Recognize(context.Background(), input, filepath.Join(root, "output"))
	if codeForError(err, "") != "too_many_pages" {
		t.Fatalf("error = %v", err)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("Audiveris ran for an over-limit PDF")
	}
}

func TestCommandRecognizerHonorsDeadline(t *testing.T) {
	root := t.TempDir()
	pdfInfo := writeExecutable(t, root, "pdfinfo", "#!/bin/sh\nprintf 'Pages: 1\\n'\n")
	audiveris := writeExecutable(t, root, "audiveris", "#!/bin/sh\nexec sleep 5\n")
	input := filepath.Join(root, "score.pdf")
	if err := os.WriteFile(input, minimalPDF(), 0o600); err != nil {
		t.Fatal(err)
	}
	recognizer := &CommandRecognizer{Command: audiveris, PDFInfoCommand: pdfInfo, Version: EngineVersion, MaxPages: DefaultMaxPages, MaxOutputBytes: DefaultMaxOutputBytes}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	_, err := recognizer.Recognize(ctx, input, filepath.Join(root, "output"))
	if codeForError(err, "") != "timeout" {
		t.Fatalf("error = %v", err)
	}
}

func TestFindAndValidateResultAcceptsPlainMusicXML(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "score.musicxml")
	if err := os.WriteFile(path, validMusicXML(), 0o600); err != nil {
		t.Fatal(err)
	}
	result, err := findAndValidateResult(root, DefaultMaxOutputBytes)
	if err != nil {
		t.Fatal(err)
	}
	if result.Path != path || result.Extension != ".musicxml" {
		t.Fatalf("result = %+v", result)
	}
}

func TestFindAndValidateResultAcceptsSafeMXL(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "score.mxl")
	var contents bytes.Buffer
	archive := zip.NewWriter(&contents)
	metadata, _ := archive.Create("META-INF/container.xml")
	_, _ = metadata.Write([]byte(`<container/>`))
	score, _ := archive.Create("score.xml")
	_, _ = score.Write(validMusicXML())
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, contents.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	result, err := findAndValidateResult(root, DefaultMaxOutputBytes)
	if err != nil {
		t.Fatal(err)
	}
	if result.Path != path || result.Extension != ".mxl" {
		t.Fatalf("result = %+v", result)
	}
}

func TestFindAndValidateProjectAcceptsAudiverisBook(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "score.omr")
	var contents bytes.Buffer
	archive := zip.NewWriter(&contents)
	book, _ := archive.Create("book.xml")
	_, _ = book.Write([]byte(`<book/>`))
	sheet, _ := archive.Create("sheet#1/sheet#1.xml")
	_, _ = sheet.Write([]byte(`<sheet/>`))
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, contents.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	project, err := findAndValidateProject(root)
	if err != nil {
		t.Fatal(err)
	}
	if project != path {
		t.Fatalf("project path = %q, want %q", project, path)
	}
}

func TestFindAndValidateResultChecksEntriesAfterValidMXLScore(t *testing.T) {
	for _, test := range []struct {
		name       string
		entryName  string
		entryValue []byte
		maxBytes   int64
		code       string
	}{
		{name: "later unsafe path", entryName: "../escape.xml", entryValue: []byte(`<ignored/>`), maxBytes: 4096, code: "invalid_output"},
		{name: "later backslash path", entryName: `..\escape.xml`, entryValue: []byte(`<ignored/>`), maxBytes: 4096, code: "invalid_output"},
		{name: "later drive path", entryName: `C:\escape.xml`, entryValue: []byte(`<ignored/>`), maxBytes: 4096, code: "invalid_output"},
		{name: "later expanded overflow", entryName: "large.bin", entryValue: bytes.Repeat([]byte("x"), 4096), maxBytes: 1024, code: "output_too_large"},
	} {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			path := filepath.Join(root, "score.mxl")
			var contents bytes.Buffer
			archive := zip.NewWriter(&contents)
			score, _ := archive.Create("score.xml")
			_, _ = score.Write(validMusicXML())
			later, _ := archive.Create(test.entryName)
			_, _ = later.Write(test.entryValue)
			if err := archive.Close(); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, contents.Bytes(), 0o600); err != nil {
				t.Fatal(err)
			}
			_, err := findAndValidateResult(root, test.maxBytes)
			if err == nil || codeForError(err, "") != test.code {
				t.Fatalf("error = %v, code = %q", err, codeForError(err, ""))
			}
		})
	}
}

func TestAddExpandedSizeRejectsOverflow(t *testing.T) {
	if _, err := addExpandedSize(math.MaxUint64-2, 4, math.MaxUint64); err == nil {
		t.Fatal("overflowing expanded size was accepted")
	}
}

func TestFindAndValidateResultRejectsInvalidAndOversizedOutput(t *testing.T) {
	for _, test := range []struct {
		name string
		data []byte
		max  int64
		code string
	}{
		{name: "invalid XML", data: []byte(`<not-a-score/>`), max: 1024, code: "invalid_output"},
		{name: "oversized", data: validMusicXML(), max: 8, code: "output_too_large"},
	} {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			if err := os.WriteFile(filepath.Join(root, "score.musicxml"), test.data, 0o600); err != nil {
				t.Fatal(err)
			}
			_, err := findAndValidateResult(root, test.max)
			if err == nil || codeForError(err, "") != test.code {
				t.Fatalf("error = %v, code = %q", err, codeForError(err, ""))
			}
		})
	}
}

func writeExecutable(t *testing.T, root, name, contents string) string {
	t.Helper()
	path := filepath.Join(root, name)
	if err := os.WriteFile(path, []byte(contents), 0o700); err != nil {
		t.Fatal(err)
	}
	return path
}
