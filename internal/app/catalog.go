package app

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"github.com/jackc/pgx/v5"
)

type WorkFilters struct {
	Query    string
	Status   string
	Favorite *bool
	Tag      string
}

type CreateWorkInput struct {
	Title         string `json:"title"`
	Composer      string `json:"composer"`
	CatalogNumber string `json:"catalogNumber"`
	KeySignature  string `json:"keySignature"`
	Period        string `json:"period"`
	EditionName   string `json:"editionName"`
	SourceURL     string `json:"sourceUrl"`
	RightsNote    string `json:"rightsNote"`
}

func (s *Service) ListWorks(ctx context.Context, userID string, filters WorkFilters) ([]WorkSummary, error) {
	if filters.Status != "" {
		if err := ValidateStatus(filters.Status); err != nil {
			return nil, err
		}
	}
	rows, err := s.Pool.Query(ctx, `
		SELECT w.id::text, w.title, c.canonical_name, lw.status, lw.is_favorite,
		       COALESCE(ARRAY(SELECT t.name FROM learner_work_tags lwt JOIN tags t ON t.id=lwt.tag_id WHERE lwt.learner_work_id=lw.id ORDER BY t.name), ARRAY[]::text[]),
		       (SELECT max(ps.started_at) FROM practice_sessions ps WHERE ps.user_id=lw.user_id AND ps.work_id=w.id AND ps.ended_at IS NOT NULL),
		       lw.last_bpm,
		       EXISTS(SELECT 1 FROM editions e JOIN score_assets a ON a.edition_id=e.id WHERE e.work_id=w.id AND e.archived_at IS NULL AND a.archived_at IS NULL AND a.uploaded_by_user_id=lw.user_id AND a.asset_type='pdf'),
		       EXISTS(SELECT 1 FROM editions e JOIN score_assets a ON a.edition_id=e.id WHERE e.work_id=w.id AND e.archived_at IS NULL AND a.archived_at IS NULL AND a.uploaded_by_user_id=lw.user_id AND a.playback_capable),
		       lw.updated_at
		FROM learner_works lw
		JOIN works w ON w.id=lw.work_id
		JOIN composers c ON c.id=w.composer_id
		WHERE lw.user_id=$1
		  AND ($3='Archived' OR lw.status<>'Archived')
		  AND ($2='' OR w.title ILIKE '%%' || $2 || '%%' OR c.canonical_name ILIKE '%%' || $2 || '%%')
		  AND ($3='' OR lw.status=$3)
		  AND ($4::boolean IS NULL OR lw.is_favorite=$4)
		  AND ($5='' OR EXISTS(SELECT 1 FROM learner_work_tags lwt JOIN tags t ON t.id=lwt.tag_id WHERE lwt.learner_work_id=lw.id AND t.normalized_name=lower($5)))
		ORDER BY CASE lw.status WHEN 'Learning' THEN 0 WHEN 'Assigned' THEN 1 WHEN 'Playable' THEN 2 ELSE 3 END, lw.updated_at DESC, w.title`,
		userID, strings.TrimSpace(filters.Query), filters.Status, filters.Favorite, strings.TrimSpace(filters.Tag))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	works := []WorkSummary{}
	for rows.Next() {
		var item WorkSummary
		if err := rows.Scan(&item.ID, &item.Title, &item.Composer, &item.Status, &item.IsFavorite, &item.Tags, &item.LastPracticed, &item.LastBPM, &item.HasPDF, &item.HasPlayback, &item.UpdatedAt); err != nil {
			return nil, err
		}
		works = append(works, item)
	}
	return works, rows.Err()
}

func (s *Service) CreateWork(ctx context.Context, userID string, input CreateWorkInput) (WorkDetail, error) {
	input.Title = strings.TrimSpace(input.Title)
	input.Composer = strings.TrimSpace(input.Composer)
	if input.EditionName == "" {
		input.EditionName = "Personal edition"
	}
	fields := map[string]string{}
	if input.Title == "" {
		fields["title"] = "is required"
	}
	if input.Composer == "" {
		fields["composer"] = "is required"
	}
	if len(fields) > 0 {
		return WorkDetail{}, ValidationError{Fields: fields}
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return WorkDetail{}, err
	}
	defer tx.Rollback(ctx)
	var composerID string
	err = tx.QueryRow(ctx, `SELECT id::text FROM composers WHERE lower(canonical_name)=lower($1) LIMIT 1`, input.Composer).Scan(&composerID)
	if errors.Is(err, pgx.ErrNoRows) {
		err = tx.QueryRow(ctx, `INSERT INTO composers(canonical_name, sort_name) VALUES($1,$1) RETURNING id::text`, input.Composer).Scan(&composerID)
	}
	if err != nil {
		return WorkDetail{}, err
	}
	var workID string
	err = tx.QueryRow(ctx, `
		SELECT id::text FROM works
		WHERE composer_id=$1 AND title=$2 AND catalog_number IS NOT DISTINCT FROM NULLIF($3,'')
		LIMIT 1`, composerID, input.Title, input.CatalogNumber).Scan(&workID)
	if errors.Is(err, pgx.ErrNoRows) {
		err = tx.QueryRow(ctx, `
			INSERT INTO works(composer_id,title,catalog_number,key_signature,period,created_by_user_id)
			VALUES($1,$2,NULLIF($3,''),NULLIF($4,''),NULLIF($5,''),$6)
			ON CONFLICT(composer_id,title,catalog_number) DO UPDATE SET title=EXCLUDED.title
			RETURNING id::text`, composerID, input.Title, input.CatalogNumber, input.KeySignature, input.Period, userID).Scan(&workID)
	}
	if err != nil {
		return WorkDetail{}, fmt.Errorf("create work: %w", err)
	}
	result, err := tx.Exec(ctx, `INSERT INTO learner_works(user_id,work_id,status) VALUES($1,$2,'Interested') ON CONFLICT(user_id,work_id) DO NOTHING`, userID, workID)
	if err != nil {
		return WorkDetail{}, err
	}
	if result.RowsAffected() == 0 {
		return WorkDetail{}, ValidationError{Fields: map[string]string{"title": "is already in your library"}}
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO editions(work_id,name,source_url,rights_note,created_by_user_id)
		VALUES($1,$2,NULLIF($3,''),NULLIF($4,''),$5)`, workID, input.EditionName, input.SourceURL, input.RightsNote, userID); err != nil {
		return WorkDetail{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return WorkDetail{}, err
	}
	return s.GetWork(ctx, userID, workID)
}

type WorkPatchInput struct {
	Title                    string `json:"title"`
	Subtitle                 string `json:"subtitle"`
	Composer                 string `json:"composer"`
	CatalogNumber            string `json:"catalogNumber"`
	KeySignature             string `json:"keySignature"`
	Period                   string `json:"period"`
	PublishedDifficultyLabel string `json:"publishedDifficultyLabel"`
	Notes                    string `json:"notes"`
}

func (s *Service) UpdateWork(ctx context.Context, userID, workID string, input WorkPatchInput) (WorkDetail, error) {
	if err := validateResourceID(workID); err != nil {
		return WorkDetail{}, err
	}
	input.Title = strings.TrimSpace(input.Title)
	input.Composer = strings.TrimSpace(input.Composer)
	fields := map[string]string{}
	if input.Title == "" {
		fields["title"] = "is required"
	}
	if input.Composer == "" {
		fields["composer"] = "is required"
	}
	if len(fields) > 0 {
		return WorkDetail{}, ValidationError{Fields: fields}
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return WorkDetail{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck -- a committed transaction makes rollback a no-op
	var composerID string
	err = tx.QueryRow(ctx, `SELECT id::text FROM composers WHERE lower(canonical_name)=lower($1) ORDER BY created_at LIMIT 1`, input.Composer).Scan(&composerID)
	if errors.Is(err, pgx.ErrNoRows) {
		err = tx.QueryRow(ctx, `INSERT INTO composers(canonical_name,sort_name) VALUES($1,$1) RETURNING id::text`, input.Composer).Scan(&composerID)
	}
	if err != nil {
		return WorkDetail{}, err
	}
	result, err := tx.Exec(ctx, `
		UPDATE works SET composer_id=$3,title=$4,subtitle=NULLIF($5,''),catalog_number=NULLIF($6,''),key_signature=NULLIF($7,''),period=NULLIF($8,''),published_difficulty_label=NULLIF($9,''),notes=NULLIF($10,''),updated_at=now()
		WHERE id=$2 AND created_by_user_id=$1`, userID, workID, composerID, input.Title, strings.TrimSpace(input.Subtitle), strings.TrimSpace(input.CatalogNumber), strings.TrimSpace(input.KeySignature), strings.TrimSpace(input.Period), strings.TrimSpace(input.PublishedDifficultyLabel), strings.TrimSpace(input.Notes))
	if err != nil {
		return WorkDetail{}, err
	}
	if result.RowsAffected() == 0 {
		return WorkDetail{}, ErrNotFound
	}
	if err := tx.Commit(ctx); err != nil {
		return WorkDetail{}, err
	}
	return s.GetWork(ctx, userID, workID)
}

func (s *Service) DeleteWork(ctx context.Context, userID, workID string) error {
	if err := validateResourceID(workID); err != nil {
		return err
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck -- a committed transaction makes rollback a no-op
	var owned, referenced, shared bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS(SELECT 1 FROM works w JOIN learner_works lw ON lw.work_id=w.id WHERE w.id=$2 AND w.created_by_user_id=$1 AND lw.user_id=$1),
		       EXISTS(SELECT 1 FROM practice_sessions WHERE work_id=$2),
		       EXISTS(SELECT 1 FROM learner_works WHERE work_id=$2 AND user_id<>$1)
		       OR EXISTS(SELECT 1 FROM editions WHERE work_id=$2 AND created_by_user_id<>$1)
		       OR EXISTS(SELECT 1 FROM score_assets a JOIN editions e ON e.id=a.edition_id WHERE e.work_id=$2 AND a.uploaded_by_user_id<>$1)`, userID, workID).Scan(&owned, &referenced, &shared); err != nil {
		return err
	}
	if !owned {
		return ErrNotFound
	}
	if referenced || shared {
		return ErrWorkInUse
	}
	rows, err := tx.Query(ctx, `SELECT a.storage_key FROM score_assets a JOIN editions e ON e.id=a.edition_id WHERE e.work_id=$1`, workID)
	if err != nil {
		return err
	}
	keys := []string{}
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			rows.Close()
			return err
		}
		keys = append(keys, key)
	}
	rows.Close()
	if _, err := tx.Exec(ctx, `DELETE FROM works WHERE id=$1 AND created_by_user_id=$2`, workID, userID); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	for _, key := range keys {
		if err := s.Store.Delete(context.Background(), key); err != nil {
			slog.Error("work metadata deleted but storage cleanup failed", "work_id", workID, "storage_key", key, "error", err)
		}
	}
	return nil
}

func (s *Service) GetWork(ctx context.Context, userID, workID string) (WorkDetail, error) {
	if err := validateResourceID(workID); err != nil {
		return WorkDetail{}, ErrNotFound
	}
	var work WorkDetail
	err := s.Pool.QueryRow(ctx, `
		SELECT w.id::text,w.title,COALESCE(w.subtitle,''),c.canonical_name,COALESCE(w.catalog_number,''),COALESCE(w.key_signature,''),COALESCE(w.period,''),
		       COALESCE(w.published_difficulty_label,''),COALESCE(w.notes,''),lw.status,lw.is_favorite,COALESCE(lw.personal_difficulty,''),COALESCE(lw.personal_notes,''),lw.last_bpm,
		       COALESCE(ARRAY(SELECT t.name FROM learner_work_tags lwt JOIN tags t ON t.id=lwt.tag_id WHERE lwt.learner_work_id=lw.id ORDER BY t.name),ARRAY[]::text[]),
		       COALESCE((SELECT sum(duration_seconds) FROM practice_sessions ps WHERE ps.user_id=$1 AND ps.work_id=w.id AND ps.ended_at IS NOT NULL),0)::int,
		       (SELECT count(*) FROM practice_sessions ps WHERE ps.user_id=$1 AND ps.work_id=w.id AND ps.ended_at IS NOT NULL)::int
		FROM learner_works lw JOIN works w ON w.id=lw.work_id JOIN composers c ON c.id=w.composer_id
		WHERE lw.user_id=$1 AND w.id=$2`, userID, workID).Scan(
		&work.ID, &work.Title, &work.Subtitle, &work.Composer, &work.CatalogNumber, &work.KeySignature, &work.Period,
		&work.PublishedDifficultyLabel, &work.Notes, &work.LearnerState.Status, &work.LearnerState.IsFavorite,
		&work.LearnerState.PersonalDifficulty, &work.LearnerState.PersonalNotes, &work.LearnerState.LastBPM, &work.LearnerState.Tags,
		&work.PracticeSummary.TotalSeconds, &work.PracticeSummary.SessionCount)
	if errors.Is(err, pgx.ErrNoRows) {
		return WorkDetail{}, ErrNotFound
	}
	if err != nil {
		return WorkDetail{}, err
	}
	work.Movements, err = s.listMovements(ctx, workID)
	if err != nil {
		return WorkDetail{}, err
	}
	work.Editions, err = s.listEditions(ctx, userID, workID)
	return work, err
}

func (s *Service) listMovements(ctx context.Context, workID string) ([]Movement, error) {
	rows, err := s.Pool.Query(ctx, `SELECT id::text,sequence_number,title,COALESCE(tempo_marking,''),measure_count FROM movements WHERE work_id=$1 ORDER BY sequence_number`, workID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []Movement{}
	for rows.Next() {
		var item Movement
		if err := rows.Scan(&item.ID, &item.SequenceNumber, &item.Title, &item.TempoMarking, &item.MeasureCount); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Service) listEditions(ctx context.Context, userID, workID string) ([]Edition, error) {
	rows, err := s.Pool.Query(ctx, `SELECT id::text,name,COALESCE(editor,''),COALESCE(publisher,''),publication_year,COALESCE(source_url,''),COALESCE(rights_note,''),archived_at FROM editions WHERE work_id=$1 ORDER BY archived_at NULLS FIRST,created_at`, workID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []Edition{}
	for rows.Next() {
		var item Edition
		if err := rows.Scan(&item.ID, &item.Name, &item.Editor, &item.Publisher, &item.PublicationYear, &item.SourceURL, &item.RightsNote, &item.ArchivedAt); err != nil {
			return nil, err
		}
		item.Assets, err = s.ListEditionAssets(ctx, userID, item.ID)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

type LearnerStateInput struct {
	Status             string `json:"status"`
	IsFavorite         bool   `json:"isFavorite"`
	PersonalDifficulty string `json:"personalDifficulty"`
	PersonalNotes      string `json:"personalNotes"`
	LastBPM            *int   `json:"lastBpm"`
}

func (s *Service) UpdateLearnerState(ctx context.Context, userID, workID string, input LearnerStateInput) (WorkDetail, error) {
	if err := validateResourceID(workID); err != nil {
		return WorkDetail{}, err
	}
	if err := ValidateStatus(input.Status); err != nil {
		return WorkDetail{}, err
	}
	if input.LastBPM != nil && (*input.LastBPM < 30 || *input.LastBPM > 300) {
		return WorkDetail{}, ValidationError{Fields: map[string]string{"lastBpm": "must be between 30 and 300"}}
	}
	result, err := s.Pool.Exec(ctx, `UPDATE learner_works SET status=$3,is_favorite=$4,personal_difficulty=NULLIF($5,''),personal_notes=NULLIF($6,''),last_bpm=$7,updated_at=now() WHERE user_id=$1 AND work_id=$2`, userID, workID, input.Status, input.IsFavorite, input.PersonalDifficulty, input.PersonalNotes, input.LastBPM)
	if err != nil {
		return WorkDetail{}, err
	}
	if result.RowsAffected() == 0 {
		return WorkDetail{}, ErrNotFound
	}
	return s.GetWork(ctx, userID, workID)
}

type EditionInput struct {
	Name       string `json:"name"`
	Editor     string `json:"editor"`
	Publisher  string `json:"publisher"`
	SourceURL  string `json:"sourceUrl"`
	RightsNote string `json:"rightsNote"`
	Archived   *bool  `json:"archived,omitempty"`
}

func (s *Service) UpdateEdition(ctx context.Context, userID, editionID string, input EditionInput) (Edition, error) {
	if err := validateResourceID(editionID); err != nil {
		return Edition{}, err
	}
	if strings.TrimSpace(input.Name) == "" {
		return Edition{}, ValidationError{Fields: map[string]string{"name": "is required"}}
	}
	var edition Edition
	err := s.Pool.QueryRow(ctx, `
		UPDATE editions e SET name=btrim($3),editor=NULLIF(btrim($4),''),publisher=NULLIF(btrim($5),''),source_url=NULLIF(btrim($6),''),rights_note=NULLIF(btrim($7),''),archived_at=CASE WHEN $8::boolean IS NULL THEN archived_at WHEN $8 THEN COALESCE(archived_at,now()) ELSE NULL END,updated_at=now()
		FROM learner_works lw WHERE lw.work_id=e.work_id AND lw.user_id=$1 AND e.created_by_user_id=$1 AND e.id=$2
		RETURNING e.id::text,e.name,COALESCE(e.editor,''),COALESCE(e.publisher,''),e.publication_year,COALESCE(e.source_url,''),COALESCE(e.rights_note,''),e.archived_at`,
		userID, editionID, input.Name, input.Editor, input.Publisher, input.SourceURL, input.RightsNote, input.Archived,
	).Scan(&edition.ID, &edition.Name, &edition.Editor, &edition.Publisher, &edition.PublicationYear, &edition.SourceURL, &edition.RightsNote, &edition.ArchivedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Edition{}, ErrNotFound
	}
	if err != nil {
		return Edition{}, err
	}
	edition.Assets, err = s.ListEditionAssets(ctx, userID, editionID)
	return edition, err
}

func (s *Service) DeleteEdition(ctx context.Context, userID, editionID string) error {
	if err := validateResourceID(editionID); err != nil {
		return err
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck -- a committed transaction makes rollback a no-op
	var owned, referenced, shared bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS(SELECT 1 FROM editions e JOIN learner_works lw ON lw.work_id=e.work_id WHERE e.id=$2 AND e.created_by_user_id=$1 AND lw.user_id=$1),
		       EXISTS(SELECT 1 FROM practice_sessions ps JOIN score_assets a ON a.id=ps.score_asset_id WHERE a.edition_id=$2),
		       EXISTS(SELECT 1 FROM score_assets WHERE edition_id=$2 AND uploaded_by_user_id<>$1)`, userID, editionID).Scan(&owned, &referenced, &shared); err != nil {
		return err
	}
	if !owned {
		return ErrNotFound
	}
	if referenced || shared {
		return ErrEditionInUse
	}
	rows, err := tx.Query(ctx, `SELECT storage_key FROM score_assets WHERE edition_id=$1`, editionID)
	if err != nil {
		return err
	}
	keys := []string{}
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			rows.Close()
			return err
		}
		keys = append(keys, key)
	}
	rows.Close()
	if _, err := tx.Exec(ctx, `DELETE FROM editions WHERE id=$1 AND created_by_user_id=$2`, editionID, userID); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	for _, key := range keys {
		if err := s.Store.Delete(context.Background(), key); err != nil {
			slog.Error("edition metadata deleted but storage cleanup failed", "edition_id", editionID, "storage_key", key, "error", err)
		}
	}
	return nil
}

func (s *Service) AddEdition(ctx context.Context, userID, workID string, input EditionInput) (Edition, error) {
	if err := validateResourceID(workID); err != nil {
		return Edition{}, err
	}
	if strings.TrimSpace(input.Name) == "" {
		return Edition{}, ValidationError{Fields: map[string]string{"name": "is required"}}
	}
	var edition Edition
	err := s.Pool.QueryRow(ctx, `
		INSERT INTO editions(work_id,name,editor,publisher,source_url,rights_note,created_by_user_id)
		SELECT w.id,$3,NULLIF($4,''),NULLIF($5,''),NULLIF($6,''),NULLIF($7,''),$1
		FROM works w JOIN learner_works lw ON lw.work_id=w.id WHERE lw.user_id=$1 AND w.id=$2
		RETURNING id::text,name,COALESCE(editor,''),COALESCE(publisher,''),publication_year,COALESCE(source_url,''),COALESCE(rights_note,'')`,
		userID, workID, strings.TrimSpace(input.Name), input.Editor, input.Publisher, input.SourceURL, input.RightsNote,
	).Scan(&edition.ID, &edition.Name, &edition.Editor, &edition.Publisher, &edition.PublicationYear, &edition.SourceURL, &edition.RightsNote)
	if errors.Is(err, pgx.ErrNoRows) {
		return Edition{}, ErrNotFound
	}
	edition.Assets = []Asset{}
	return edition, err
}

type MovementInput struct {
	SequenceNumber int    `json:"sequenceNumber"`
	Title          string `json:"title"`
	TempoMarking   string `json:"tempoMarking"`
	MeasureCount   *int   `json:"measureCount"`
}

func (s *Service) AddMovement(ctx context.Context, userID, workID string, input MovementInput) (Movement, error) {
	if err := validateResourceID(workID); err != nil {
		return Movement{}, err
	}
	fields := map[string]string{}
	if input.SequenceNumber < 1 {
		fields["sequenceNumber"] = "must be positive"
	}
	if strings.TrimSpace(input.Title) == "" {
		fields["title"] = "is required"
	}
	if input.MeasureCount != nil && *input.MeasureCount < 1 {
		fields["measureCount"] = "must be positive"
	}
	if len(fields) > 0 {
		return Movement{}, ValidationError{Fields: fields}
	}
	var movement Movement
	err := s.Pool.QueryRow(ctx, `
		INSERT INTO movements(work_id,sequence_number,title,tempo_marking,measure_count)
		SELECT w.id,$3,$4,NULLIF($5,''),$6 FROM works w JOIN learner_works lw ON lw.work_id=w.id WHERE lw.user_id=$1 AND w.id=$2
		RETURNING id::text,sequence_number,title,COALESCE(tempo_marking,''),measure_count`,
		userID, workID, input.SequenceNumber, input.Title, input.TempoMarking, input.MeasureCount,
	).Scan(&movement.ID, &movement.SequenceNumber, &movement.Title, &movement.TempoMarking, &movement.MeasureCount)
	if errors.Is(err, pgx.ErrNoRows) {
		return Movement{}, ErrNotFound
	}
	return movement, err
}
