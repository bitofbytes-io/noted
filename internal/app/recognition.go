package app

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
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
	recognitionTimeout  = 10 * time.Minute
	maxRecognitionBytes = 25 << 20
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
			return RecognitionOutput{Path: matches[0], EngineVersion: r.Version}, nil
		}
	}
	return RecognitionOutput{}, errors.New("Audiveris completed without a MusicXML export")
}

// RecoverRecognitionJobs requeues work interrupted by a previous API process and
// starts every persisted queued job. runRecognition claims each row atomically,
// so duplicate recovery calls cannot execute the same job twice.
func (s *Service) RecoverRecognitionJobs(ctx context.Context) error {
	if s.Recognizer == nil {
		return ErrRecognitionUnavailable
	}
	if _, err := s.Pool.Exec(ctx, `
		UPDATE recognition_jobs
		SET status='queued',started_at=NULL,finished_at=NULL,failure_message=NULL,updated_at=now()
		WHERE status='processing'`); err != nil {
		return fmt.Errorf("requeue interrupted recognition jobs: %w", err)
	}
	rows, err := s.Pool.Query(ctx, `
		SELECT id::text,user_id::text,source_asset_id::text
		FROM recognition_jobs WHERE status='queued' ORDER BY created_at`)
	if err != nil {
		return fmt.Errorf("list queued recognition jobs: %w", err)
	}
	defer rows.Close()
	type queuedJob struct {
		id, userID, sourceAssetID string
	}
	jobs := []queuedJob{}
	for rows.Next() {
		var job queuedJob
		if err := rows.Scan(&job.id, &job.userID, &job.sourceAssetID); err != nil {
			return err
		}
		jobs = append(jobs, job)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, job := range jobs {
		go s.runRecognition(job.userID, job.id, job.sourceAssetID)
	}
	return nil
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
		WHERE a.id=$2 AND a.uploaded_by_user_id=$1 AND lw.user_id=$1 AND a.asset_type='pdf' AND a.archived_at IS NULL AND a.byte_size<=$3
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
	go s.runRecognition(userID, job.ID, sourceAssetID)
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
	result, err := s.Pool.Exec(ctx, `UPDATE recognition_jobs SET status='cancelled',finished_at=now(),updated_at=now() WHERE user_id=$1 AND id=$2 AND status IN ('queued','processing')`, userID, jobID)
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

func (s *Service) runRecognition(userID, jobID, sourceAssetID string) {
	s.recognitionSlots <- struct{}{}
	defer func() { <-s.recognitionSlots }()
	ctx, cancel := context.WithTimeout(context.Background(), recognitionTimeout)
	s.recognitionMu.Lock()
	s.recognitionCancels[jobID] = cancel
	s.recognitionMu.Unlock()
	defer func() {
		cancel()
		s.recognitionMu.Lock()
		delete(s.recognitionCancels, jobID)
		s.recognitionMu.Unlock()
	}()
	result, err := s.Pool.Exec(ctx, `UPDATE recognition_jobs SET status='processing',started_at=now(),updated_at=now() WHERE id=$1 AND status='queued'`, jobID)
	if err != nil || result.RowsAffected() == 0 {
		return
	}
	source, err := s.getAssetRecord(ctx, userID, sourceAssetID)
	if err != nil {
		s.failRecognition(jobID, err)
		return
	}
	jobDirectory, err := os.MkdirTemp("", "noted-recognition-*")
	if err != nil {
		s.failRecognition(jobID, err)
		return
	}
	defer os.RemoveAll(jobDirectory)
	inputPath := filepath.Join(jobDirectory, "input.pdf")
	input, _, err := s.Store.Open(ctx, source.StorageKey)
	if err != nil {
		s.failRecognition(jobID, err)
		return
	}
	file, err := os.Create(inputPath)
	if err != nil {
		_ = input.Close()
		s.failRecognition(jobID, err)
		return
	}
	_, err = io.Copy(file, io.LimitReader(input, maxRecognitionBytes+1))
	closeErr := file.Close()
	_ = input.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		s.failRecognition(jobID, err)
		return
	}
	outputDirectory := filepath.Join(jobDirectory, "output")
	if err := os.Mkdir(outputDirectory, 0o750); err != nil {
		s.failRecognition(jobID, err)
		return
	}
	converted, err := s.Recognizer.Recognize(ctx, inputPath, outputDirectory)
	if err != nil {
		if errors.Is(ctx.Err(), context.Canceled) {
			return
		}
		s.failRecognition(jobID, err)
		return
	}
	output, err := os.Open(converted.Path)
	if err != nil {
		s.failRecognition(jobID, err)
		return
	}
	info, err := output.Stat()
	if err != nil {
		_ = output.Close()
		s.failRecognition(jobID, err)
		return
	}
	header := &multipart.FileHeader{Filename: info.Name(), Size: info.Size()}
	asset, err := s.UploadAsset(ctx, userID, source.EditionID, header, output, UploadMetadata{
		SourceURL: source.ContentURL, RightsNote: "Generated by Audiveris from " + source.DisplayName,
		DerivedFromAssetID: source.ID, VerificationState: "unverified_ocr",
	})
	_ = output.Close()
	if err != nil {
		s.failRecognition(jobID, err)
		return
	}
	_, _ = s.Pool.Exec(context.Background(), `UPDATE recognition_jobs SET status='succeeded',output_asset_id=$2,engine_version=$3,finished_at=now(),updated_at=now() WHERE id=$1 AND status='processing'`, jobID, asset.ID, converted.EngineVersion)
}

func (s *Service) failRecognition(jobID string, err error) {
	message := strings.TrimSpace(err.Error())
	if len(message) > 500 {
		message = message[:500]
	}
	_, _ = s.Pool.Exec(context.Background(), `UPDATE recognition_jobs SET status='failed',failure_message=$2,finished_at=now(),updated_at=now() WHERE id=$1 AND status IN ('queued','processing')`, jobID, message)
}
