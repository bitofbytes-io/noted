package assets

import (
	"bytes"
	"fmt"
	"testing"
)

func TestValidateMusicXMLPlaybackSemantics(t *testing.T) {
	validMeasure := `<measure number="1"><attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>` +
		`<note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration></note>` +
		`<note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration></note>` +
		`<note><grace/><pitch><step>D</step><octave>4</octave></pitch></note>` +
		`<note><rest/><duration>4</duration></note><note><rest/><duration>4</duration></note><note><rest/><duration>4</duration></note></measure>`
	tests := []struct {
		name       string
		measures   string
		wantStatus string
		wantCode   string
	}{
		{name: "ready with chord grace and pickup", measures: validMeasure + `<measure number="2" implicit="yes"><note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration></note></measure>`, wantStatus: "ready"},
		{name: "measure number gap warns", measures: validMeasure + `<measure number="3"><note><pitch><step>D</step><octave>4</octave></pitch><duration>4</duration></note></measure>`, wantStatus: "needs_review", wantCode: "measure_number_gap"},
		{name: "duration overflow blocks", measures: `<measure number="1"><attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>` + fiveQuarterNotes() + `</measure>`, wantStatus: "blocked", wantCode: "measure_duration_overflow"},
		{name: "negative cursor blocks", measures: `<measure number="1"><attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes><backup><duration>4</duration></backup><note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration></note></measure>`, wantStatus: "blocked", wantCode: "cursor_before_measure"},
		{name: "invalid divisions block", measures: `<measure number="1"><attributes><divisions>0</divisions></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration></note></measure>`, wantStatus: "blocked", wantCode: "invalid_divisions"},
		{name: "no playable notes block", measures: `<measure number="1"><attributes><divisions>4</divisions></attributes><note><rest/><duration>4</duration></note></measure>`, wantStatus: "blocked", wantCode: "no_playable_notes"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			score := `<?xml version="1.0"?><score-partwise version="4.0"><part id="P1">` + test.measures + `</part></score-partwise>`
			validation, err := ValidateMusicXML(bytes.NewBufferString(score), "score.musicxml")
			if err != nil {
				t.Fatal(err)
			}
			if validation.Status != test.wantStatus {
				t.Fatalf("status = %q, want %q; issues=%+v", validation.Status, test.wantStatus, validation.Issues)
			}
			if test.wantCode != "" && !hasPlaybackIssue(validation, test.wantCode) {
				t.Fatalf("issues = %+v, want code %q", validation.Issues, test.wantCode)
			}
		})
	}
}

func TestValidateCompressedMusicXML(t *testing.T) {
	score := `<?xml version="1.0"?><score-partwise version="4.0"><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>1</beats><beat-type>4</beat-type></time></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration></note></measure></part></score-partwise>`
	contents := compressedMusicXML(t, map[string]string{
		"META-INF/container.xml": `<container><rootfiles><rootfile full-path="score.musicxml"/></rootfiles></container>`,
		"score.musicxml":         score,
	})
	validation, err := ValidateMusicXML(bytes.NewReader(contents), "score.mxl")
	if err != nil {
		t.Fatal(err)
	}
	if validation.Status != "ready" {
		t.Fatalf("validation = %+v, want ready", validation)
	}
}

func TestValidateMusicXMLRejectsMalformedDocument(t *testing.T) {
	validation, err := ValidateMusicXML(bytes.NewBufferString(`<score-partwise><part>`), "score.musicxml")
	if err != nil {
		t.Fatal(err)
	}
	if validation.Status != "blocked" || !hasPlaybackIssue(validation, "invalid_musicxml") {
		t.Fatalf("validation = %+v, want invalid_musicxml", validation)
	}
}

func fiveQuarterNotes() string {
	result := ""
	for index := 0; index < 5; index++ {
		result += fmt.Sprintf(`<note><pitch><step>C</step><octave>%d</octave></pitch><duration>4</duration></note>`, index+2)
	}
	return result
}

func hasPlaybackIssue(validation PlaybackValidation, code string) bool {
	for _, issue := range validation.Issues {
		if issue.Code == code {
			return true
		}
	}
	return false
}
