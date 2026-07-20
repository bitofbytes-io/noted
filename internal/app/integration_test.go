package app

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/bitofbytes-io/noted/internal/assets"
	"github.com/bitofbytes-io/noted/internal/config"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/joho/godotenv"
)

type fixtureRecognizer struct{}

func (fixtureRecognizer) Recognize(_ context.Context, _ string, outputDirectory string) (RecognitionOutput, error) {
	source, err := os.Open("../../testdata/fixtures/noted-exercise.musicxml")
	if err != nil {
		return RecognitionOutput{}, err
	}
	defer source.Close()
	path := filepath.Join(outputDirectory, "converted.musicxml")
	output, err := os.Create(path)
	if err != nil {
		return RecognitionOutput{}, err
	}
	if _, err := io.Copy(output, source); err != nil {
		_ = output.Close()
		return RecognitionOutput{}, err
	}
	if err := output.Close(); err != nil {
		return RecognitionOutput{}, err
	}
	report := fixtureOMRReport()
	return RecognitionOutput{Path: path, Engine: "audiveris+homr", EngineVersion: "test", Report: &report}, nil
}

func fixtureOMRReport() OMRQualityReport {
	measures := make([]OMRMeasureQuality, 8)
	for index := range measures {
		measures[index] = OMRMeasureQuality{
			PartID: "P1", Number: fmt.Sprint(index + 1), MeasureIndex: index + 1,
			SourceEngine: "audiveris", Agreement: true, Confidence: "high", Issues: []string{},
		}
	}
	measures[2].Agreement = false
	measures[2].Confidence = "medium"
	measures[2].Corrected = true
	measures[2].SourceEngine = "homr"
	measures[2].Issues = []string{"duration_repaired"}
	measures[6].Agreement = false
	measures[6].Confidence = "low"
	measures[6].Issues = []string{"engine_disagreement"}
	return OMRQualityReport{
		SchemaVersion: 1, TotalMeasures: 8, FlaggedMeasures: 2, CorrectedMeasures: 1,
		SuspectMeasures: 2, SelectedEngine: "fusion",
		Engines: map[string]json.RawMessage{
			"audiveris": json.RawMessage(`{"status":"passed"}`),
			"homr":      json.RawMessage(`{"status":"passed"}`),
		},
		Measures:    measures,
		Playability: OMRPlayability{Status: "passed", MeasureCount: 8, TotalTicks: 30720},
	}
}

type fixtureProjectRecognizer struct{}

func (fixtureProjectRecognizer) Recognize(ctx context.Context, inputPath, outputDirectory string) (RecognitionOutput, error) {
	result, err := (fixtureRecognizer{}).Recognize(ctx, inputPath, outputDirectory)
	if err != nil {
		return RecognitionOutput{}, err
	}
	projectPath := filepath.Join(outputDirectory, "converted.omr")
	project, err := os.Create(projectPath)
	if err != nil {
		return RecognitionOutput{}, err
	}
	archive := zip.NewWriter(project)
	book, err := archive.Create("book.xml")
	if err == nil {
		_, err = io.WriteString(book, `<book version="5.10.2"/>`)
	}
	if closeErr := archive.Close(); err == nil {
		err = closeErr
	}
	if closeErr := project.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return RecognitionOutput{}, err
	}
	result.ProjectPath = projectPath
	return result, nil
}

type countingFixtureRecognizer struct{ calls *atomic.Int32 }

func (r countingFixtureRecognizer) Recognize(ctx context.Context, inputPath, outputDirectory string) (RecognitionOutput, error) {
	r.calls.Add(1)
	return (fixtureRecognizer{}).Recognize(ctx, inputPath, outputDirectory)
}

type integrationFixture struct {
	UserID     string
	WorkID     string
	MovementID string
	EditionID  string
	AssetID    string
	StorageKey string
}

func createIntegrationFixture(t *testing.T, service *Service) integrationFixture {
	t.Helper()
	ctx := context.Background()
	fixture := integrationFixture{
		UserID:     uuid.NewString(),
		WorkID:     uuid.NewString(),
		MovementID: uuid.NewString(),
		EditionID:  uuid.NewString(),
		AssetID:    uuid.NewString(),
		StorageKey: "pdf/" + uuid.NewString(),
	}
	composerID := uuid.NewString()
	statements := []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users(id,email,display_name) VALUES($1,$2,'Integration learner')`, []any{fixture.UserID, fixture.UserID + "@example.test"}},
		{`INSERT INTO composers(id,canonical_name,sort_name) VALUES($1,'Integration Composer','Integration Composer')`, []any{composerID}},
		{`INSERT INTO works(id,composer_id,title,created_by_user_id) VALUES($1,$2,'Integration work',$3)`, []any{fixture.WorkID, composerID, fixture.UserID}},
		{`INSERT INTO movements(id,work_id,sequence_number,title,measure_count) VALUES($1,$2,1,'Integration movement',8)`, []any{fixture.MovementID, fixture.WorkID}},
		{`INSERT INTO editions(id,work_id,name,created_by_user_id) VALUES($1,$2,'Integration edition',$3)`, []any{fixture.EditionID, fixture.WorkID, fixture.UserID}},
		{`INSERT INTO learner_works(user_id,work_id) VALUES($1,$2)`, []any{fixture.UserID, fixture.WorkID}},
		{`INSERT INTO score_assets(id,edition_id,asset_type,storage_key,original_filename,media_type,byte_size,sha256,rights_note,uploaded_by_user_id) VALUES($1,$2,'pdf',$3,'integration.pdf','application/pdf',8,$4,'CC0',$5)`, []any{fixture.AssetID, fixture.EditionID, fixture.StorageKey, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", fixture.UserID}},
	}
	for _, statement := range statements {
		if _, err := service.Pool.Exec(ctx, statement.sql, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		_, _ = service.Pool.Exec(ctx, `DELETE FROM works WHERE id=$1`, fixture.WorkID)
		_, _ = service.Pool.Exec(ctx, `DELETE FROM composers WHERE id=$1`, composerID)
		_, _ = service.Pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, fixture.UserID)
	})
	return fixture
}

type failingDeleteStore struct {
	assets.AssetStore
}

func (failingDeleteStore) Delete(context.Context, string) error {
	return errors.New("simulated storage cleanup failure")
}

func integrationService(t *testing.T) (*Service, User, string) {
	t.Helper()
	if os.Getenv("NOTED_INTEGRATION") != "1" {
		t.Skip("set NOTED_INTEGRATION=1 with local PostgreSQL running")
	}
	_ = godotenv.Load("../../.env")
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	pool, err := pgxpool.New(context.Background(), cfg.DatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	root := t.TempDir()
	store, err := assets.NewFilesystemStore(root)
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(pool, store)
	user, err := service.CurrentUser(context.Background(), cfg.DevUserEmail)
	if err != nil {
		t.Fatalf("seed the development learner before integration tests: %v", err)
	}
	return service, user, root
}

func TestIntegrationOwnershipScoping(t *testing.T) {
	service, current, _ := integrationService(t)
	ctx := context.Background()
	otherUser := uuid.NewString()
	composer := uuid.NewString()
	work := uuid.NewString()
	edition := uuid.NewString()
	asset := uuid.NewString()
	key := "pdf/" + uuid.NewString()
	statements := []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users(id,email,display_name) VALUES($1,$2,'Other learner')`, []any{otherUser, otherUser + "@example.test"}},
		{`INSERT INTO composers(id,canonical_name,sort_name) VALUES($1,'Private Composer','Private Composer')`, []any{composer}},
		{`INSERT INTO works(id,composer_id,title,created_by_user_id) VALUES($1,$2,'Other learner work',$3)`, []any{work, composer, otherUser}},
		{`INSERT INTO learner_works(user_id,work_id) VALUES($1,$2)`, []any{otherUser, work}},
		{`INSERT INTO editions(id,work_id,name,created_by_user_id) VALUES($1,$2,'Private edition',$3)`, []any{edition, work, otherUser}},
		{`INSERT INTO score_assets(id,edition_id,asset_type,storage_key,original_filename,media_type,byte_size,sha256,rights_note,uploaded_by_user_id) VALUES($1,$2,'pdf',$3,'private.pdf','application/pdf',8,$4,'private',$5)`, []any{asset, edition, key, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", otherUser}},
	}
	for _, statement := range statements {
		if _, err := service.Pool.Exec(ctx, statement.sql, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		_, _ = service.Pool.Exec(ctx, `DELETE FROM works WHERE id=$1`, work)
		_, _ = service.Pool.Exec(ctx, `DELETE FROM composers WHERE id=$1`, composer)
		_, _ = service.Pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, otherUser)
	})

	if _, err := service.GetWork(ctx, current.ID, work); !errors.Is(err, ErrNotFound) {
		t.Fatalf("other learner's work must be hidden, got %v", err)
	}
	if _, err := service.GetAsset(ctx, current.ID, asset); !errors.Is(err, ErrNotFound) {
		t.Fatalf("other learner's asset must be hidden, got %v", err)
	}
	if _, err := service.UpdateLearnerState(ctx, current.ID, work, LearnerStateInput{Status: "Learning"}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("other learner's state must not be mutable, got %v", err)
	}
	if _, err := service.CreateManualPractice(ctx, current.ID, PracticeInput{WorkID: work, DurationSeconds: 60}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("other learner's work must not accept practice, got %v", err)
	}
}

func TestIntegrationPlaybackMediaAnchorsAndMeasureMap(t *testing.T) {
	service, _, _ := integrationService(t)
	fixture := createIntegrationFixture(t, service)
	ctx := context.Background()

	link, err := service.CreateMediaLink(ctx, fixture.UserID, fixture.EditionID, MediaLinkInput{
		URL: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", Title: "Practice recording",
	})
	if err != nil {
		t.Fatal(err)
	}
	if link.VideoID != "dQw4w9WgXcQ" || link.AnchorCount != 0 {
		t.Fatalf("media link = %+v", link)
	}
	anchors, err := service.ReplaceMediaLinkAnchors(ctx, fixture.UserID, link.ID, []AnchorInput{
		{MeasureNumber: 8, PositionMS: 42_000}, {MeasureNumber: 1, PositionMS: 2_000},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(anchors) != 2 || anchors[0].MeasureNumber != 1 || anchors[1].MeasureNumber != 8 {
		t.Fatalf("media anchors = %+v", anchors)
	}
	assetAnchors, err := service.ReplaceAssetAnchors(ctx, fixture.UserID, fixture.AssetID, []AnchorInput{{MeasureNumber: 3, PositionMS: 12_500}})
	if err != nil || len(assetAnchors) != 1 {
		t.Fatalf("asset anchors = %+v, %v", assetAnchors, err)
	}
	if _, err := service.Pool.Exec(ctx, `
		INSERT INTO measure_maps(asset_id,user_id,status,pages,engine_version)
		VALUES($1,$2,'ready',$3,'audiveris-5.10.2-measures')`, fixture.AssetID, fixture.UserID,
		`[{"pageNumber":1,"width":2550,"height":3300,"dpi":300,"measures":[{"measureNumber":1,"x":100,"y":200,"width":500,"height":250}]}]`); err != nil {
		t.Fatal(err)
	}
	measureMap, err := service.GetMeasureMap(ctx, fixture.UserID, fixture.AssetID)
	if err != nil || measureMap.Status != "ready" || len(measureMap.Pages) != 1 || len(measureMap.Pages[0].Measures) != 1 {
		t.Fatalf("measure map = %+v, %v", measureMap, err)
	}
	links, err := service.ListMediaLinks(ctx, fixture.UserID, fixture.EditionID)
	if err != nil || len(links) != 1 || links[0].AnchorCount != 2 {
		t.Fatalf("media links = %+v, %v", links, err)
	}
	if err := service.DeleteMediaLink(ctx, fixture.UserID, link.ID); err != nil {
		t.Fatal(err)
	}
	if remaining, err := service.ListMediaLinkAnchors(ctx, fixture.UserID, link.ID); !errors.Is(err, ErrNotFound) || remaining != nil {
		t.Fatalf("deleted media link anchors = %+v, %v", remaining, err)
	}
}

func TestIntegrationCreateWorkReusesSharedCatalogIdentity(t *testing.T) {
	service, current, _ := integrationService(t)
	fixture := createIntegrationFixture(t, service)
	ctx := context.Background()
	composerName := "Shared Composer " + uuid.NewString()
	if _, err := service.Pool.Exec(ctx, `UPDATE composers SET canonical_name=$2,sort_name=$2 WHERE id=(SELECT composer_id FROM works WHERE id=$1)`, fixture.WorkID, composerName); err != nil {
		t.Fatal(err)
	}

	created, err := service.CreateWork(ctx, current.ID, CreateWorkInput{
		Title: "Integration work", Composer: composerName,
		EditionName: "Current learner edition", RightsNote: "Current learner copy",
	})
	if err != nil {
		t.Fatal(err)
	}
	if created.ID != fixture.WorkID {
		t.Fatalf("create work made duplicate shared identity %s, want %s", created.ID, fixture.WorkID)
	}
	var workCount, learnerCount, editionCount int
	if err := service.Pool.QueryRow(ctx, `SELECT count(*) FROM works WHERE composer_id=(SELECT composer_id FROM works WHERE id=$1) AND title='Integration work' AND catalog_number IS NULL`, fixture.WorkID).Scan(&workCount); err != nil {
		t.Fatal(err)
	}
	if err := service.Pool.QueryRow(ctx, `SELECT count(*) FROM learner_works WHERE user_id=$1 AND work_id=$2`, current.ID, fixture.WorkID).Scan(&learnerCount); err != nil {
		t.Fatal(err)
	}
	if err := service.Pool.QueryRow(ctx, `SELECT count(*) FROM editions WHERE work_id=$1 AND created_by_user_id=$2 AND name='Current learner edition'`, fixture.WorkID, current.ID).Scan(&editionCount); err != nil {
		t.Fatal(err)
	}
	if workCount != 1 || learnerCount != 1 || editionCount != 1 {
		t.Fatalf("shared work reuse counts = work:%d learner:%d edition:%d", workCount, learnerCount, editionCount)
	}
}

func TestIntegrationDatabaseRejectsDuplicateCataloglessWorkIdentity(t *testing.T) {
	service, current, _ := integrationService(t)
	fixture := createIntegrationFixture(t, service)
	ctx := context.Background()
	var composerID string
	if err := service.Pool.QueryRow(ctx, `SELECT composer_id::text FROM works WHERE id=$1`, fixture.WorkID).Scan(&composerID); err != nil {
		t.Fatal(err)
	}
	_, err := service.Pool.Exec(ctx, `
		INSERT INTO works(composer_id,title,catalog_number,created_by_user_id)
		VALUES($1,'Integration work',NULL,$2)`, composerID, current.ID)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.ConstraintName != "works_composer_id_title_catalog_number_key" {
		t.Fatalf("duplicate catalogless work error = %v, want unique constraint", err)
	}
}

func TestIntegrationMalformedResourceIDsReturnClientErrors(t *testing.T) {
	service, current, _ := integrationService(t)
	ctx := context.Background()
	malformed := "not-a-uuid"
	checks := map[string]func() error{
		"get work": func() error {
			_, err := service.GetWork(ctx, current.ID, malformed)
			return err
		},
		"update learner state": func() error {
			_, err := service.UpdateLearnerState(ctx, current.ID, malformed, LearnerStateInput{Status: "Learning"})
			return err
		},
		"add edition": func() error {
			_, err := service.AddEdition(ctx, current.ID, malformed, EditionInput{Name: "Edition"})
			return err
		},
		"add movement": func() error {
			_, err := service.AddMovement(ctx, current.ID, malformed, MovementInput{SequenceNumber: 1, Title: "Movement"})
			return err
		},
		"upload asset": func() error {
			_, err := service.UploadAsset(ctx, current.ID, malformed, nil, nil, UploadMetadata{RightsNote: "CC0"})
			return err
		},
		"list edition assets": func() error {
			_, err := service.ListEditionAssets(ctx, current.ID, malformed)
			return err
		},
		"get asset": func() error {
			_, err := service.GetAsset(ctx, current.ID, malformed)
			return err
		},
		"start practice": func() error {
			_, err := service.StartPractice(ctx, current.ID, PracticeInput{WorkID: malformed})
			return err
		},
		"create practice": func() error {
			_, err := service.CreateManualPractice(ctx, current.ID, PracticeInput{WorkID: malformed, DurationSeconds: 60})
			return err
		},
		"stop practice": func() error {
			_, err := service.StopPractice(ctx, current.ID, malformed, StopPracticeInput{})
			return err
		},
		"get practice": func() error {
			_, err := service.GetPracticeSession(ctx, current.ID, malformed)
			return err
		},
		"delete practice": func() error {
			return service.DeletePractice(ctx, current.ID, malformed)
		},
		"replace tags": func() error {
			_, err := service.ReplaceWorkTags(ctx, current.ID, malformed, nil)
			return err
		},
	}
	for name, check := range checks {
		t.Run(name, func(t *testing.T) {
			if err := check(); !errors.Is(err, ErrNotFound) {
				t.Fatalf("malformed resource ID error = %v, want ErrNotFound", err)
			}
		})
	}
}

func TestIntegrationReplaceWorkTagsReturnsSelectedIDs(t *testing.T) {
	service, _, _ := integrationService(t)
	fixture := createIntegrationFixture(t, service)
	ctx := context.Background()
	first, err := service.CreateTag(ctx, fixture.UserID, "Focus")
	if err != nil {
		t.Fatal(err)
	}
	second, err := service.CreateTag(ctx, fixture.UserID, "Recital")
	if err != nil {
		t.Fatal(err)
	}
	items, err := service.ReplaceWorkTags(ctx, fixture.UserID, fixture.WorkID, []string{second.ID, first.ID})
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 || items[0].ID != first.ID || items[0].Name != first.Name || items[1].ID != second.ID || items[1].Name != second.Name {
		t.Fatalf("replace tags response lost selected identities: %+v", items)
	}
}

func TestIntegrationAddMovementRejectsNonPositiveMeasureCount(t *testing.T) {
	service, _, _ := integrationService(t)
	fixture := createIntegrationFixture(t, service)
	ctx := context.Background()
	measureCount := 0
	_, err := service.AddMovement(ctx, fixture.UserID, fixture.WorkID, MovementInput{
		SequenceNumber: 2, Title: "Invalid movement", MeasureCount: &measureCount,
	})
	var validation ValidationError
	if !errors.As(err, &validation) || validation.Fields["measureCount"] == "" {
		t.Fatalf("invalid measure count error = %v, want measureCount validation", err)
	}
	var count int
	if err := service.Pool.QueryRow(ctx, `SELECT count(*) FROM movements WHERE work_id=$1 AND sequence_number=2`, fixture.WorkID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatal("invalid movement was inserted")
	}
}

func TestIntegrationUploadCleanupOnMetadataFailure(t *testing.T) {
	service, current, root := integrationService(t)
	path := filepath.Join(t.TempDir(), "exercise.pdf")
	if err := os.WriteFile(path, []byte("%PDF-1.4\nfixture"), 0o600); err != nil {
		t.Fatal(err)
	}
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	header := &multipart.FileHeader{Filename: "../../exercise.pdf", Size: 16}
	_, err = service.UploadAsset(context.Background(), current.ID, uuid.NewString(), header, file, UploadMetadata{RightsNote: "CC0"})
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected missing edition failure, got %v", err)
	}

	for _, kind := range []string{"pdf", "musicxml"} {
		entries, err := os.ReadDir(filepath.Join(root, "originals", kind))
		if err != nil {
			t.Fatal(err)
		}
		if len(entries) != 0 {
			t.Fatalf("metadata failure left %d %s object(s)", len(entries), kind)
		}
	}
}

func TestIntegrationUploadMIDIPlaybackAsset(t *testing.T) {
	service, _, _ := integrationService(t)
	fixture := createIntegrationFixture(t, service)
	path := filepath.Join(t.TempDir(), "practice.mid")
	midi := []byte{
		'M', 'T', 'h', 'd', 0, 0, 0, 6, 0, 0, 0, 1, 0, 96,
		'M', 'T', 'r', 'k', 0, 0, 0, 15,
		0, 0xc0, 0, 0, 0x90, 60, 64, 96, 0x80, 60, 64, 0, 0xff, 0x2f, 0,
	}
	if err := os.WriteFile(path, midi, 0o600); err != nil {
		t.Fatal(err)
	}
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()

	asset, err := service.UploadAsset(
		context.Background(), fixture.UserID, fixture.EditionID,
		&multipart.FileHeader{Filename: "practice.mid", Size: int64(len(midi))}, file,
		UploadMetadata{RightsNote: "Original CC0 MIDI fixture"},
	)
	if err != nil {
		t.Fatal(err)
	}
	if asset.AssetType != "midi" || !asset.PlaybackCapable || asset.MediaType != "audio/midi" {
		t.Fatalf("MIDI asset = %+v", asset)
	}
}

func TestIntegrationPracticeWeekAggregatesByUTCDate(t *testing.T) {
	service, current, _ := integrationService(t)
	ctx := context.Background()
	workID := "10000000-0000-4000-8000-000000000003"
	monday := time.Date(2035, time.May, 7, 9, 0, 0, 0, time.UTC)
	tuesday := monday.Add(24 * time.Hour)

	first, err := service.CreateManualPractice(ctx, current.ID, PracticeInput{
		WorkID: workID, StartedAt: &monday, DurationSeconds: 600, Notes: "integration aggregation",
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := service.CreateManualPractice(ctx, current.ID, PracticeInput{
		WorkID: workID, StartedAt: &tuesday, DurationSeconds: 900, Notes: "integration aggregation",
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = service.Pool.Exec(ctx, `DELETE FROM practice_sessions WHERE id = ANY($1::uuid[])`, []string{first.ID, second.ID})
	})

	summary, err := service.PracticeWeek(ctx, current.ID, monday.Add(48*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if summary.StartsOn != "2035-05-07" || summary.TotalSeconds != 1500 || summary.SessionCount != 2 {
		t.Fatalf("unexpected weekly summary: %+v", summary)
	}
	if len(summary.Days) != 7 || summary.Days[0].DurationSeconds != 600 || summary.Days[0].SessionCount != 1 ||
		summary.Days[1].DurationSeconds != 900 || summary.Days[1].SessionCount != 1 {
		t.Fatalf("unexpected daily aggregation: %+v", summary.Days)
	}
}

func TestIntegrationStopPracticePreservesTimerContext(t *testing.T) {
	service, _, _ := integrationService(t)
	fixture := createIntegrationFixture(t, service)
	ctx := context.Background()
	startMeasure, endMeasure, startingBPM := 2, 6, 84
	session, err := service.StartPractice(ctx, fixture.UserID, PracticeInput{
		WorkID: fixture.WorkID, MovementID: &fixture.MovementID, ScoreAssetID: &fixture.AssetID,
		StartMeasure: &startMeasure, EndMeasure: &endMeasure, HandPart: "Right hand", StartingBPM: &startingBPM,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Pool.Exec(ctx, `UPDATE practice_sessions SET started_at=now()-interval '2 minutes' WHERE id=$1`, session.ID); err != nil {
		t.Fatal(err)
	}

	stopped, err := service.StopPractice(ctx, fixture.UserID, session.ID, StopPracticeInput{Notes: "finished cleanly"})
	if err != nil {
		t.Fatal(err)
	}
	if stopped.MovementID == nil || *stopped.MovementID != fixture.MovementID || stopped.ScoreAssetID == nil || *stopped.ScoreAssetID != fixture.AssetID {
		t.Fatalf("timer associations were not preserved: %+v", stopped)
	}
	if stopped.StartMeasure == nil || *stopped.StartMeasure != startMeasure || stopped.EndMeasure == nil || *stopped.EndMeasure != endMeasure || stopped.StartingBPM == nil || *stopped.StartingBPM != startingBPM {
		t.Fatalf("timer range or tempo was not preserved: %+v", stopped)
	}
	if stopped.HandPart != "Right hand" || stopped.Notes != "finished cleanly" {
		t.Fatalf("timer details were not merged: %+v", stopped)
	}
}

func TestIntegrationStopPracticeCapsAndClosesStaleTimer(t *testing.T) {
	service, _, _ := integrationService(t)
	fixture := createIntegrationFixture(t, service)
	ctx := context.Background()
	session, err := service.StartPractice(ctx, fixture.UserID, PracticeInput{WorkID: fixture.WorkID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Pool.Exec(ctx, `UPDATE practice_sessions SET started_at=now()-interval '25 hours' WHERE id=$1`, session.ID); err != nil {
		t.Fatal(err)
	}
	stopped, err := service.StopPractice(ctx, fixture.UserID, session.ID, StopPracticeInput{Notes: "Recovered stale timer"})
	if err != nil {
		t.Fatal(err)
	}
	if stopped.EndedAt == nil || stopped.DurationSeconds != 86400 {
		t.Fatalf("stale timer was not capped and closed: %+v", stopped)
	}
	if _, err := service.StartPractice(ctx, fixture.UserID, PracticeInput{WorkID: fixture.WorkID}); err != nil {
		t.Fatalf("closed stale timer still blocked a new timer: %v", err)
	}
}

func TestIntegrationStartPracticeRejectsInvalidOptionalContext(t *testing.T) {
	service, _, _ := integrationService(t)
	fixture := createIntegrationFixture(t, service)
	ctx := context.Background()
	startMeasure, endMeasure, startingBPM := 4, 2, 20
	_, err := service.StartPractice(ctx, fixture.UserID, PracticeInput{
		WorkID: fixture.WorkID, StartMeasure: &startMeasure, EndMeasure: &endMeasure, StartingBPM: &startingBPM,
	})
	var validation ValidationError
	if !errors.As(err, &validation) {
		t.Fatalf("invalid timer context error = %v, want ValidationError", err)
	}
	if validation.Fields["endMeasure"] == "" || validation.Fields["startingBpm"] == "" {
		t.Fatalf("timer validation did not report range and BPM fields: %+v", validation.Fields)
	}
	var running int
	if err := service.Pool.QueryRow(ctx, `SELECT count(*) FROM practice_sessions WHERE user_id=$1 AND ended_at IS NULL`, fixture.UserID).Scan(&running); err != nil {
		t.Fatal(err)
	}
	if running != 0 {
		t.Fatalf("invalid timer context created %d running sessions", running)
	}
}

func TestIntegrationPracticePatchPreservesOmittedFieldsAndClearsNulls(t *testing.T) {
	service, _, _ := integrationService(t)
	fixture := createIntegrationFixture(t, service)
	ctx := context.Background()
	started := time.Date(2032, time.January, 12, 14, 30, 0, 0, time.UTC)
	startMeasure, endMeasure, startingBPM := 1, 8, 72
	session, err := service.CreateManualPractice(ctx, fixture.UserID, PracticeInput{
		WorkID: fixture.WorkID, MovementID: &fixture.MovementID, ScoreAssetID: &fixture.AssetID, StartedAt: &started,
		DurationSeconds: 600, StartMeasure: &startMeasure, EndMeasure: &endMeasure, HandPart: "Both", StartingBPM: &startingBPM,
	})
	if err != nil {
		t.Fatal(err)
	}

	var patch PracticePatchInput
	if err := json.Unmarshal([]byte(`{"durationSeconds":900,"notes":"corrected notes"}`), &patch); err != nil {
		t.Fatal(err)
	}
	updated, err := service.UpdatePractice(ctx, fixture.UserID, session.ID, patch)
	if err != nil {
		t.Fatal(err)
	}
	if !updated.StartedAt.Equal(started) || updated.DurationSeconds != 900 || updated.EndedAt == nil || !updated.EndedAt.Equal(started.Add(15*time.Minute)) {
		t.Fatalf("patch changed historical timing incorrectly: %+v", updated)
	}
	if updated.MovementID == nil || *updated.MovementID != fixture.MovementID || updated.ScoreAssetID == nil || *updated.ScoreAssetID != fixture.AssetID || updated.Notes != "corrected notes" {
		t.Fatalf("patch did not preserve omitted context: %+v", updated)
	}

	patch = PracticePatchInput{}
	if err := json.Unmarshal([]byte(`{"startMeasure":null,"endMeasure":null,"startingBpm":null}`), &patch); err != nil {
		t.Fatal(err)
	}
	cleared, err := service.UpdatePractice(ctx, fixture.UserID, session.ID, patch)
	if err != nil {
		t.Fatal(err)
	}
	if cleared.StartMeasure != nil || cleared.EndMeasure != nil || cleared.StartingBPM != nil {
		t.Fatalf("explicit null did not clear nullable fields: %+v", cleared)
	}
}

func TestIntegrationArchivedScoresCannotEnterNewPracticeHistory(t *testing.T) {
	service, _, _ := integrationService(t)
	fixture := createIntegrationFixture(t, service)
	ctx := context.Background()
	session, err := service.CreateManualPractice(ctx, fixture.UserID, PracticeInput{
		WorkID: fixture.WorkID, ScoreAssetID: &fixture.AssetID, DurationSeconds: 60,
	})
	if err != nil {
		t.Fatal(err)
	}
	archived := true
	if _, err := service.UpdateAsset(ctx, fixture.UserID, fixture.AssetID, AssetPatchInput{Archived: &archived}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.CreateManualPractice(ctx, fixture.UserID, PracticeInput{
		WorkID: fixture.WorkID, ScoreAssetID: &fixture.AssetID, DurationSeconds: 60,
	}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("new practice with archived score error = %v, want ErrNotFound", err)
	}
	var patch PracticePatchInput
	if err := json.Unmarshal([]byte(`{"notes":"historical correction"}`), &patch); err != nil {
		t.Fatal(err)
	}
	updated, err := service.UpdatePractice(ctx, fixture.UserID, session.ID, patch)
	if err != nil {
		t.Fatalf("historical practice correction with archived score: %v", err)
	}
	if updated.ScoreAssetID == nil || *updated.ScoreAssetID != fixture.AssetID {
		t.Fatalf("historical score context was not retained: %+v", updated)
	}
}

func TestIntegrationPracticeRangesRespectMovementLength(t *testing.T) {
	service, _, _ := integrationService(t)
	fixture := createIntegrationFixture(t, service)
	ctx := context.Background()
	start, validEnd, invalidEnd := 1, 8, 9
	assertRangeError := func(label string, err error) {
		t.Helper()
		var validation ValidationError
		if !errors.As(err, &validation) || validation.Fields["endMeasure"] == "" {
			t.Fatalf("%s error = %v, want movement-length endMeasure validation", label, err)
		}
	}

	_, err := service.CreateManualPractice(ctx, fixture.UserID, PracticeInput{
		WorkID: fixture.WorkID, MovementID: &fixture.MovementID, DurationSeconds: 60,
		StartMeasure: &start, EndMeasure: &invalidEnd,
	})
	assertRangeError("manual entry", err)
	_, err = service.CreateManualPractice(ctx, fixture.UserID, PracticeInput{
		WorkID: fixture.WorkID, MovementID: &fixture.MovementID, DurationSeconds: 60,
		StartMeasure: &invalidEnd,
	})
	var validation ValidationError
	if !errors.As(err, &validation) || validation.Fields["startMeasure"] == "" {
		t.Fatalf("start-only range error = %v, want movement-length startMeasure validation", err)
	}

	_, err = service.StartPractice(ctx, fixture.UserID, PracticeInput{
		WorkID: fixture.WorkID, MovementID: &fixture.MovementID,
		StartMeasure: &start, EndMeasure: &invalidEnd,
	})
	assertRangeError("timer start", err)

	running, err := service.StartPractice(ctx, fixture.UserID, PracticeInput{
		WorkID: fixture.WorkID, MovementID: &fixture.MovementID,
		StartMeasure: &start, EndMeasure: &validEnd,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.StopPractice(ctx, fixture.UserID, running.ID, StopPracticeInput{EndMeasure: &invalidEnd})
	assertRangeError("timer stop", err)
	retained, err := service.GetPracticeSession(ctx, fixture.UserID, running.ID)
	if err != nil {
		t.Fatal(err)
	}
	if retained.EndedAt != nil || retained.EndMeasure == nil || *retained.EndMeasure != validEnd {
		t.Fatalf("rejected timer stop changed the running session: %+v", retained)
	}
	if err := service.DeletePractice(ctx, fixture.UserID, running.ID); err != nil {
		t.Fatal(err)
	}

	completed, err := service.CreateManualPractice(ctx, fixture.UserID, PracticeInput{
		WorkID: fixture.WorkID, MovementID: &fixture.MovementID, DurationSeconds: 60,
		StartMeasure: &start, EndMeasure: &validEnd,
	})
	if err != nil {
		t.Fatal(err)
	}
	var patch PracticePatchInput
	if err := json.Unmarshal([]byte(`{"endMeasure":9}`), &patch); err != nil {
		t.Fatal(err)
	}
	_, err = service.UpdatePractice(ctx, fixture.UserID, completed.ID, patch)
	assertRangeError("practice correction", err)
	retained, err = service.GetPracticeSession(ctx, fixture.UserID, completed.ID)
	if err != nil {
		t.Fatal(err)
	}
	if retained.EndMeasure == nil || *retained.EndMeasure != validEnd {
		t.Fatalf("rejected correction changed the saved range: %+v", retained)
	}
}

func TestIntegrationSharedWorkDoesNotShareUploadedAssets(t *testing.T) {
	service, current, _ := integrationService(t)
	fixture := createIntegrationFixture(t, service)
	ctx := context.Background()
	if _, err := service.Pool.Exec(ctx, `INSERT INTO learner_works(user_id,work_id) VALUES($1,$2)`, current.ID, fixture.WorkID); err != nil {
		t.Fatal(err)
	}

	if _, err := service.GetAsset(ctx, current.ID, fixture.AssetID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("shared work exposed another uploader's asset metadata: %v", err)
	}
	if err := service.DeleteAsset(ctx, current.ID, fixture.AssetID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("shared work allowed another uploader's asset deletion: %v", err)
	}
	assets, err := service.ListEditionAssets(ctx, current.ID, fixture.EditionID)
	if err != nil {
		t.Fatal(err)
	}
	if len(assets) != 0 {
		t.Fatalf("shared work listed another uploader's assets: %+v", assets)
	}
	detail, err := service.GetWork(ctx, current.ID, fixture.WorkID)
	if err != nil {
		t.Fatal(err)
	}
	if len(detail.Editions) != 1 || len(detail.Editions[0].Assets) != 0 {
		t.Fatalf("work details exposed another uploader's assets: %+v", detail.Editions)
	}
	works, err := service.ListWorks(ctx, current.ID, WorkFilters{})
	if err != nil {
		t.Fatal(err)
	}
	for _, work := range works {
		if work.ID == fixture.WorkID && (work.HasPDF || work.HasPlayback) {
			t.Fatalf("private assets leaked into work capabilities: %+v", work)
		}
	}
	recent, err := service.recentImports(ctx, current.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, asset := range recent {
		if asset.ID == fixture.AssetID {
			t.Fatalf("private asset leaked into recent imports: %+v", asset)
		}
	}
	if _, err := service.CreateManualPractice(ctx, current.ID, PracticeInput{WorkID: fixture.WorkID, ScoreAssetID: &fixture.AssetID, DurationSeconds: 60}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("private asset could be associated with another learner's practice: %v", err)
	}
}

func TestIntegrationDeleteAssetRemovesMetadataBeforeBestEffortStorageCleanup(t *testing.T) {
	service, _, _ := integrationService(t)
	fixture := createIntegrationFixture(t, service)
	ctx := context.Background()
	store := service.Store
	if _, err := store.Put(ctx, fixture.StorageKey, bytes.NewBufferString("%PDF-1.4")); err != nil {
		t.Fatal(err)
	}
	service.Store = failingDeleteStore{AssetStore: store}

	if err := service.DeleteAsset(ctx, fixture.UserID, fixture.AssetID); err != nil {
		t.Fatalf("best-effort storage cleanup must not undo metadata deletion: %v", err)
	}
	if _, err := service.GetAsset(ctx, fixture.UserID, fixture.AssetID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("asset metadata remained visible after deletion: %v", err)
	}
	exists, err := store.Exists(ctx, fixture.StorageKey)
	if err != nil {
		t.Fatal(err)
	}
	if !exists {
		t.Fatal("simulated storage cleanup failure did not preserve the orphan for recovery")
	}
}

func TestIntegrationDeleteAssetPreservesReferencedPracticeHistory(t *testing.T) {
	service, _, _ := integrationService(t)
	fixture := createIntegrationFixture(t, service)
	ctx := context.Background()
	if _, err := service.Store.Put(ctx, fixture.StorageKey, bytes.NewBufferString("%PDF-1.4")); err != nil {
		t.Fatal(err)
	}
	session, err := service.CreateManualPractice(ctx, fixture.UserID, PracticeInput{
		WorkID: fixture.WorkID, ScoreAssetID: &fixture.AssetID, DurationSeconds: 60,
	})
	if err != nil {
		t.Fatal(err)
	}

	if err := service.DeleteAsset(ctx, fixture.UserID, fixture.AssetID); !errors.Is(err, ErrAssetInUse) {
		t.Fatalf("referenced asset deletion error = %v, want ErrAssetInUse", err)
	}
	if _, err := service.GetAsset(ctx, fixture.UserID, fixture.AssetID); err != nil {
		t.Fatalf("referenced asset metadata was removed: %v", err)
	}
	exists, err := service.Store.Exists(ctx, fixture.StorageKey)
	if err != nil {
		t.Fatal(err)
	}
	if !exists {
		t.Fatal("referenced asset file was removed")
	}
	retained, err := service.GetPracticeSession(ctx, fixture.UserID, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if retained.ScoreAssetID == nil || *retained.ScoreAssetID != fixture.AssetID {
		t.Fatalf("practice asset context was not retained: %+v", retained)
	}

	if err := service.DeletePractice(ctx, fixture.UserID, session.ID); err != nil {
		t.Fatal(err)
	}
	if err := service.DeleteAsset(ctx, fixture.UserID, fixture.AssetID); err != nil {
		t.Fatalf("unreferenced asset could not be deleted: %v", err)
	}
}

func TestIntegrationLibraryManagementUpdatesArchivesAndDeletes(t *testing.T) {
	service, _, _ := integrationService(t)
	fixture := createIntegrationFixture(t, service)
	ctx := context.Background()

	name := "My clean score"
	rights := "Personal licensed copy"
	archived := true
	asset, err := service.UpdateAsset(ctx, fixture.UserID, fixture.AssetID, AssetPatchInput{
		DisplayName: &name, RightsNote: &rights, Archived: &archived,
	})
	if err != nil {
		t.Fatal(err)
	}
	if asset.DisplayName != name || asset.RightsNote != rights || asset.ArchivedAt == nil {
		t.Fatalf("asset update = %+v", asset)
	}

	work, err := service.UpdateWork(ctx, fixture.UserID, fixture.WorkID, WorkPatchInput{
		Title: "Updated integration work", Composer: "Integration Composer", Subtitle: "Revised",
	})
	if err != nil {
		t.Fatal(err)
	}
	if work.Title != "Updated integration work" || work.Subtitle != "Revised" {
		t.Fatalf("work update = %+v", work)
	}
	if err := service.DeleteWork(ctx, fixture.UserID, fixture.WorkID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.GetWork(ctx, fixture.UserID, fixture.WorkID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted work lookup = %v", err)
	}
}

func TestIntegrationWorkUpdateRejectsDuplicateIdentity(t *testing.T) {
	service, _, _ := integrationService(t)
	fixture := createIntegrationFixture(t, service)
	ctx := context.Background()
	secondID := uuid.NewString()
	var composerName string
	if err := service.Pool.QueryRow(ctx, `SELECT c.canonical_name FROM works w JOIN composers c ON c.id=w.composer_id WHERE w.id=$1`, fixture.WorkID).Scan(&composerName); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Pool.Exec(ctx, `
		INSERT INTO works(id,composer_id,title,created_by_user_id)
		SELECT $1,composer_id,'Second integration work',$2 FROM works WHERE id=$3`, secondID, fixture.UserID, fixture.WorkID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Pool.Exec(ctx, `INSERT INTO learner_works(user_id,work_id) VALUES($1,$2)`, fixture.UserID, secondID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = service.Pool.Exec(ctx, `DELETE FROM works WHERE id=$1`, secondID) })

	_, err := service.UpdateWork(ctx, fixture.UserID, secondID, WorkPatchInput{
		Title: "Integration work", Composer: composerName,
	})
	var validation ValidationError
	if !errors.As(err, &validation) || validation.Fields["title"] != "is already in your library" {
		t.Fatalf("duplicate work update error = %v, want title validation", err)
	}
	unchanged, err := service.GetWork(ctx, fixture.UserID, secondID)
	if err != nil {
		t.Fatal(err)
	}
	if unchanged.Title != "Second integration work" {
		t.Fatalf("duplicate update changed title to %q", unchanged.Title)
	}
}

func TestIntegrationDeletionPreservesOtherLearnersLibraryData(t *testing.T) {
	service, _, _ := integrationService(t)
	fixture := createIntegrationFixture(t, service)
	ctx := context.Background()
	otherUserID := uuid.NewString()
	otherAssetID := uuid.NewString()
	if _, err := service.Pool.Exec(ctx, `INSERT INTO users(id,email,display_name) VALUES($1,$2,'Other learner')`, otherUserID, otherUserID+"@example.test"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = service.Pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, otherUserID) })
	if _, err := service.Pool.Exec(ctx, `INSERT INTO learner_works(user_id,work_id) VALUES($1,$2)`, otherUserID, fixture.WorkID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Pool.Exec(ctx, `
		INSERT INTO score_assets(id,edition_id,asset_type,storage_key,original_filename,media_type,byte_size,sha256,rights_note,uploaded_by_user_id)
		VALUES($1,$2,'pdf',$3,'other.pdf','application/pdf',8,$4,'CC0',$5)`, otherAssetID, fixture.EditionID, "pdf/"+uuid.NewString(), strings.Repeat("b", 64), otherUserID); err != nil {
		t.Fatal(err)
	}

	if err := service.DeleteEdition(ctx, fixture.UserID, fixture.EditionID); !errors.Is(err, ErrEditionInUse) {
		t.Fatalf("shared edition deletion error = %v, want ErrEditionInUse", err)
	}
	if err := service.DeleteWork(ctx, fixture.UserID, fixture.WorkID); !errors.Is(err, ErrWorkInUse) {
		t.Fatalf("shared work deletion error = %v, want ErrWorkInUse", err)
	}
	var assetExists, workExists bool
	if err := service.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM score_assets WHERE id=$1),EXISTS(SELECT 1 FROM learner_works WHERE user_id=$2 AND work_id=$3)`, otherAssetID, otherUserID, fixture.WorkID).Scan(&assetExists, &workExists); err != nil {
		t.Fatal(err)
	}
	if !assetExists || !workExists {
		t.Fatalf("shared data was removed: asset=%v work=%v", assetExists, workExists)
	}
}

func TestIntegrationRecognitionCreatesDerivedUnverifiedMusicXML(t *testing.T) {
	service, _, _ := integrationService(t)
	fixture := createIntegrationFixture(t, service)
	service.WithRecognizer(fixtureProjectRecognizer{})
	ctx := context.Background()
	pdf, err := os.Open("../../testdata/fixtures/noted-exercise.pdf")
	if err != nil {
		t.Fatal(err)
	}
	stored, err := service.Store.Put(ctx, fixture.StorageKey, pdf)
	_ = pdf.Close()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Pool.Exec(ctx, `UPDATE score_assets SET byte_size=$2,sha256=$3 WHERE id=$1`, fixture.AssetID, stored.Size, stored.Checksum); err != nil {
		t.Fatal(err)
	}

	job, err := service.CreateRecognitionJob(ctx, fixture.UserID, fixture.AssetID)
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for job.Status == "queued" || job.Status == "processing" {
		if time.Now().After(deadline) {
			t.Fatal("recognition did not complete")
		}
		time.Sleep(20 * time.Millisecond)
		job, err = service.GetRecognitionJob(ctx, fixture.UserID, job.ID)
		if err != nil {
			t.Fatal(err)
		}
	}
	if job.Status != "succeeded" || job.OutputAssetID == nil || job.ProjectDownloadURL == "" {
		t.Fatalf("recognition job = %+v", job)
	}
	if job.Engine != "audiveris+homr" || job.Report == nil || job.Report.TotalMeasures != 8 || job.FlaggedMeasures == nil || *job.FlaggedMeasures != 2 || job.CorrectedMeasures == nil || *job.CorrectedMeasures != 1 {
		t.Fatalf("recognition quality report was not persisted: %+v", job)
	}
	project, _, err := service.OpenRecognitionProject(ctx, fixture.UserID, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	projectBytes, err := io.ReadAll(project)
	_ = project.Close()
	if err != nil {
		t.Fatal(err)
	}
	archive, err := zip.NewReader(bytes.NewReader(projectBytes), int64(len(projectBytes)))
	if err != nil {
		t.Fatalf("open stored correction project: %v", err)
	}
	if len(archive.File) != 1 || archive.File[0].Name != "book.xml" {
		t.Fatalf("stored correction project files = %v", archive.File)
	}
	asset, err := service.GetAsset(ctx, fixture.UserID, *job.OutputAssetID)
	if err != nil {
		t.Fatal(err)
	}
	if asset.AssetType != "musicxml" || asset.VerificationState != "unverified_ocr" || asset.DerivedFromAssetID == nil || *asset.DerivedFromAssetID != fixture.AssetID || asset.PlaybackValidation.Status != "ready" || !asset.PlaybackCapable {
		t.Fatalf("derived asset = %+v", asset)
	}
}

func TestIntegrationMetronomePreferences(t *testing.T) {
	service, _, _ := integrationService(t)
	fixture := createIntegrationFixture(t, service)
	ctx := context.Background()
	want := Preferences{
		WeekStartsOn: 1, MetronomeBPM: 112, MetronomeAccent: true,
		MetronomeBeatsPerBar: 3, MetronomeSound: "woodblock",
	}
	if _, err := service.UpdatePreferences(ctx, fixture.UserID, want); err != nil {
		t.Fatal(err)
	}
	got, err := service.GetPreferences(ctx, fixture.UserID)
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("preferences = %+v, want %+v", got, want)
	}
	invalid := want
	invalid.MetronomeBeatsPerBar = 5
	if _, err := service.UpdatePreferences(ctx, fixture.UserID, invalid); err == nil {
		t.Fatal("expected invalid meter to be rejected")
	}
	invalid = want
	invalid.MetronomeSound = "bell"
	if _, err := service.UpdatePreferences(ctx, fixture.UserID, invalid); err == nil {
		t.Fatal("expected invalid sound to be rejected")
	}
}

func TestIntegrationRecognitionRecoveryResumesInterruptedJob(t *testing.T) {
	service, _, _ := integrationService(t)
	fixture := createIntegrationFixture(t, service)
	service.WithRecognizer(fixtureRecognizer{})
	ctx := context.Background()
	pdf, err := os.Open("../../testdata/fixtures/noted-exercise.pdf")
	if err != nil {
		t.Fatal(err)
	}
	stored, err := service.Store.Put(ctx, fixture.StorageKey, pdf)
	_ = pdf.Close()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Pool.Exec(ctx, `UPDATE score_assets SET byte_size=$2,sha256=$3 WHERE id=$1`, fixture.AssetID, stored.Size, stored.Checksum); err != nil {
		t.Fatal(err)
	}
	jobID := uuid.NewString()
	if _, err := service.Pool.Exec(ctx, `
		INSERT INTO recognition_jobs(id,user_id,source_asset_id,status,started_at)
		VALUES($1,$2,$3,'processing',now())`, jobID, fixture.UserID, fixture.AssetID); err != nil {
		t.Fatal(err)
	}
	workerCtx, stopWorker := context.WithCancel(ctx)
	defer stopWorker()
	if err := service.RecoverRecognitionJobs(workerCtx); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		job, err := service.GetRecognitionJob(ctx, fixture.UserID, jobID)
		if err != nil {
			t.Fatal(err)
		}
		if job.Status == "succeeded" {
			if job.OutputAssetID == nil {
				t.Fatal("recovered recognition did not retain its output asset")
			}
			break
		}
		if job.Status == "failed" || job.Status == "cancelled" {
			t.Fatalf("recovered recognition job = %+v", job)
		}
		if time.Now().After(deadline) {
			t.Fatalf("recognition recovery did not complete: %+v", job)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestIntegrationRecognitionLeaseAllowsOnlyOneReplicaToRunJob(t *testing.T) {
	service, _, _ := integrationService(t)
	fixture := createIntegrationFixture(t, service)
	ctx := context.Background()
	pdf, err := os.Open("../../testdata/fixtures/noted-exercise.pdf")
	if err != nil {
		t.Fatal(err)
	}
	stored, err := service.Store.Put(ctx, fixture.StorageKey, pdf)
	_ = pdf.Close()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Pool.Exec(ctx, `UPDATE score_assets SET byte_size=$2,sha256=$3 WHERE id=$1`, fixture.AssetID, stored.Size, stored.Checksum); err != nil {
		t.Fatal(err)
	}
	jobID := uuid.NewString()
	if _, err := service.Pool.Exec(ctx, `INSERT INTO recognition_jobs(id,user_id,source_asset_id) VALUES($1,$2,$3)`, jobID, fixture.UserID, fixture.AssetID); err != nil {
		t.Fatal(err)
	}
	calls := &atomic.Int32{}
	service.WithRecognizer(countingFixtureRecognizer{calls: calls})
	otherReplica := NewService(service.Pool, service.Store).WithRecognizer(countingFixtureRecognizer{calls: calls})
	workerCtx, stopWorkers := context.WithCancel(context.Background())
	defer stopWorkers()
	if err := service.RecoverRecognitionJobs(workerCtx); err != nil {
		t.Fatal(err)
	}
	if err := otherReplica.RecoverRecognitionJobs(workerCtx); err != nil {
		t.Fatal(err)
	}

	deadline := time.Now().Add(5 * time.Second)
	for {
		job, err := service.GetRecognitionJob(ctx, fixture.UserID, jobID)
		if err != nil {
			t.Fatal(err)
		}
		if job.Status == "succeeded" {
			break
		}
		if job.Status == "failed" || time.Now().After(deadline) {
			t.Fatalf("leased recognition job = %+v", job)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if calls.Load() != 1 {
		t.Fatalf("recognizer calls = %d, want exactly one", calls.Load())
	}
}

func TestIntegrationRecognitionRecoveryPreservesAnotherReplicasActiveLease(t *testing.T) {
	service, _, _ := integrationService(t)
	fixture := createIntegrationFixture(t, service)
	service.WithRecognizer(fixtureRecognizer{})
	jobID := uuid.NewString()
	if _, err := service.Pool.Exec(context.Background(), `
		INSERT INTO recognition_jobs(id,user_id,source_asset_id,status,started_at,lease_owner,lease_expires_at,attempt_count)
		VALUES($1,$2,$3,'processing',now(),'other-api-replica',now()+interval '5 minutes',1)`,
		jobID, fixture.UserID, fixture.AssetID); err != nil {
		t.Fatal(err)
	}
	workerCtx, stopWorker := context.WithCancel(context.Background())
	defer stopWorker()
	if err := service.RecoverRecognitionJobs(workerCtx); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	var status, leaseOwner string
	var attempts int
	if err := service.Pool.QueryRow(context.Background(), `SELECT status,lease_owner,attempt_count FROM recognition_jobs WHERE id=$1`, jobID).Scan(&status, &leaseOwner, &attempts); err != nil {
		t.Fatal(err)
	}
	if status != "processing" || leaseOwner != "other-api-replica" || attempts != 1 {
		t.Fatalf("active lease changed: status=%s owner=%s attempts=%d", status, leaseOwner, attempts)
	}
}

func TestIntegrationRecognitionRejectsArchivedEdition(t *testing.T) {
	service, _, _ := integrationService(t)
	fixture := createIntegrationFixture(t, service)
	service.WithRecognizer(fixtureRecognizer{})
	archived := true
	if _, err := service.UpdateEdition(context.Background(), fixture.UserID, fixture.EditionID, EditionInput{Name: "Integration edition", Archived: &archived}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.CreateRecognitionJob(context.Background(), fixture.UserID, fixture.AssetID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("archived edition recognition error = %v, want ErrNotFound", err)
	}
}

func TestIntegrationCancelledRecognitionDiscardsLateOutput(t *testing.T) {
	service, _, _ := integrationService(t)
	fixture := createIntegrationFixture(t, service)
	ctx := context.Background()
	jobID := uuid.NewString()
	assetID := uuid.NewString()
	if _, err := service.Pool.Exec(ctx, `INSERT INTO recognition_jobs(id,user_id,source_asset_id,status,finished_at) VALUES($1,$2,$3,'cancelled',now())`, jobID, fixture.UserID, fixture.AssetID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Pool.Exec(ctx, `
		INSERT INTO score_assets(id,edition_id,asset_type,storage_key,original_filename,media_type,byte_size,sha256,rights_note,playback_capable,uploaded_by_user_id,derived_from_asset_id,verification_state)
		VALUES($1,$2,'musicxml',$3,'late.musicxml','application/vnd.recordare.musicxml+xml',8,$4,'Generated OCR',true,$5,$6,'unverified_ocr')`, assetID, fixture.EditionID, "musicxml/"+uuid.NewString(), strings.Repeat("c", 64), fixture.UserID, fixture.AssetID); err != nil {
		t.Fatal(err)
	}
	if err := service.finishRecognition(jobID, fixture.UserID, assetID, "audiveris", "test", nil, service.recognitionWorkerID, ""); err != nil {
		t.Fatal(err)
	}
	var exists bool
	if err := service.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM score_assets WHERE id=$1)`, assetID).Scan(&exists); err != nil {
		t.Fatal(err)
	}
	if exists {
		t.Fatal("late output asset survived recognition cancellation")
	}
}

func TestIntegrationOwnerCanDiscardRunningPracticeTimer(t *testing.T) {
	service, current, _ := integrationService(t)
	fixture := createIntegrationFixture(t, service)
	ctx := context.Background()
	session, err := service.StartPractice(ctx, fixture.UserID, PracticeInput{WorkID: fixture.WorkID})
	if err != nil {
		t.Fatal(err)
	}
	if err := service.DeletePractice(ctx, current.ID, session.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("another learner could discard the running timer: %v", err)
	}
	if err := service.DeletePractice(ctx, fixture.UserID, session.ID); err != nil {
		t.Fatalf("owner could not discard the running timer: %v", err)
	}
	if _, err := service.GetPracticeSession(ctx, fixture.UserID, session.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("discarded timer remained visible: %v", err)
	}
}

func TestIntegrationListPracticeKeepsOldRunningTimerAheadOfHistoryLimit(t *testing.T) {
	service, _, _ := integrationService(t)
	fixture := createIntegrationFixture(t, service)
	ctx := context.Background()
	running, err := service.StartPractice(ctx, fixture.UserID, PracticeInput{WorkID: fixture.WorkID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Pool.Exec(ctx, `UPDATE practice_sessions SET started_at='2000-01-01T00:00:00Z' WHERE id=$1`, running.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Pool.Exec(ctx, `
		INSERT INTO practice_sessions(user_id,work_id,started_at,ended_at,duration_seconds,entry_method)
		SELECT $1,$2,now()-(n * interval '1 minute'),now()-(n * interval '1 minute')+interval '30 seconds',30,'manual'
		FROM generate_series(1,101) AS n`, fixture.UserID, fixture.WorkID); err != nil {
		t.Fatal(err)
	}

	items, err := service.ListPractice(ctx, fixture.UserID, PracticeFilters{})
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 100 {
		t.Fatalf("practice list returned %d items, want 100", len(items))
	}
	if items[0].ID != running.ID || items[0].EndedAt != nil {
		t.Fatalf("old running timer was not prioritized ahead of bounded history: %+v", items[0])
	}
}

func TestIntegrationListPracticeHonorsInclusiveDateFilters(t *testing.T) {
	service, _, _ := integrationService(t)
	fixture := createIntegrationFixture(t, service)
	ctx := context.Background()
	starts := []time.Time{
		time.Date(2034, time.March, 4, 9, 0, 0, 0, time.UTC),
		time.Date(2034, time.March, 5, 9, 0, 0, 0, time.UTC),
		time.Date(2034, time.March, 6, 9, 0, 0, 0, time.UTC),
	}
	created := make([]PracticeSession, 0, len(starts))
	for _, started := range starts {
		session, err := service.CreateManualPractice(ctx, fixture.UserID, PracticeInput{
			WorkID: fixture.WorkID, StartedAt: &started, DurationSeconds: 60,
		})
		if err != nil {
			t.Fatal(err)
		}
		created = append(created, session)
	}

	items, err := service.ListPractice(ctx, fixture.UserID, PracticeFilters{
		WorkID: fixture.WorkID, From: &starts[1], To: &starts[1],
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].ID != created[1].ID {
		t.Fatalf("bounded practice list = %+v, want only middle boundary session %s", items, created[1].ID)
	}
}

func TestIntegrationPracticeCorrectionsRefreshMostRecentBPM(t *testing.T) {
	service, _, _ := integrationService(t)
	fixture := createIntegrationFixture(t, service)
	ctx := context.Background()
	olderStart := time.Date(2033, time.February, 6, 9, 0, 0, 0, time.UTC)
	newerStart := olderStart.Add(time.Hour)
	olderBPM, newerBPM := 90, 100
	older, err := service.CreateManualPractice(ctx, fixture.UserID, PracticeInput{
		WorkID: fixture.WorkID, StartedAt: &olderStart, DurationSeconds: 600, EndingBPM: &olderBPM,
	})
	if err != nil {
		t.Fatal(err)
	}
	newer, err := service.CreateManualPractice(ctx, fixture.UserID, PracticeInput{
		WorkID: fixture.WorkID, StartedAt: &newerStart, DurationSeconds: 600, EndingBPM: &newerBPM,
	})
	if err != nil {
		t.Fatal(err)
	}
	assertLastBPM := func(want int) {
		t.Helper()
		var got *int
		if err := service.Pool.QueryRow(ctx, `SELECT last_bpm FROM learner_works WHERE user_id=$1 AND work_id=$2`, fixture.UserID, fixture.WorkID).Scan(&got); err != nil {
			t.Fatal(err)
		}
		if got == nil || *got != want {
			t.Fatalf("last BPM = %v, want %d", got, want)
		}
	}
	assertLastBPM(newerBPM)

	correctedOlderBPM := 120
	var patch PracticePatchInput
	if err := json.Unmarshal([]byte(`{"endingBpm":120}`), &patch); err != nil {
		t.Fatal(err)
	}
	if _, err := service.UpdatePractice(ctx, fixture.UserID, older.ID, patch); err != nil {
		t.Fatal(err)
	}
	assertLastBPM(newerBPM)

	patch = PracticePatchInput{}
	correctedNewerBPM := 110
	if err := json.Unmarshal([]byte(`{"endingBpm":110}`), &patch); err != nil {
		t.Fatal(err)
	}
	if _, err := service.UpdatePractice(ctx, fixture.UserID, newer.ID, patch); err != nil {
		t.Fatal(err)
	}
	assertLastBPM(correctedNewerBPM)
	if err := service.DeletePractice(ctx, fixture.UserID, newer.ID); err != nil {
		t.Fatal(err)
	}
	assertLastBPM(correctedOlderBPM)
}
