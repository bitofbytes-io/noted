package omrreport

import (
	"strings"
	"testing"
)

const validReport = `{
  "schemaVersion": 1,
  "totalMeasures": 2,
  "flaggedMeasures": 1,
  "correctedMeasures": 1,
  "suspectMeasures": 1,
  "selectedEngine": "fusion",
  "engines": {"audiveris":{"status":"passed"},"homr":{"status":"passed"}},
  "measures": [
    {"partId":"P1","number":"1","measureIndex":1,"sourceEngine":"audiveris","agreement":true,"confidence":"high","corrected":false,"issues":[]},
    {"partId":"P1","number":"2","measureIndex":2,"sourceEngine":"homr","agreement":false,"confidence":"medium","corrected":true,"issues":["duration_repaired"]}
  ],
  "playability": {"status":"passed","measureCount":2,"totalTicks":7680}
}`

func TestDecodeValidReport(t *testing.T) {
	report, err := Decode(strings.NewReader(validReport))
	if err != nil {
		t.Fatal(err)
	}
	if report.TotalMeasures != 2 || report.CorrectedMeasures != 1 || report.Measures[1].MeasureIndex != 2 {
		t.Fatalf("decoded report = %+v", report)
	}
}

func TestDecodeRejectsInvalidOrOversizedReport(t *testing.T) {
	for name, input := range map[string]string{
		"unknown schema":  strings.Replace(validReport, `"schemaVersion": 1`, `"schemaVersion": 2`, 1),
		"bad confidence":  strings.Replace(validReport, `"confidence":"medium"`, `"confidence":"certain"`, 1),
		"bad playability": strings.Replace(validReport, `"status":"passed","measureCount":2`, `"status":"failed","measureCount":2`, 1),
		"unknown field":   strings.Replace(validReport, `"schemaVersion": 1`, `"schemaVersion": 1,"unexpected":true`, 1),
		"bad summary":     strings.Replace(validReport, `"suspectMeasures": 1`, `"suspectMeasures": 0`, 1),
		"missing measure": strings.NewReplacer(`"totalMeasures": 2`, `"totalMeasures": 3`, `"measureCount":2`, `"measureCount":3`).Replace(validReport),
		"unknown source":  strings.Replace(validReport, `"sourceEngine":"homr"`, `"sourceEngine":"unknown"`, 1),
		"missing engine":  strings.Replace(validReport, `"homr":{"status":"passed"}`, `"other":{"status":"passed"}`, 1),
		"duplicate row": strings.Replace(
			validReport,
			"\n  ],\n  \"playability\"",
			`,
    {"partId":"P1","number":"duplicate","measureIndex":1,"sourceEngine":"audiveris","agreement":true,"confidence":"high","corrected":false,"issues":[]}
  ],
  "playability"`,
			1,
		),
		"oversized": strings.Repeat("x", MaxBytes+1),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := Decode(strings.NewReader(input)); err == nil {
				t.Fatal("expected validation error")
			}
		})
	}
}
