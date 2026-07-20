package omrworker

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/bitofbytes-io/noted/internal/omrreport"
)

func TestRunRoutedEnginesUsesSecondaryOnlyAfterPrimaryFailure(t *testing.T) {
	for _, test := range []struct {
		name, sourceType, want string
		failPrimary            bool
	}{
		{name: "PDF success", sourceType: "pdf", want: "audiveris"},
		{name: "PDF fallback", sourceType: "pdf", want: "audiveris,homr", failPrimary: true},
		{name: "image success", sourceType: "image", want: "homr"},
		{name: "image fallback", sourceType: "image", want: "homr,audiveris", failPrimary: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			calls := []string{}
			audiveris := func() error {
				calls = append(calls, "audiveris")
				if test.failPrimary && test.sourceType != "image" {
					return errors.New("primary failed")
				}
				return nil
			}
			homr := func() error {
				calls = append(calls, "homr")
				if test.failPrimary && test.sourceType == "image" {
					return errors.New("primary failed")
				}
				return nil
			}
			runRoutedEngines(test.sourceType, audiveris, homr)
			if got := strings.Join(calls, ","); got != test.want {
				t.Fatalf("calls = %q, want %q", got, test.want)
			}
		})
	}
}

func TestShouldRetryImplicitTupletsRequiresStrictMajority(t *testing.T) {
	path := filepath.Join(t.TempDir(), "report.json")
	if err := os.WriteFile(path, []byte(`{"measureCount":8,"implicitTupletCandidates":[{"measureIndex":1},{"measureIndex":2},{"measureIndex":3},{"measureIndex":4},{"measureIndex":5}]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if !shouldRetryImplicitTuplets(path) {
		t.Fatal("expected a strict majority to trigger the retry")
	}
	if err := os.WriteFile(path, []byte(`{"measureCount":8,"implicitTupletCandidates":[{"measureIndex":1},{"measureIndex":2},{"measureIndex":3},{"measureIndex":4}]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if shouldRetryImplicitTuplets(path) {
		t.Fatal("half of measures must not trigger the retry")
	}
}

func TestPreprocessPagesUsesDeterministic300DPIRendering(t *testing.T) {
	root := t.TempDir()
	logPath := filepath.Join(root, "arguments.log")
	renderer := writeExecutable(t, root, "pdftoppm", `#!/bin/sh
printf '%s\n' "$*" >> "`+logPath+`"
prefix=""
for value in "$@"; do prefix=$value; done
printf '\211PNG\r\n\032\npage' > "${prefix}.png"
`)
	directory := filepath.Join(root, "prepared")
	if err := os.Mkdir(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	recognizer := &CommandRecognizer{PDFToPPMCommand: renderer, DPI: 300}
	pages, err := recognizer.preprocessPages(t.Context(), filepath.Join(root, "input.pdf"), directory, 2, os.Environ(), root)
	if err != nil {
		t.Fatal(err)
	}
	if len(pages) != 2 || filepath.Base(pages[0]) != "page-001.png" || filepath.Base(pages[1]) != "page-002.png" {
		t.Fatalf("rendered pages = %#v", pages)
	}
	arguments, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(arguments)), "\n")
	for index, line := range lines {
		wantPage := index + 1
		if !strings.Contains(line, "-f "+string(rune('0'+wantPage))+" -l "+string(rune('0'+wantPage))+" -r 300 -png -singlefile") {
			t.Fatalf("renderer arguments = %q", line)
		}
	}
}

func TestRunPipelineHomrProcessesPagesSequentiallyInCPUMode(t *testing.T) {
	root := t.TempDir()
	logPath := filepath.Join(root, "homr.log")
	homr := writeExecutable(t, root, "homr", `#!/bin/sh
printf '%s\n' "$*" >> "`+logPath+`"
image=""
for value in "$@"; do image=$value; done
output="${image%.*}.musicxml"
printf '%s\n' '<score-partwise><part><measure number="1"/></part></score-partwise>' > "$output"
`)
	pages := []string{filepath.Join(root, "page-001.png"), filepath.Join(root, "page-002.png")}
	for _, page := range pages {
		if err := os.WriteFile(page, []byte("image"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	recognizer := &CommandRecognizer{HomrCommand: homr}
	outputs, err := recognizer.runPipelineHomr(t.Context(), pages, os.Environ(), root, DefaultMaxOutputBytes)
	if err != nil {
		t.Fatal(err)
	}
	if len(outputs) != 2 || outputs[0] != strings.TrimSuffix(pages[0], ".png")+".musicxml" || outputs[1] != strings.TrimSuffix(pages[1], ".png")+".musicxml" {
		t.Fatalf("homr outputs = %#v", outputs)
	}
	logData, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	want := "--gpu no " + pages[0] + "\n--gpu no " + pages[1] + "\n"
	if string(logData) != want {
		t.Fatalf("homr invocations = %q, want %q", logData, want)
	}
}

func TestCompleteQualityReportAddsValidatedPlayability(t *testing.T) {
	root := t.TempDir()
	report := validQualityReport()
	report.Playability = omrreport.Playability{}
	draft, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	draftPath := filepath.Join(root, "draft.json")
	gatePath := filepath.Join(root, "gate.json")
	outputPath := filepath.Join(root, "report.json")
	if err := os.WriteFile(draftPath, draft, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(gatePath, []byte(`{"status":"passed","measureCount":1,"totalTicks":3840}`), 0o600); err != nil {
		t.Fatal(err)
	}
	completed, err := completeQualityReport(draftPath, gatePath, outputPath)
	if err != nil {
		t.Fatal(err)
	}
	if completed.Playability.Status != "passed" || completed.Playability.TotalTicks != 3840 {
		t.Fatalf("completed report = %+v", completed)
	}
}
