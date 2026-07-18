package assets

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"fmt"
	"io"
	"math/big"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

const maxPlaybackIssueMeasures = 20

type PlaybackIssue struct {
	Code     string   `json:"code"`
	Message  string   `json:"message"`
	Count    int      `json:"count"`
	Measures []string `json:"measures,omitempty"`
}

type PlaybackValidation struct {
	Status string          `json:"status"`
	Issues []PlaybackIssue `json:"issues"`
}

type playbackIssueDefinition struct {
	message string
	blocked bool
}

var playbackIssueDefinitions = map[string]playbackIssueDefinition{
	"invalid_musicxml": {
		message: "The score is not well-formed MusicXML.", blocked: true,
	},
	"unsupported_score_format": {
		message: "Timewise MusicXML is not supported for playback.", blocked: true,
	},
	"invalid_divisions": {
		message: "One or more notes use an invalid rhythmic divisions value.", blocked: true,
	},
	"cursor_before_measure": {
		message: "A backup moves before the start of its measure.", blocked: true,
	},
	"measure_duration_overflow": {
		message: "Rhythmic content extends beyond the expected measure duration.", blocked: true,
	},
	"measure_number_gap": {
		message: "The score has gaps in its numeric measure sequence.", blocked: false,
	},
	"no_playable_notes": {
		message: "The score does not contain playable notes.", blocked: true,
	},
}

type playbackIssueAccumulator struct {
	issues  map[string]*PlaybackIssue
	blocked bool
}

func newPlaybackIssueAccumulator() *playbackIssueAccumulator {
	return &playbackIssueAccumulator{issues: map[string]*PlaybackIssue{}}
}

func (a *playbackIssueAccumulator) add(code, measure string) {
	definition := playbackIssueDefinitions[code]
	issue := a.issues[code]
	if issue == nil {
		issue = &PlaybackIssue{Code: code, Message: definition.message}
		a.issues[code] = issue
	}
	issue.Count++
	if measure != "" && len(issue.Measures) < maxPlaybackIssueMeasures {
		for _, existing := range issue.Measures {
			if existing == measure {
				return
			}
		}
		issue.Measures = append(issue.Measures, measure)
	}
	if definition.blocked {
		a.blocked = true
	}
}

func (a *playbackIssueAccumulator) result() PlaybackValidation {
	issues := make([]PlaybackIssue, 0, len(a.issues))
	for _, issue := range a.issues {
		issues = append(issues, *issue)
	}
	sort.Slice(issues, func(i, j int) bool { return issues[i].Code < issues[j].Code })
	status := "ready"
	if a.blocked {
		status = "blocked"
	} else if len(issues) > 0 {
		status = "needs_review"
	}
	return PlaybackValidation{Status: status, Issues: issues}
}

// ValidateMusicXML checks both container integrity and playback-relevant MusicXML
// semantics. It deliberately reports musical inconsistencies instead of trying
// to repair them, because an automatic repair could change the score.
func ValidateMusicXML(reader io.Reader, filename string) (PlaybackValidation, error) {
	data, err := io.ReadAll(io.LimitReader(reader, maxCompressedMusicXMLBytes+1))
	if err != nil {
		return PlaybackValidation{}, fmt.Errorf("read MusicXML for validation: %w", err)
	}
	if len(data) > maxCompressedMusicXMLBytes {
		return PlaybackValidation{}, fmt.Errorf("MusicXML validation input exceeds %d bytes", maxCompressedMusicXMLBytes)
	}
	if strings.EqualFold(filepath.Ext(filename), ".mxl") || bytes.HasPrefix(data, []byte("PK")) {
		data, err = compressedScoreXML(data)
		if err != nil {
			return PlaybackValidation{}, err
		}
	}
	return validateScoreXML(data), nil
}

func compressedScoreXML(data []byte) ([]byte, error) {
	archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, fmt.Errorf("open compressed MusicXML for validation: %w", err)
	}
	var containerEntry *zip.File
	for _, entry := range archive.File {
		if entry.Name == "META-INF/container.xml" {
			containerEntry = entry
			break
		}
	}
	if containerEntry == nil {
		return nil, fmt.Errorf("compressed MusicXML is missing META-INF/container.xml")
	}
	containerData, err := readZipEntry(containerEntry, maxContainerXMLBytes)
	if err != nil {
		return nil, err
	}
	var container compressedMusicXMLContainer
	if err := xml.Unmarshal(containerData, &container); err != nil || len(container.Rootfiles) == 0 {
		return nil, fmt.Errorf("compressed MusicXML container has no valid rootfile")
	}
	rootPath := container.Rootfiles[0].FullPath
	for _, entry := range archive.File {
		if entry.Name == rootPath {
			return readZipEntry(entry, maxCompressedScoreBytes)
		}
	}
	return nil, fmt.Errorf("compressed MusicXML rootfile is missing")
}

type scoreTime struct {
	Beats       []string  `xml:"beats"`
	BeatTypes   []int     `xml:"beat-type"`
	SenzaMisura *struct{} `xml:"senza-misura"`
}

type scoreAttributes struct {
	Divisions *int        `xml:"divisions"`
	Times     []scoreTime `xml:"time"`
}

type scoreNote struct {
	Chord    *struct{} `xml:"chord"`
	Grace    *struct{} `xml:"grace"`
	Rest     *struct{} `xml:"rest"`
	Duration *int      `xml:"duration"`
}

type scoreDuration struct {
	Duration int `xml:"duration"`
}

type partPlaybackState struct {
	divisions int
	meter     *big.Rat
}

type measurePlaybackState struct {
	number string
	cursor *big.Rat
	max    *big.Rat
}

func validateScoreXML(data []byte) PlaybackValidation {
	issues := newPlaybackIssueAccumulator()
	decoder := xml.NewDecoder(bytes.NewReader(data))
	parts := map[string]*partPlaybackState{}
	var (
		rootSeen       bool
		currentPart    *partPlaybackState
		currentMeasure *measurePlaybackState
		partIndex      int
		previousNumber int
		playableNotes  int
	)

	for {
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			issues.add("invalid_musicxml", "")
			return issues.result()
		}
		switch value := token.(type) {
		case xml.StartElement:
			switch value.Name.Local {
			case "score-partwise":
				if !rootSeen {
					rootSeen = true
				}
			case "score-timewise":
				rootSeen = true
				issues.add("unsupported_score_format", "")
			case "part":
				partIndex++
				partID := attributeValue(value.Attr, "id")
				currentPart = parts[partID]
				if currentPart == nil {
					currentPart = &partPlaybackState{}
					parts[partID] = currentPart
				}
			case "measure":
				currentMeasure = &measurePlaybackState{
					number: attributeValue(value.Attr, "number"),
					cursor: new(big.Rat), max: new(big.Rat),
				}
				if partIndex == 1 {
					if number, parseErr := strconv.Atoi(strings.TrimSpace(currentMeasure.number)); parseErr == nil {
						if previousNumber > 0 && number > previousNumber+1 {
							for missing := previousNumber + 1; missing < number; missing++ {
								issues.add("measure_number_gap", strconv.Itoa(missing))
							}
						}
						previousNumber = number
					}
				}
			case "attributes":
				if currentPart == nil || currentMeasure == nil {
					continue
				}
				var attributes scoreAttributes
				if err := decoder.DecodeElement(&attributes, &value); err != nil {
					issues.add("invalid_musicxml", currentMeasure.number)
					return issues.result()
				}
				if attributes.Divisions != nil {
					currentPart.divisions = *attributes.Divisions
					if currentPart.divisions <= 0 {
						issues.add("invalid_divisions", currentMeasure.number)
					}
				}
				if len(attributes.Times) > 0 {
					currentPart.meter = meterDuration(attributes.Times)
				}
			case "note":
				if currentPart == nil || currentMeasure == nil {
					continue
				}
				var note scoreNote
				if err := decoder.DecodeElement(&note, &value); err != nil {
					issues.add("invalid_musicxml", currentMeasure.number)
					return issues.result()
				}
				if note.Rest == nil && note.Grace == nil {
					playableNotes++
				}
				if note.Chord == nil && note.Grace == nil && note.Duration != nil {
					advanceCursor(currentPart, currentMeasure, *note.Duration, false, issues)
				}
			case "backup", "forward":
				if currentPart == nil || currentMeasure == nil {
					continue
				}
				var duration scoreDuration
				if err := decoder.DecodeElement(&duration, &value); err != nil {
					issues.add("invalid_musicxml", currentMeasure.number)
					return issues.result()
				}
				advanceCursor(currentPart, currentMeasure, duration.Duration, value.Name.Local == "backup", issues)
			}
		case xml.EndElement:
			if value.Name.Local == "measure" && currentMeasure != nil && currentPart != nil {
				if currentPart.meter != nil && currentMeasure.max.Cmp(currentPart.meter) > 0 {
					issues.add("measure_duration_overflow", currentMeasure.number)
				}
				currentMeasure = nil
			}
		}
	}
	if !rootSeen {
		issues.add("invalid_musicxml", "")
	}
	if playableNotes == 0 {
		issues.add("no_playable_notes", "")
	}
	return issues.result()
}

func advanceCursor(part *partPlaybackState, measure *measurePlaybackState, duration int, backwards bool, issues *playbackIssueAccumulator) {
	if duration < 0 || part.divisions <= 0 {
		issues.add("invalid_divisions", measure.number)
		return
	}
	delta := new(big.Rat).SetFrac64(int64(duration), int64(part.divisions))
	if backwards {
		measure.cursor.Sub(measure.cursor, delta)
		if measure.cursor.Sign() < 0 {
			issues.add("cursor_before_measure", measure.number)
		}
		return
	}
	measure.cursor.Add(measure.cursor, delta)
	if measure.cursor.Cmp(measure.max) > 0 {
		measure.max.Set(measure.cursor)
	}
}

func meterDuration(times []scoreTime) *big.Rat {
	total := new(big.Rat)
	for _, time := range times {
		if time.SenzaMisura != nil {
			return nil
		}
		for index, beats := range time.Beats {
			if index >= len(time.BeatTypes) || time.BeatTypes[index] <= 0 {
				return nil
			}
			numerator := 0
			for _, component := range strings.Split(beats, "+") {
				value, err := strconv.Atoi(strings.TrimSpace(component))
				if err != nil || value <= 0 {
					return nil
				}
				numerator += value
			}
			total.Add(total, new(big.Rat).SetFrac64(int64(numerator*4), int64(time.BeatTypes[index])))
		}
	}
	if total.Sign() <= 0 {
		return nil
	}
	return total
}

func attributeValue(attributes []xml.Attr, name string) string {
	for _, attribute := range attributes {
		if attribute.Name.Local == name {
			return attribute.Value
		}
	}
	return ""
}
