package app

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime/multipart"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

const (
	recognitionTimeout        = 10 * time.Minute
	maxRecognitionBytes       = 25 << 20
	maxRecognitionOutputBytes = 25 << 20
	recognitionLeaseDuration  = 45 * time.Second
	recognitionLeaseHeartbeat = 15 * time.Second
	recognitionPollInterval   = 2 * time.Second
)

type RecognitionOutput struct {
	Path          string
	EngineVersion string
}

type Recognizer interface {
	Recognize(ctx context.Context, inputPath, outputDirectory string) (RecognitionOutput, error)
}

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
			return RecognitionOutput{Path: matches[0], EngineVersion: r.Version}, nil
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
	if strings.EqualFold(filepath.Ext(path), ".mxl") {
		archive, err := zip.OpenReader(path)
		if err != nil {
			return fmt.Errorf("open compressed score: %w", err)
		}
		defer archive.Close()
		if len(archive.File) == 0 || len(archive.File) > 128 {
			return errors.New("compressed score has an invalid entry count")
		}
		for _, entry := range archive.File {
			if strings.HasPrefix(entry.Name, "META-INF/") || !strings.HasSuffix(strings.ToLower(entry.Name), ".xml") {
				continue
			}
			if entry.UncompressedSize64 > maxRecognitionOutputBytes {
				return errors.New("compressed score XML is too large")
			}
			reader, err := entry.Open()
			if err != nil {
				return err
			}
			err = validateRecognitionXML(reader)
			_ = reader.Close()
			if err == nil {
				return nil
			}
		}
		return errors.New("compressed score contains no playable pitched notes")
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	return validateRecognitionXML(file)
}

func validateRecognitionXML(reader io.Reader) error {
	limited := &io.LimitedReader{R: reader, N: maxRecognitionOutputBytes + 1}
	decoder := xml.NewDecoder(limited)
	var score, measure, pitch bool
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return fmt.Errorf("parse MusicXML: %w", err)
		}
		start, ok := token.(xml.StartElement)
		if !ok {
			continue
		}
		switch start.Name.Local {
		case "score-partwise", "score-timewise":
			score = true
		case "measure":
			measure = true
		case "pitch":
			pitch = true
		}
	}
	if limited.N == 0 {
		return errors.New("recognition output is too large")
	}
	if !score {
		return errors.New("export is not a MusicXML score")
	}
	if !measure {
		return errors.New("export contains no measures")
	}
	if !pitch {
		return errors.New("export contains no pitched notes")
	}
	return nil
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
	if s.Recognizer == nil {
		return RecognitionJob{}, ErrRecognitionUnavailable
	}
	if err := validateResourceID(sourceAssetID); err != nil {
		return RecognitionJob{}, err
	}
	var job RecognitionJob
	err := scanRecognitionJob(s.Pool.QueryRow(ctx, `
		INSERT INTO recognition_jobs(user_id,source_asset_id)
		SELECT $1,a.id FROM score_assets a JOIN editions e ON e.id=a.edition_id JOIN learner_works lw ON lw.work_id=e.work_id
		WHERE a.id=$2 AND a.uploaded_by_user_id=$1 AND lw.user_id=$1 AND a.asset_type='pdf' AND a.archived_at IS NULL AND e.archived_at IS NULL AND a.byte_size<=$3
		RETURNING id::text,source_asset_id::text,output_asset_id::text,status,engine,engine_version,COALESCE(failure_message,''),created_at,started_at,finished_at,updated_at`, userID, sourceAssetID, maxRecognitionBytes), &job)
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
	workerCtx := context.Background()
	s.recognitionMu.Lock()
	if s.recognitionContext != nil {
		workerCtx = s.recognitionContext
	}
	s.recognitionMu.Unlock()
	go s.runRecognitionJob(workerCtx, job.ID)
	return job, nil
}

func scanRecognitionJob(row pgx.Row, job *RecognitionJob) error {
	return row.Scan(&job.ID, &job.SourceAssetID, &job.OutputAssetID, &job.Status, &job.Engine, &job.EngineVersion, &job.FailureMessage, &job.CreatedAt, &job.StartedAt, &job.FinishedAt, &job.UpdatedAt)
}

func (s *Service) ActiveRecognitionJob(ctx context.Context, userID, sourceAssetID string) (RecognitionJob, error) {
	var job RecognitionJob
	err := scanRecognitionJob(s.Pool.QueryRow(ctx, `SELECT id::text,source_asset_id::text,output_asset_id::text,status,engine,engine_version,COALESCE(failure_message,''),created_at,started_at,finished_at,updated_at FROM recognition_jobs WHERE user_id=$1 AND source_asset_id=$2 AND status IN ('queued','processing') ORDER BY created_at DESC LIMIT 1`, userID, sourceAssetID), &job)
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
	err := scanRecognitionJob(s.Pool.QueryRow(ctx, `SELECT id::text,source_asset_id::text,output_asset_id::text,status,engine,engine_version,COALESCE(failure_message,''),created_at,started_at,finished_at,updated_at FROM recognition_jobs WHERE user_id=$1 AND id=$2`, userID, jobID), &job)
	if errors.Is(err, pgx.ErrNoRows) {
		return RecognitionJob{}, ErrNotFound
	}
	return job, err
}

func (s *Service) ListRecognitionJobs(ctx context.Context, userID, sourceAssetID string) ([]RecognitionJob, error) {
	if err := validateResourceID(sourceAssetID); err != nil {
		return nil, err
	}
	rows, err := s.Pool.Query(ctx, `SELECT id::text,source_asset_id::text,output_asset_id::text,status,engine,engine_version,COALESCE(failure_message,''),created_at,started_at,finished_at,updated_at FROM recognition_jobs WHERE user_id=$1 AND source_asset_id=$2 ORDER BY created_at DESC`, userID, sourceAssetID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	jobs := []RecognitionJob{}
	for rows.Next() {
		var job RecognitionJob
		if err := rows.Scan(&job.ID, &job.SourceAssetID, &job.OutputAssetID, &job.Status, &job.Engine, &job.EngineVersion, &job.FailureMessage, &job.CreatedAt, &job.StartedAt, &job.FinishedAt, &job.UpdatedAt); err != nil {
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
	return s.CreateRecognitionJob(ctx, userID, job.SourceAssetID)
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
	id, userID, sourceAssetID string
}

func (s *Service) claimRecognitionJob(ctx context.Context, requestedJobID string) (claimedRecognitionJob, error) {
	var job claimedRecognitionJob
	err := s.Pool.QueryRow(ctx, `
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
		RETURNING job.id::text,job.user_id::text,job.source_asset_id::text`,
		s.recognitionWorkerID, requestedJobID, int(recognitionLeaseDuration/time.Second),
	).Scan(&job.id, &job.userID, &job.sourceAssetID)
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
	inputPath := filepath.Join(jobDirectory, "input.pdf")
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
	converted, err := s.Recognizer.Recognize(ctx, inputPath, outputDirectory)
	if err != nil {
		if errors.Is(ctx.Err(), context.Canceled) && !errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return
		}
		s.failRecognition(ctx, job.id, err)
		return
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
		SourceURL: source.ContentURL, RightsNote: "Generated by Audiveris from " + source.DisplayName,
		DerivedFromAssetID: source.ID, VerificationState: "unverified_ocr",
	})
	_ = output.Close()
	if err != nil {
		s.failRecognition(ctx, job.id, err)
		return
	}
	if err := s.finishRecognition(job.id, job.userID, asset.ID, converted.EngineVersion, s.recognitionWorkerID); err != nil {
		slog.Error("finish score recognition", "job_id", job.id, "asset_id", asset.ID, "error", err)
	}
}

func (s *Service) finishRecognition(jobID, userID, assetID, engineVersion, leaseOwner string) error {
	result, err := s.Pool.Exec(context.Background(), `UPDATE recognition_jobs SET status='succeeded',output_asset_id=$2,engine_version=$3,lease_owner=NULL,lease_expires_at=NULL,finished_at=now(),updated_at=now() WHERE id=$1 AND status='processing' AND lease_owner=$4`, jobID, assetID, engineVersion, leaseOwner)
	if err == nil && result.RowsAffected() == 1 {
		return nil
	}
	cleanupErr := s.DeleteAsset(context.Background(), userID, assetID)
	if err != nil {
		return errors.Join(fmt.Errorf("record recognition output: %w", err), cleanupErr)
	}
	if cleanupErr != nil {
		return fmt.Errorf("recognition was no longer active and output cleanup failed: %w", cleanupErr)
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
	_, _ = s.Pool.Exec(context.Background(), `UPDATE recognition_jobs SET status='failed',failure_message=$2,lease_owner=NULL,lease_expires_at=NULL,finished_at=now(),updated_at=now() WHERE id=$1 AND status='processing' AND lease_owner=$3`, jobID, message, s.recognitionWorkerID)
}
