package app

import (
	"fmt"
	"time"
)

var allowedStatuses = map[string]bool{
	"Interested": true, "Assigned": true, "Learning": true, "Playable": true,
	"Polished": true, "Memorized": true, "Paused": true, "Archived": true,
}

func ValidateStatus(status string) error {
	if !allowedStatuses[status] {
		return ValidationError{Fields: map[string]string{"status": "choose a supported learner status"}}
	}
	return nil
}

func ValidateMeasureRange(start, end, measureCount int) error {
	fields := map[string]string{}
	if start < 1 {
		fields["startMeasure"] = "must be at least 1"
	}
	if end < start {
		fields["endMeasure"] = "must not precede the start measure"
	}
	if end > measureCount {
		fields["endMeasure"] = fmt.Sprintf("must be at most %d", measureCount)
	}
	if len(fields) > 0 {
		return ValidationError{Fields: fields}
	}
	return nil
}

func ValidatePractice(duration int, startMeasure, endMeasure, startingBPM, endingBPM *int) error {
	fields := map[string]string{}
	if duration <= 0 || duration > 86400 {
		fields["durationSeconds"] = "must be between 1 and 86400"
	}
	if startMeasure != nil && *startMeasure < 1 {
		fields["startMeasure"] = "must be positive"
	}
	if endMeasure != nil && startMeasure == nil {
		fields["startMeasure"] = "is required with an end measure"
	}
	if startMeasure != nil && endMeasure != nil && *endMeasure < *startMeasure {
		fields["endMeasure"] = "must not precede start measure"
	}
	for name, bpm := range map[string]*int{"startingBpm": startingBPM, "endingBpm": endingBPM} {
		if bpm != nil && (*bpm < 30 || *bpm > 300) {
			fields[name] = "must be between 30 and 300"
		}
	}
	if len(fields) > 0 {
		return ValidationError{Fields: fields}
	}
	return nil
}

func MondayFor(t time.Time) time.Time {
	day := (int(t.Weekday()) + 6) % 7
	local := t.AddDate(0, 0, -day)
	return time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, local.Location())
}
