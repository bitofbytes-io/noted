package omrreport

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
)

const (
	SchemaVersion = 1
	MaxBytes      = 1 << 20
	maxMeasures   = 10000
)

type Report struct {
	SchemaVersion     int                        `json:"schemaVersion"`
	TotalMeasures     int                        `json:"totalMeasures"`
	FlaggedMeasures   int                        `json:"flaggedMeasures"`
	CorrectedMeasures int                        `json:"correctedMeasures"`
	SuspectMeasures   int                        `json:"suspectMeasures"`
	SelectedEngine    string                     `json:"selectedEngine"`
	Engines           map[string]json.RawMessage `json:"engines"`
	Measures          []Measure                  `json:"measures"`
	Playability       Playability                `json:"playability"`
}

type Measure struct {
	PartID       string   `json:"partId"`
	Number       string   `json:"number"`
	MeasureIndex int      `json:"measureIndex"`
	SourceEngine string   `json:"sourceEngine"`
	Agreement    bool     `json:"agreement"`
	Confidence   string   `json:"confidence"`
	Corrected    bool     `json:"corrected"`
	Issues       []string `json:"issues"`
}

type Playability struct {
	Status       string `json:"status"`
	MeasureCount int    `json:"measureCount"`
	TotalTicks   int64  `json:"totalTicks,omitempty"`
}

func Decode(reader io.Reader) (Report, error) {
	data, err := io.ReadAll(io.LimitReader(reader, MaxBytes+1))
	if err != nil {
		return Report{}, fmt.Errorf("read OMR quality report: %w", err)
	}
	if len(data) == 0 {
		return Report{}, errors.New("OMR quality report is empty")
	}
	if len(data) > MaxBytes {
		return Report{}, fmt.Errorf("OMR quality report exceeds %d bytes", MaxBytes)
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var report Report
	if err := decoder.Decode(&report); err != nil {
		return Report{}, fmt.Errorf("decode OMR quality report: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return Report{}, errors.New("OMR quality report contains trailing data")
		}
		return Report{}, fmt.Errorf("decode trailing OMR quality report data: %w", err)
	}
	if err := report.Validate(); err != nil {
		return Report{}, err
	}
	return report, nil
}

func (r Report) Validate() error {
	if r.SchemaVersion != SchemaVersion {
		return fmt.Errorf("unsupported OMR quality report schema %d", r.SchemaVersion)
	}
	if r.TotalMeasures < 1 || r.TotalMeasures > maxMeasures {
		return errors.New("OMR quality report has an invalid total measure count")
	}
	for name, value := range map[string]int{
		"flagged":   r.FlaggedMeasures,
		"corrected": r.CorrectedMeasures,
		"suspect":   r.SuspectMeasures,
	} {
		if value < 0 || value > r.TotalMeasures {
			return fmt.Errorf("OMR quality report has an invalid %s measure count", name)
		}
	}
	if r.CorrectedMeasures > r.FlaggedMeasures {
		return errors.New("OMR quality report corrects more measures than it flagged")
	}
	if r.SelectedEngine != "fusion" && r.SelectedEngine != "audiveris" && r.SelectedEngine != "homr" {
		return errors.New("OMR quality report has an invalid selected engine")
	}
	if len(r.Engines) == 0 || len(r.Engines) > 8 {
		return errors.New("OMR quality report has an invalid engine summary")
	}
	for _, required := range []string{"audiveris", "homr"} {
		if _, exists := r.Engines[required]; !exists {
			return errors.New("OMR quality report is missing a required engine summary")
		}
	}
	for name, summary := range r.Engines {
		if strings.TrimSpace(name) == "" || len(name) > 100 || len(summary) == 0 || len(summary) > 64<<10 || summary[0] != '{' || !json.Valid(summary) {
			return errors.New("OMR quality report has an invalid engine summary")
		}
	}
	if len(r.Measures) == 0 || len(r.Measures) > maxMeasures*8 {
		return errors.New("OMR quality report has an invalid measure list")
	}
	seenMeasures := make(map[string]struct{}, len(r.Measures))
	seenMeasureIndexes := make(map[int]struct{}, r.TotalMeasures)
	flagged := make(map[int]struct{})
	corrected := make(map[int]struct{})
	suspect := make(map[int]struct{})
	for _, measure := range r.Measures {
		if measure.MeasureIndex < 1 || measure.MeasureIndex > r.TotalMeasures {
			return errors.New("OMR quality report has an invalid measure index")
		}
		if strings.TrimSpace(measure.PartID) == "" || len(measure.PartID) > 100 || strings.TrimSpace(measure.Number) == "" || len(measure.Number) > 100 || strings.TrimSpace(measure.SourceEngine) == "" || len(measure.SourceEngine) > 100 {
			return errors.New("OMR quality report has invalid measure metadata")
		}
		measureKey := measure.PartID + "\x00" + fmt.Sprint(measure.MeasureIndex)
		if _, exists := seenMeasures[measureKey]; exists {
			return errors.New("OMR quality report has duplicate part/measure rows")
		}
		seenMeasures[measureKey] = struct{}{}
		seenMeasureIndexes[measure.MeasureIndex] = struct{}{}
		if measure.SourceEngine != "audiveris" && measure.SourceEngine != "homr" {
			return errors.New("OMR quality report has an invalid measure source engine")
		}
		if measure.Confidence != "high" && measure.Confidence != "medium" && measure.Confidence != "low" {
			return errors.New("OMR quality report has an invalid confidence")
		}
		if len(measure.Issues) > 32 {
			return errors.New("OMR quality report has too many issues for a measure")
		}
		for _, issue := range measure.Issues {
			if strings.TrimSpace(issue) == "" || len(issue) > 200 {
				return errors.New("OMR quality report has an invalid measure issue")
			}
		}
		if measure.Confidence != "high" || measure.Corrected || len(measure.Issues) > 0 {
			flagged[measure.MeasureIndex] = struct{}{}
		}
		if measure.Corrected {
			corrected[measure.MeasureIndex] = struct{}{}
		}
		if measure.Confidence != "high" || len(measure.Issues) > 0 {
			suspect[measure.MeasureIndex] = struct{}{}
		}
	}
	if len(seenMeasureIndexes) != r.TotalMeasures {
		return errors.New("OMR quality report does not cover every final measure")
	}
	if len(flagged) != r.FlaggedMeasures || len(corrected) != r.CorrectedMeasures || len(suspect) != r.SuspectMeasures {
		return errors.New("OMR quality report summary counts do not match its measure rows")
	}
	if r.Playability.Status != "passed" || r.Playability.MeasureCount != r.TotalMeasures || r.Playability.TotalTicks <= 0 {
		return errors.New("OMR quality report has an invalid playability result")
	}
	return nil
}
