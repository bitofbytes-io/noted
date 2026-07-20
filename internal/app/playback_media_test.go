package app

import "testing"

func TestNormalizeYouTubeVideoID(t *testing.T) {
	for _, test := range []struct {
		input MediaLinkInput
		want  string
	}{
		{input: MediaLinkInput{VideoID: "dQw4w9WgXcQ"}, want: "dQw4w9WgXcQ"},
		{input: MediaLinkInput{URL: "https://youtu.be/dQw4w9WgXcQ?t=42"}, want: "dQw4w9WgXcQ"},
		{input: MediaLinkInput{URL: "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}, want: "dQw4w9WgXcQ"},
		{input: MediaLinkInput{URL: "https://youtube.com/embed/dQw4w9WgXcQ"}, want: "dQw4w9WgXcQ"},
	} {
		got, err := normalizeYouTubeVideoID(test.input)
		if err != nil || got != test.want {
			t.Fatalf("normalize %+v = %q, %v", test.input, got, err)
		}
	}
	for _, invalid := range []string{"https://example.com/dQw4w9WgXcQ", "https://youtube.com/watch?v=short", "ftp://youtube.com/watch?v=dQw4w9WgXcQ", "javascript:alert(1)"} {
		if _, err := normalizeYouTubeVideoID(MediaLinkInput{URL: invalid}); err == nil {
			t.Fatalf("expected %q to be rejected", invalid)
		}
	}
}

func TestValidateAnchorsRejectsInvalidAndDuplicateMeasures(t *testing.T) {
	if err := validateAnchors([]AnchorInput{{MeasureNumber: 1, PositionMS: 0}, {MeasureNumber: 8, PositionMS: 42_000}}); err != nil {
		t.Fatal(err)
	}
	for _, anchors := range [][]AnchorInput{
		{{MeasureNumber: 0, PositionMS: 0}},
		{{MeasureNumber: 1, PositionMS: -1}},
		{{MeasureNumber: 1, PositionMS: 0}, {MeasureNumber: 1, PositionMS: 1000}},
	} {
		if err := validateAnchors(anchors); err == nil {
			t.Fatalf("expected anchors %+v to be rejected", anchors)
		}
	}
}

func TestValidateMeasureMapPages(t *testing.T) {
	valid := []MeasureMapPage{{
		PageNumber: 1, Width: 2550, Height: 3300, DPI: 300,
		Measures: []MeasureBox{{MeasureNumber: 1, X: 100, Y: 200, Width: 500, Height: 250}},
	}}
	if err := validateMeasureMapPages(valid); err != nil {
		t.Fatal(err)
	}
	invalid := valid
	invalid[0].Measures[0].Width = 3000
	if err := validateMeasureMapPages(invalid); err == nil {
		t.Fatal("expected out-of-page geometry to be rejected")
	}
}
