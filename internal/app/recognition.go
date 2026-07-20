package app

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime/multipart"
	"os"
	"os/exec"
	pathpkg "path"
	"path/filepath"
	"strings"
	"time"

	assetstore "github.com/bitofbytes-io/noted/internal/assets"
	"github.com/bitofbytes-io/noted/internal/omrreport"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

const (
	recognitionTimeout         = 10 * time.Minute
	maxRecognitionBytes        = 25 << 20
	maxRecognitionOutputBytes  = 25 << 20
	maxRecognitionProjectBytes = 512 << 20
	recognitionLeaseDuration   = 45 * time.Second
	recognitionLeaseHeartbeat  = 15 * time.Second
	recognitionPollInterval    = 2 * time.Second
)

type RecognitionOutput struct {
	Path          string
	ProjectPath   string
	Engine        string
	EngineVersion string
	Report        *omrreport.Report
}

type Recognizer interface {
	Recognize(ctx context.Context, inputPath, outputDirectory string) (RecognitionOutput, error)
}

type MeasureMapOutput struct {
	Pages         []MeasureMapPage
	EngineVersion string
}

type MeasureMapper interface {
	MapMeasures(ctx context.Context, inputPath, outputDirectory string) (MeasureMapOutput, error)
}

type recognitionOptions struct {
	SourceType string
	Hints      RecognitionHints
}

type recognitionOptionsContextKey struct{}

func recognitionOptionsFromContext(ctx context.Context) recognitionOptions {
	options, _ := ctx.Value(recognitionOptionsContextKey{}).(recognitionOptions)
	return options
}

const recognitionJobColumns = `
	id::text,source_asset_id::text,output_asset_id::text,status,job_kind,hints,engine,engine_version,
	COALESCE(failure_code,''),COALESCE(failure_message,''),flagged_measures,corrected_measures,
	quality_report,project_storage_key,created_at,started_at,finished_at,updated_at`

type CommandRecognizer struct {
	Command string
	Version string
}

func (r CommandRecognizer) Recognize(ctx context.Context, inputPath, outputDirectory string) (RecognitionOutput, error) {
	if strings.TrimSpace(r.Command) == "" {
		return RecognitionOutput{}, ErrRecognitionUnavailable
	}
	var output limitedBuffer
	command := exec.CommandContext(ctx, r.Command, inputPath, outputDirectory)
	command.Stdout = &output
	command.Stderr = &output
	if err := command.Run(); err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return RecognitionOutput{}, fmt.Errorf("recognition timed out")
		}
		return RecognitionOutput{}, fmt.Errorf("Audiveris failed: %s", output.String())
	}
	for _, pattern := range []string{"*.mxl", "*.musicxml", "*.xml"} {
		matches, err := filepath.Glob(filepath.Join(outputDirectory, pattern))
		if err != nil {
			return RecognitionOutput{}, err
		}
		if len(matches) > 0 {
			if err := validateRecognitionScore(matches[0]); err != nil {
				return RecognitionOutput{}, fmt.Errorf("Audiveris produced unusable MusicXML: %w", err)
			}
			projects, projectErr := filepath.Glob(filepath.Join(outputDirectory, "*.omr"))
			if projectErr != nil {
				return RecognitionOutput{}, projectErr
			}
			projectPath := ""
			if len(projects) > 0 {
				if err := validateRecognitionProject(projects[0]); err != nil {
					return RecognitionOutput{}, fmt.Errorf("Audiveris produced unusable correction project: %w", err)
				}
				projectPath = projects[0]
			}
			return RecognitionOutput{Path: matches[0], ProjectPath: projectPath, Engine: "audiveris", EngineVersion: r.Version}, nil
		}
	}
	return RecognitionOutput{}, errors.New("Audiveris completed without a MusicXML export")
}

func validateRecognitionScore(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if info.Size() > maxRecognitionOutputBytes {
		return errors.New("recognition output is too large")
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	validation, validationErr := assetstore.ValidateMusicXML(file, filepath.Base(path))
	closeErr := file.Close()
	if validationErr != nil {
		return validationErr
	}
	if closeErr != nil {
		return closeErr
	}
	blockingIssues := map[string]bool{
		"invalid_musicxml":           true,
		"invalid_divisions":          true,
		"cursor_before_measure":      true,
		"measure_duration_overflow":  true,
		"measure_duration_underflow": true,
		"no_playable_notes":          true,
	}
	for _, issue := range validation.Issues {
		if blockingIssues[issue.Code] {
			return fmt.Errorf("recognition output failed %s validation", issue.Code)
		}
	}
	return nil
}

func validateRecognitionProject(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if info.Size() < 1 || info.Size() > maxRecognitionProjectBytes {
		return errors.New("recognition project is too large")
	}
	archive, err := zip.OpenReader(path)
	if err != nil {
		return fmt.Errorf("open recognition project: %w", err)
	}
	defer archive.Close()
	if len(archive.File) < 1 || len(archive.File) > 4096 {
		return errors.New("recognition project has an invalid entry count")
	}
	var expanded uint64
	bookSeen := false
	for _, entry := range archive.File {
		if !safeRecognitionProjectPath(entry.Name) {
			return errors.New("recognition project contains an unsafe path")
		}
		if entry.UncompressedSize64 > uint64(maxRecognitionProjectBytes)-expanded {
			return errors.New("recognition project expands beyond the permitted size")
		}
		expanded += entry.UncompressedSize64
		if entry.Name == "book.xml" {
			bookSeen = true
		}
	}
	if !bookSeen {
		return errors.New("recognition project is missing book.xml")
	}
	return nil
}

func safeRecognitionProjectPath(name string) bool {
	if name == "" || strings.ContainsAny(name, "\\\x00") {
		return false
	}
	clean := pathpkg.Clean(name)
	return clean != "." && !pathpkg.IsAbs(clean) && clean != ".." && !strings.HasPrefix(clean, "../")
}

// RecoverRecognitionJobs starts the durable queue dispatcher. It deliberately
// does not reset processing rows: another API replica may still own their lease.
// Expired leases are reclaimed atomically by claimRecognitionJob.
func (s *Service) RecoverRecognitionJobs(ctx context.Context) error {
	if s.Recognizer == nil {
		return ErrRecognitionUnavailable
	}
	if _, err := s.Pool.Exec(ctx, `SELECT 1 FROM recognition_jobs LIMIT 0`); err != nil {
		return fmt.Errorf("inspect recognition queue: %w", err)
	}
	s.recognitionMu.Lock()
	s.recognitionContext = ctx
	s.recognitionMu.Unlock()
	s.recognitionWorker.Do(func() { go s.dispatchRecognitionJobs(ctx) })
	return nil
}

func (s *Service) dispatchRecognitionJobs(ctx context.Context) {
	ticker := time.NewTicker(recognitionPollInterval)
	defer ticker.Stop()
	for {
		if s.runRecognitionJob(ctx, "") {
			continue
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

type limitedBuffer struct{ bytes.Buffer }

func (b *limitedBuffer) Write(p []byte) (int, error) {
	const limit = 16 << 10
	original := len(p)
	if b.Len() < limit {
		remaining := limit - b.Len()
		if len(p) > remaining {
			p = p[:remaining]
		}
		_, _ = b.Buffer.Write(p)
	}
	return original, nil
}

func (s *Service) CreateRecognitionJob(ctx context.Context, userID, sourceAssetID string) (RecognitionJob, error) {
	return s.CreateRecognitionJobWithHints(ctx, userID, sourceAssetID, RecognitionHints{})
}

func (s *Service) CreateRecognitionJobWithHints(ctx context.Context, userID, sourceAssetID string, hints RecognitionHints) (RecognitionJob, error) {
	if s.Recognizer == nil {
		return RecognitionJob{}, ErrRecognitionUnavailable
	}
	if err := validateResourceID(sourceAssetID); err != nil {
		return RecognitionJob{}, err
	}
	var job RecognitionJob
	query := `
		INSERT INTO recognition_jobs(user_id,source_asset_id,job_kind,hints)
		SELECT $1,a.id,'transcribe',$4 FROM score_assets a JOIN editions e ON e.id=a.edition_id JOIN learner_works lw ON lw.work_id=e.work_id
		WHERE a.id=$2 AND a.uploaded_by_user_id=$1 AND lw.user_id=$1 AND a.asset_type IN ('pdf','image') AND a.archived_at IS NULL AND e.archived_at IS NULL AND a.byte_size<=$3
		RETURNING ` + recognitionJobColumns
	hintsJSON, err := json.Marshal(hints)
	if err != nil {
		return RecognitionJob{}, err
	}
	err = scanRecognitionJob(s.Pool.QueryRow(ctx, query, userID, sourceAssetID, maxRecognitionBytes, hintsJSON), &job)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return s.ActiveRecognitionJob(ctx, userID, sourceAssetID)
		}
		if errors.Is(err, pgx.ErrNoRows) {
			return RecognitionJob{}, ErrNotFound
		}
		return RecognitionJob{}, err
	}
	// Wake this replica immediately. The database lease keeps this safe when a
	// second replica's dispatcher sees the same newly queued row.
	s.wakeRecognitionJob(job.ID)
	return job, nil
}

func (s *Service) wakeRecognitionJob(jobID string) {
	workerCtx := context.Background()
	s.recognitionMu.Lock()
	if s.recognitionContext != nil {
		workerCtx = s.recognitionContext
	}
	s.recognitionMu.Unlock()
	go s.runRecognitionJob(workerCtx, jobID)
}

func scanRecognitionJob(row pgx.Row, job *RecognitionJob) error {
	var reportJSON, hintsJSON []byte
	err := row.Scan(
		&job.ID, &job.SourceAssetID, &job.OutputAssetID, &job.Status, &job.JobKind, &hintsJSON, &job.Engine, &job.EngineVersion,
		&job.ErrorCode, &job.FailureMessage, &job.FlaggedMeasures, &job.CorrectedMeasures,
		&reportJSON, &job.projectStorageKey, &job.CreatedAt, &job.StartedAt, &job.FinishedAt, &job.UpdatedAt,
	)
	if err == nil && len(hintsJSON) > 0 {
		if decodeErr := json.Unmarshal(hintsJSON, &job.Hints); decodeErr != nil {
			return fmt.Errorf("decode recognition hints: %w", decodeErr)
		}
	}
	if err == nil && len(reportJSON) > 0 {
		report, decodeErr := omrreport.Decode(bytes.NewReader(reportJSON))
		if decodeErr != nil {
			return fmt.Errorf("decode stored OMR quality report: %w", decodeErr)
		}
		job.Report = &report
	}
	if err == nil && job.projectStorageKey != nil {
		job.ProjectDownloadURL = "/api/recognition-jobs/" + job.ID + "/project"
	}
	return err
}

func (s *Service) ActiveRecognitionJob(ctx context.Context, userID, sourceAssetID string) (RecognitionJob, error) {
	var job RecognitionJob
	err := scanRecognitionJob(s.Pool.QueryRow(ctx, `SELECT `+recognitionJobColumns+` FROM recognition_jobs WHERE user_id=$1 AND source_asset_id=$2 AND job_kind='transcribe' AND status IN ('queued','processing') ORDER BY created_at DESC LIMIT 1`, userID, sourceAssetID), &job)
	if errors.Is(err, pgx.ErrNoRows) {
		return RecognitionJob{}, ErrNotFound
	}
	return job, err
}

func (s *Service) GetRecognitionJob(ctx context.Context, userID, jobID string) (RecognitionJob, error) {
	if err := validateResourceID(jobID); err != nil {
		return RecognitionJob{}, err
	}
	var job RecognitionJob
	err := scanRecognitionJob(s.Pool.QueryRow(ctx, `SELECT `+recognitionJobColumns+` FROM recognition_jobs WHERE user_id=$1 AND id=$2`, userID, jobID), &job)
	if errors.Is(err, pgx.ErrNoRows) {
		return RecognitionJob{}, ErrNotFound
	}
	return job, err
}

func (s *Service) OpenRecognitionProject(ctx context.Context, userID, jobID string) (io.ReadCloser, int64, error) {
	if err := validateResourceID(jobID); err != nil {
		return nil, 0, err
	}
	var storageKey string
	err := s.Pool.QueryRow(ctx, `
		SELECT project_storage_key
		FROM recognition_jobs
		WHERE id=$1 AND user_id=$2 AND status='succeeded' AND project_storage_key IS NOT NULL`, jobID, userID).Scan(&storageKey)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, 0, ErrNotFound
	}
	if err != nil {
		return nil, 0, err
	}
	reader, info, err := s.Store.Open(ctx, storageKey)
	if err != nil {
		return nil, 0, err
	}
	return reader, info.Size, nil
}

func (s *Service) ListRecognitionJobs(ctx context.Context, userID, sourceAssetID string) ([]RecognitionJob, error) {
	if err := validateResourceID(sourceAssetID); err != nil {
		return nil, err
	}
	rows, err := s.Pool.Query(ctx, `SELECT `+recognitionJobColumns+` FROM recognition_jobs WHERE user_id=$1 AND source_asset_id=$2 AND job_kind='transcribe' ORDER BY created_at DESC`, userID, sourceAssetID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	jobs := []RecognitionJob{}
	for rows.Next() {
		var job RecognitionJob
		if err := scanRecognitionJob(rows, &job); err != nil {
			return nil, err
		}
		jobs = append(jobs, job)
	}
	return jobs, rows.Err()
}

func (s *Service) RetryRecognitionJob(ctx context.Context, userID, jobID string) (RecognitionJob, error) {
	job, err := s.GetRecognitionJob(ctx, userID, jobID)
	if err != nil {
		return RecognitionJob{}, err
	}
	if job.Status == "queued" || job.Status == "processing" {
		return job, nil
	}
	return s.CreateRecognitionJobWithHints(ctx, userID, job.SourceAssetID, job.Hints)
}

func (s *Service) CancelRecognitionJob(ctx context.Context, userID, jobID string) error {
	if err := validateResourceID(jobID); err != nil {
		return err
	}
	result, err := s.Pool.Exec(ctx, `UPDATE recognition_jobs SET status='cancelled',lease_owner=NULL,lease_expires_at=NULL,finished_at=now(),updated_at=now() WHERE user_id=$1 AND id=$2 AND status IN ('queued','processing')`, userID, jobID)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		if _, err := s.GetRecognitionJob(ctx, userID, jobID); err != nil {
			return err
		}
		return nil
	}
	s.recognitionMu.Lock()
	cancel := s.recognitionCancels[jobID]
	s.recognitionMu.Unlock()
	if cancel != nil {
		cancel()
	}
	return nil
}

type claimedRecognitionJob struct {
	id, userID, sourceAssetID, jobKind string
	hints                              RecognitionHints
}

func (s *Service) claimRecognitionJob(ctx context.Context, requestedJobID string) (claimedRecognitionJob, error) {
	var job claimedRecognitionJob
	row := s.Pool.QueryRow(ctx, `
		WITH claim_guard AS MATERIALIZED (
			SELECT pg_try_advisory_xact_lock(hashtextextended('noted-recognition-worker',0)) AS acquired
		), candidate AS (
			SELECT id
			FROM recognition_jobs, claim_guard
			WHERE ($2 = '' OR id = NULLIF($2, '')::uuid)
			  AND claim_guard.acquired
			  AND NOT EXISTS (
				SELECT 1 FROM recognition_jobs AS active
				WHERE active.status='processing' AND active.lease_expires_at > now()
			  )
			  AND (status = 'queued' OR
			       (status = 'processing' AND (lease_expires_at IS NULL OR lease_expires_at <= now())))
			ORDER BY created_at
			FOR UPDATE SKIP LOCKED
			LIMIT 1
		)
		UPDATE recognition_jobs AS job
		SET status='processing',
			started_at=COALESCE(job.started_at,now()),
			finished_at=NULL,
			failure_message=NULL,
			lease_owner=$1,
			lease_expires_at=now()+make_interval(secs => $3),
			attempt_count=job.attempt_count+1,
			updated_at=now()
		FROM candidate
		WHERE job.id=candidate.id
		RETURNING job.id::text,job.user_id::text,job.source_asset_id::text,job.job_kind,job.hints`,
		s.recognitionWorkerID, requestedJobID, int(recognitionLeaseDuration/time.Second),
	)
	var hintsJSON []byte
	err := row.Scan(&job.id, &job.userID, &job.sourceAssetID, &job.jobKind, &hintsJSON)
	if err == nil {
		err = json.Unmarshal(hintsJSON, &job.hints)
	}
	return job, err
}

func (s *Service) runRecognitionJob(workerCtx context.Context, requestedJobID string) bool {
	select {
	case s.recognitionSlots <- struct{}{}:
	case <-workerCtx.Done():
		return false
	}
	defer func() { <-s.recognitionSlots }()
	job, err := s.claimRecognitionJob(workerCtx, requestedJobID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false
	}
	if err != nil {
		slog.Error("claim score recognition", "error", err)
		return false
	}
	ctx, cancel := context.WithTimeout(workerCtx, recognitionTimeout)
	s.recognitionMu.Lock()
	s.recognitionCancels[job.id] = cancel
	s.recognitionMu.Unlock()
	defer func() {
		cancel()
		s.recognitionMu.Lock()
		delete(s.recognitionCancels, job.id)
		s.recognitionMu.Unlock()
	}()
	go s.renewRecognitionLease(ctx, cancel, job.id)
	s.runClaimedRecognition(ctx, job)
	return true
}

func (s *Service) renewRecognitionLease(ctx context.Context, cancel context.CancelFunc, jobID string) {
	ticker := time.NewTicker(recognitionLeaseHeartbeat)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			result, err := s.Pool.Exec(ctx, `
				UPDATE recognition_jobs
				SET lease_expires_at=now()+make_interval(secs => $3),updated_at=now()
				WHERE id=$1 AND status='processing' AND lease_owner=$2`,
				jobID, s.recognitionWorkerID, int(recognitionLeaseDuration/time.Second))
			if err != nil || result.RowsAffected() != 1 {
				if err != nil && !errors.Is(ctx.Err(), context.Canceled) {
					slog.Error("renew score recognition lease", "job_id", jobID, "error", err)
				}
				cancel()
				return
			}
		}
	}
}

func (s *Service) runClaimedRecognition(ctx context.Context, job claimedRecognitionJob) {
	source, err := s.getAssetRecord(ctx, job.userID, job.sourceAssetID)
	if err != nil {
		s.failRecognition(ctx, job.id, err)
		return
	}
	jobDirectory, err := os.MkdirTemp("", "noted-recognition-*")
	if err != nil {
		s.failRecognition(ctx, job.id, err)
		return
	}
	defer os.RemoveAll(jobDirectory)
	inputExtension := ".pdf"
	if source.AssetType == "image" {
		inputExtension = filepath.Ext(source.OriginalFilename)
		if inputExtension == "" {
			inputExtension = ".image"
		}
	}
	inputPath := filepath.Join(jobDirectory, "input"+inputExtension)
	input, _, err := s.Store.Open(ctx, source.StorageKey)
	if err != nil {
		s.failRecognition(ctx, job.id, err)
		return
	}
	file, err := os.Create(inputPath)
	if err != nil {
		_ = input.Close()
		s.failRecognition(ctx, job.id, err)
		return
	}
	_, err = io.Copy(file, io.LimitReader(input, maxRecognitionBytes+1))
	closeErr := file.Close()
	_ = input.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		s.failRecognition(ctx, job.id, err)
		return
	}
	outputDirectory := filepath.Join(jobDirectory, "output")
	if err := os.Mkdir(outputDirectory, 0o750); err != nil {
		s.failRecognition(ctx, job.id, err)
		return
	}
	if job.jobKind == "measure_map" {
		s.runClaimedMeasureMap(ctx, job, inputPath, outputDirectory)
		return
	}
	ctx = context.WithValue(ctx, recognitionOptionsContextKey{}, recognitionOptions{SourceType: source.AssetType, Hints: job.hints})
	converted, err := s.Recognizer.Recognize(ctx, inputPath, outputDirectory)
	if err != nil {
		if errors.Is(ctx.Err(), context.Canceled) && !errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return
		}
		s.failRecognition(ctx, job.id, err)
		return
	}
	if strings.EqualFold(converted.Engine, "audiveris+homr") && converted.Report == nil {
		s.failRecognition(ctx, job.id, errors.New("dual-engine recognition produced no quality report"))
		return
	}
	if converted.Report != nil {
		if err := converted.Report.Validate(); err != nil {
			s.failRecognition(ctx, job.id, fmt.Errorf("validate OMR quality report: %w", err))
			return
		}
	}
	projectKey := ""
	projectStored := false
	defer func() {
		if projectStored {
			_ = s.Store.Delete(context.Background(), projectKey)
		}
	}()
	if converted.ProjectPath != "" {
		project, err := os.Open(converted.ProjectPath)
		if err != nil {
			s.failRecognition(ctx, job.id, err)
			return
		}
		projectKey = "omr/" + job.id
		_, err = s.Store.Put(ctx, projectKey, project)
		closeErr := project.Close()
		if err == nil {
			err = closeErr
		}
		if err != nil {
			s.failRecognition(ctx, job.id, fmt.Errorf("store Audiveris correction project: %w", err))
			return
		}
		projectStored = true
	}
	output, err := os.Open(converted.Path)
	if err != nil {
		s.failRecognition(ctx, job.id, err)
		return
	}
	info, err := output.Stat()
	if err != nil {
		_ = output.Close()
		s.failRecognition(ctx, job.id, err)
		return
	}
	if info.Size() > maxRecognitionOutputBytes {
		_ = output.Close()
		s.failRecognition(ctx, job.id, errors.New("recognition output is too large"))
		return
	}
	header := &multipart.FileHeader{Filename: info.Name(), Size: info.Size()}
	asset, err := s.UploadAsset(ctx, job.userID, source.EditionID, header, output, UploadMetadata{
		SourceURL: source.ContentURL, RightsNote: "Generated by the Noted OMR pipeline from " + source.DisplayName,
		DerivedFromAssetID: source.ID, VerificationState: "unverified_ocr",
	})
	_ = output.Close()
	if err != nil {
		s.failRecognition(ctx, job.id, err)
		return
	}
	if err := s.finishRecognition(job.id, job.userID, asset.ID, converted.Engine, converted.EngineVersion, converted.Report, s.recognitionWorkerID, projectKey); err != nil {
		slog.Error("finish score recognition", "job_id", job.id, "asset_id", asset.ID, "error", err)
		return
	}
	projectStored = false
}

func (s *Service) runClaimedMeasureMap(ctx context.Context, job claimedRecognitionJob, inputPath, outputDirectory string) {
	if s.MeasureMapper == nil {
		s.failRecognition(ctx, job.id, ErrRecognitionUnavailable)
		return
	}
	_, _ = s.Pool.Exec(context.Background(), `UPDATE measure_maps SET status='processing',failure_message=NULL,updated_at=now() WHERE asset_id=$1 AND user_id=$2`, job.sourceAssetID, job.userID)
	result, err := s.MeasureMapper.MapMeasures(ctx, inputPath, outputDirectory)
	if err != nil {
		if errors.Is(ctx.Err(), context.Canceled) && !errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return
		}
		s.failRecognition(ctx, job.id, err)
		return
	}
	if err := validateMeasureMapPages(result.Pages); err != nil {
		s.failRecognition(ctx, job.id, fmt.Errorf("validate measure map: %w", err))
		return
	}
	pagesJSON, err := json.Marshal(result.Pages)
	if err != nil {
		s.failRecognition(ctx, job.id, err)
		return
	}
	tx, err := s.Pool.Begin(context.Background())
	if err != nil {
		s.failRecognition(ctx, job.id, err)
		return
	}
	defer tx.Rollback(context.Background()) //nolint:errcheck
	updated, err := tx.Exec(context.Background(), `
		UPDATE recognition_jobs SET status='succeeded',engine='audiveris-measures',engine_version=$2,
			failure_code=NULL,failure_message=NULL,lease_owner=NULL,lease_expires_at=NULL,finished_at=now(),updated_at=now()
		WHERE id=$1 AND job_kind='measure_map' AND status='processing' AND lease_owner=$3`, job.id, result.EngineVersion, s.recognitionWorkerID)
	if err != nil || updated.RowsAffected() != 1 {
		return
	}
	if _, err := tx.Exec(context.Background(), `UPDATE measure_maps SET status='ready',pages=$3,engine_version=$4,failure_message=NULL,updated_at=now() WHERE asset_id=$1 AND user_id=$2`, job.sourceAssetID, job.userID, pagesJSON, result.EngineVersion); err != nil {
		return
	}
	_ = tx.Commit(context.Background())
}

func validateMeasureMapPages(pages []MeasureMapPage) error {
	if len(pages) < 1 || len(pages) > 25 {
		return errors.New("measure map must contain between 1 and 25 pages")
	}
	seenPages := map[int]bool{}
	measureCount := 0
	for _, page := range pages {
		if page.PageNumber < 1 || seenPages[page.PageNumber] || page.Width <= 0 || page.Height <= 0 || page.DPI < 72 || page.DPI > 1200 {
			return errors.New("measure map page metadata is invalid")
		}
		seenPages[page.PageNumber] = true
		for _, box := range page.Measures {
			measureCount++
			if measureCount > 10000 || box.MeasureNumber < 1 || box.X < 0 || box.Y < 0 || box.Width <= 0 || box.Height <= 0 || box.X+box.Width > page.Width+1 || box.Y+box.Height > page.Height+1 {
				return errors.New("measure map geometry is invalid")
			}
		}
	}
	if measureCount == 0 {
		return errors.New("measure map contains no measures")
	}
	return nil
}

func (s *Service) finishRecognition(jobID, userID, assetID, engine, engineVersion string, report *omrreport.Report, leaseOwner, projectKey string) error {
	var reportJSON []byte
	var flaggedMeasures, correctedMeasures *int
	if report != nil {
		if validateErr := report.Validate(); validateErr != nil {
			return fmt.Errorf("validate OMR quality report: %w", validateErr)
		}
		var marshalErr error
		reportJSON, marshalErr = json.Marshal(report)
		if marshalErr != nil {
			return fmt.Errorf("encode OMR quality report: %w", marshalErr)
		}
		flaggedMeasures = &report.FlaggedMeasures
		correctedMeasures = &report.CorrectedMeasures
	}
	result, err := s.Pool.Exec(context.Background(), `
		UPDATE recognition_jobs SET
			status='succeeded',output_asset_id=$2,
			engine=COALESCE(NULLIF($3,''),engine),engine_version=COALESCE(NULLIF($4,''),engine_version),
			flagged_measures=$5,corrected_measures=$6,quality_report=$7,
			failure_code=NULL,failure_message=NULL,project_storage_key=NULLIF($9,''),
			lease_owner=NULL,lease_expires_at=NULL,finished_at=now(),updated_at=now()
		WHERE id=$1 AND status='processing' AND lease_owner=$8`,
		jobID, assetID, engine, engineVersion, flaggedMeasures, correctedMeasures, reportJSON, leaseOwner, projectKey)
	if err == nil && result.RowsAffected() == 1 {
		return nil
	}
	cleanupErr := s.DeleteAsset(context.Background(), userID, assetID)
	var projectCleanupErr error
	if projectKey != "" {
		projectCleanupErr = s.Store.Delete(context.Background(), projectKey)
	}
	if err != nil {
		return errors.Join(fmt.Errorf("record recognition output: %w", err), cleanupErr, projectCleanupErr)
	}
	if cleanupErr != nil {
		return fmt.Errorf("recognition was no longer active and output cleanup failed: %w", cleanupErr)
	}
	if projectCleanupErr != nil {
		return fmt.Errorf("recognition was no longer active and project cleanup failed: %w", projectCleanupErr)
	}
	return nil
}

func (s *Service) failRecognition(ctx context.Context, jobID string, err error) {
	if errors.Is(ctx.Err(), context.Canceled) && !errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return
	}
	message := strings.TrimSpace(err.Error())
	if len(message) > 500 {
		message = message[:500]
	}
	code := "recognition_failed"
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
		code = "recognition_timed_out"
	}
	var remoteErr *RemoteRecognitionError
	if errors.As(err, &remoteErr) {
		code = normalizeRecognitionFailureCode(remoteErr.Code)
	}
	_, _ = s.Pool.Exec(context.Background(), `UPDATE recognition_jobs SET status='failed',failure_code=$2,failure_message=$3,lease_owner=NULL,lease_expires_at=NULL,finished_at=now(),updated_at=now() WHERE id=$1 AND status='processing' AND lease_owner=$4`, jobID, code, message, s.recognitionWorkerID)
	_, _ = s.Pool.Exec(context.Background(), `
		UPDATE measure_maps mm SET status='failed',failure_message=$2,updated_at=now()
		FROM recognition_jobs r WHERE r.id=$1 AND r.job_kind='measure_map' AND mm.asset_id=r.source_asset_id AND mm.user_id=r.user_id`, jobID, message)
}

func normalizeRecognitionFailureCode(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "" || len(value) > 100 {
		return "recognition_failed"
	}
	for _, character := range value {
		if (character < 'a' || character > 'z') && (character < '0' || character > '9') && character != '_' {
			return "recognition_failed"
		}
	}
	return value
}
