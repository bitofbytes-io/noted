package omrworker

import "testing"

func TestValidateWorkerMeasureMap(t *testing.T) {
	valid := MeasureMapResult{
		EngineVersion: "audiveris-5.10.2-measures",
		Pages: []MeasureMapPage{{
			PageNumber: 1, Width: 2550, Height: 3300, DPI: 300,
			Measures: []MeasureBox{{MeasureNumber: 1, X: 10, Y: 20, Width: 500, Height: 200}},
		}},
	}
	if err := validateWorkerMeasureMap(valid); err != nil {
		t.Fatal(err)
	}
	valid.Pages[0].Measures[0].Y = 3290
	if err := validateWorkerMeasureMap(valid); err == nil {
		t.Fatal("expected geometry outside the page to be rejected")
	}
}
