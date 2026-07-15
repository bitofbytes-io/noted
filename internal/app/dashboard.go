package app

import (
	"context"
	"time"
)

func (s *Service) GetDashboard(ctx context.Context, userID string, week time.Time) (Dashboard, error) {
	works, err := s.ListWorks(ctx, userID, WorkFilters{})
	if err != nil {
		return Dashboard{}, err
	}
	current := make([]WorkSummary, 0, 6)
	for _, work := range works {
		if work.Status != "Archived" && work.Status != "Paused" {
			current = append(current, work)
			if len(current) == 6 {
				break
			}
		}
	}
	recent, err := s.recentImports(ctx, userID)
	if err != nil {
		return Dashboard{}, err
	}
	summary, err := s.PracticeWeek(ctx, userID, week)
	if err != nil {
		return Dashboard{}, err
	}
	return Dashboard{CurrentWorks: current, RecentImports: recent, Week: summary}, nil
}

func (s *Service) recentImports(ctx context.Context, userID string) ([]Asset, error) {
	rows, err := s.Pool.Query(ctx, `
		SELECT a.id::text,a.edition_id::text,a.asset_type,a.original_filename,a.media_type,a.byte_size,a.sha256,COALESCE(a.source_url,''),a.rights_note,a.playback_capable,a.created_at
		FROM score_assets a JOIN editions e ON e.id=a.edition_id JOIN learner_works lw ON lw.work_id=e.work_id
		WHERE lw.user_id=$1 AND a.uploaded_by_user_id=$1 ORDER BY a.created_at DESC LIMIT 6`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []Asset{}
	for rows.Next() {
		var item Asset
		if err := rows.Scan(&item.ID, &item.EditionID, &item.AssetType, &item.OriginalFilename, &item.MediaType, &item.ByteSize, &item.SHA256, &item.SourceURL, &item.RightsNote, &item.PlaybackCapable, &item.CreatedAt); err != nil {
			return nil, err
		}
		item.ContentURL = "/api/assets/" + item.ID + "/content"
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Service) PracticeWeek(ctx context.Context, userID string, selected time.Time) (WeekSummary, error) {
	start := MondayFor(selected.UTC())
	end := start.AddDate(0, 0, 7)
	days := make([]WeekDay, 7)
	byDate := map[string]int{}
	for i := range days {
		date := start.AddDate(0, 0, i).Format("2006-01-02")
		days[i] = WeekDay{Date: date}
		byDate[date] = i
	}
	rows, err := s.Pool.Query(ctx, `
		SELECT (started_at AT TIME ZONE 'UTC')::date::text,sum(duration_seconds)::int,count(*)::int
		FROM practice_sessions WHERE user_id=$1 AND ended_at IS NOT NULL AND started_at >= $2 AND started_at < $3
		GROUP BY 1 ORDER BY 1`, userID, start, end)
	if err != nil {
		return WeekSummary{}, err
	}
	defer rows.Close()
	summary := WeekSummary{StartsOn: start.Format("2006-01-02"), Days: days}
	for rows.Next() {
		var date string
		var seconds, count int
		if err := rows.Scan(&date, &seconds, &count); err != nil {
			return WeekSummary{}, err
		}
		if index, ok := byDate[date]; ok {
			summary.Days[index].DurationSeconds = seconds
			summary.Days[index].SessionCount = count
		}
		summary.TotalSeconds += seconds
		summary.SessionCount += count
	}
	return summary, rows.Err()
}
