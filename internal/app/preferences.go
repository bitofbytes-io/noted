package app

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

type Preferences struct {
	WeekStartsOn         int    `json:"weekStartsOn"`
	MetronomeBPM         int    `json:"metronomeBpm"`
	MetronomeAccent      bool   `json:"metronomeAccent"`
	MetronomeBeatsPerBar int    `json:"metronomeBeatsPerBar"`
	MetronomeSound       string `json:"metronomeSound"`
}

func (s *Service) GetPreferences(ctx context.Context, userID string) (Preferences, error) {
	var value Preferences
	err := s.Pool.QueryRow(ctx, `SELECT week_starts_on,metronome_bpm,metronome_accent,metronome_beats_per_bar,metronome_sound FROM users WHERE id=$1`, userID).Scan(&value.WeekStartsOn, &value.MetronomeBPM, &value.MetronomeAccent, &value.MetronomeBeatsPerBar, &value.MetronomeSound)
	if errors.Is(err, pgx.ErrNoRows) {
		return Preferences{}, ErrNotFound
	}
	return value, err
}

func (s *Service) UpdatePreferences(ctx context.Context, userID string, value Preferences) (Preferences, error) {
	fields := map[string]string{}
	if value.WeekStartsOn != 1 {
		fields["weekStartsOn"] = "Monday (1) is the supported week start"
	}
	if value.MetronomeBPM < 30 || value.MetronomeBPM > 240 {
		fields["metronomeBpm"] = "must be between 30 and 240"
	}
	if value.MetronomeBeatsPerBar < 1 || value.MetronomeBeatsPerBar > 4 {
		fields["metronomeBeatsPerBar"] = "must be between 1 and 4"
	}
	if value.MetronomeSound != "classic" && value.MetronomeSound != "woodblock" && value.MetronomeSound != "soft_tick" {
		fields["metronomeSound"] = "must be classic, woodblock, or soft_tick"
	}
	if len(fields) > 0 {
		return Preferences{}, ValidationError{Fields: fields}
	}
	result, err := s.Pool.Exec(ctx, `UPDATE users SET week_starts_on=$2,metronome_bpm=$3,metronome_accent=$4,metronome_beats_per_bar=$5,metronome_sound=$6,updated_at=now() WHERE id=$1`, userID, value.WeekStartsOn, value.MetronomeBPM, value.MetronomeAccent, value.MetronomeBeatsPerBar, value.MetronomeSound)
	if err != nil {
		return Preferences{}, err
	}
	if result.RowsAffected() == 0 {
		return Preferences{}, ErrNotFound
	}
	return value, nil
}
