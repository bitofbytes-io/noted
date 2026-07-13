package app

import (
	"testing"
	"time"
)

func TestMeasureRangeValidation(t *testing.T) {
	for _, tc := range []struct{ start, end int }{{0, 4}, {5, 4}, {1, 17}} {
		if err := ValidateMeasureRange(tc.start, tc.end, 16); err == nil {
			t.Fatalf("expected %d-%d to fail", tc.start, tc.end)
		}
	}
	if err := ValidateMeasureRange(3, 8, 16); err != nil {
		t.Fatalf("expected valid range: %v", err)
	}
}

func TestMondayFor(t *testing.T) {
	location := time.FixedZone("test", -5*60*60)
	sunday := time.Date(2026, 7, 19, 12, 0, 0, 0, location)
	want := time.Date(2026, 7, 13, 0, 0, 0, 0, location)
	if got := MondayFor(sunday); !got.Equal(want) {
		t.Fatalf("MondayFor() = %v, want %v", got, want)
	}
}

func TestPracticeValidation(t *testing.T) {
	start, end, low := 8, 4, 20
	if err := ValidatePractice(60, &start, &end, &low, nil); err == nil {
		t.Fatal("expected invalid measures and BPM to fail")
	}
	end = 12
	bpm := 96
	if err := ValidatePractice(900, &start, &end, &bpm, &bpm); err != nil {
		t.Fatalf("expected valid practice record: %v", err)
	}
}
