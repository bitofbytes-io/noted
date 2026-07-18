package app

import (
	"time"

	assetstore "github.com/bitofbytes-io/noted/internal/assets"
	"github.com/bitofbytes-io/noted/internal/omrreport"
)

type PlaybackIssue = assetstore.PlaybackIssue
type PlaybackValidation = assetstore.PlaybackValidation
type OMRQualityReport = omrreport.Report
type OMRMeasureQuality = omrreport.Measure
type OMRPlayability = omrreport.Playability

type User struct {
	ID              string `json:"id"`
	Email           string `json:"email"`
	DisplayName     string `json:"displayName"`
	WeekStartsOn    int    `json:"weekStartsOn"`
	MetronomeBPM    int    `json:"metronomeBpm"`
	MetronomeAccent bool   `json:"metronomeAccent"`
}

type Asset struct {
	ID                 string             `json:"id"`
	EditionID          string             `json:"editionId"`
	AssetType          string             `json:"assetType"`
	OriginalFilename   string             `json:"originalFilename"`
	DisplayName        string             `json:"displayName"`
	MediaType          string             `json:"mediaType"`
	ByteSize           int64              `json:"byteSize"`
	SHA256             string             `json:"sha256"`
	SourceURL          string             `json:"sourceUrl,omitempty"`
	RightsNote         string             `json:"rightsNote"`
	PlaybackCapable    bool               `json:"playbackCapable"`
	ArchivedAt         *time.Time         `json:"archivedAt,omitempty"`
	ReplacesAssetID    *string            `json:"replacesAssetId,omitempty"`
	DerivedFromAssetID *string            `json:"derivedFromAssetId,omitempty"`
	VerificationState  string             `json:"verificationState"`
	CreatedAt          time.Time          `json:"createdAt"`
	ContentURL         string             `json:"contentUrl"`
	DownloadURL        string             `json:"downloadUrl"`
	PlaybackValidation PlaybackValidation `json:"playbackValidation"`
}

type Edition struct {
	ID              string     `json:"id"`
	Name            string     `json:"name"`
	Editor          string     `json:"editor,omitempty"`
	Publisher       string     `json:"publisher,omitempty"`
	PublicationYear *int       `json:"publicationYear,omitempty"`
	SourceURL       string     `json:"sourceUrl,omitempty"`
	RightsNote      string     `json:"rightsNote,omitempty"`
	ArchivedAt      *time.Time `json:"archivedAt,omitempty"`
	Assets          []Asset    `json:"assets"`
}

type RecognitionJob struct {
	ID                 string            `json:"id"`
	SourceAssetID      string            `json:"sourceAssetId"`
	OutputAssetID      *string           `json:"outputAssetId,omitempty"`
	Status             string            `json:"status"`
	Engine             string            `json:"engine"`
	EngineVersion      string            `json:"engineVersion"`
	ErrorCode          string            `json:"errorCode,omitempty"`
	FailureMessage     string            `json:"failureMessage,omitempty"`
	FlaggedMeasures    *int              `json:"flaggedMeasures,omitempty"`
	CorrectedMeasures  *int              `json:"correctedMeasures,omitempty"`
	Report             *OMRQualityReport `json:"report,omitempty"`
	ProjectDownloadURL string            `json:"projectDownloadUrl,omitempty"`
	CreatedAt          time.Time         `json:"createdAt"`
	StartedAt          *time.Time        `json:"startedAt,omitempty"`
	FinishedAt         *time.Time        `json:"finishedAt,omitempty"`
	UpdatedAt          time.Time         `json:"updatedAt"`
	projectStorageKey  *string
}

type Movement struct {
	ID             string `json:"id"`
	SequenceNumber int    `json:"sequenceNumber"`
	Title          string `json:"title"`
	TempoMarking   string `json:"tempoMarking,omitempty"`
	MeasureCount   *int   `json:"measureCount,omitempty"`
}

type LearnerState struct {
	Status             string   `json:"status"`
	IsFavorite         bool     `json:"isFavorite"`
	PersonalDifficulty string   `json:"personalDifficulty,omitempty"`
	PersonalNotes      string   `json:"personalNotes,omitempty"`
	LastBPM            *int     `json:"lastBpm,omitempty"`
	Tags               []string `json:"tags"`
}

type PracticeSummary struct {
	TotalSeconds int `json:"totalSeconds"`
	SessionCount int `json:"sessionCount"`
}

type WorkSummary struct {
	ID            string     `json:"id"`
	Title         string     `json:"title"`
	Composer      string     `json:"composer"`
	Status        string     `json:"status"`
	IsFavorite    bool       `json:"isFavorite"`
	Tags          []string   `json:"tags"`
	LastPracticed *time.Time `json:"lastPracticed,omitempty"`
	LastBPM       *int       `json:"lastBpm,omitempty"`
	HasPDF        bool       `json:"hasPdf"`
	HasPlayback   bool       `json:"hasPlayback"`
	UpdatedAt     time.Time  `json:"updatedAt"`
}

type WorkDetail struct {
	ID                       string          `json:"id"`
	Title                    string          `json:"title"`
	Subtitle                 string          `json:"subtitle,omitempty"`
	Composer                 string          `json:"composer"`
	CatalogNumber            string          `json:"catalogNumber,omitempty"`
	KeySignature             string          `json:"keySignature,omitempty"`
	Period                   string          `json:"period,omitempty"`
	PublishedDifficultyLabel string          `json:"publishedDifficultyLabel,omitempty"`
	Notes                    string          `json:"notes,omitempty"`
	LearnerState             LearnerState    `json:"learnerState"`
	Movements                []Movement      `json:"movements"`
	Editions                 []Edition       `json:"editions"`
	PracticeSummary          PracticeSummary `json:"practiceSummary"`
}

type WeekDay struct {
	Date            string `json:"date"`
	DurationSeconds int    `json:"durationSeconds"`
	SessionCount    int    `json:"sessionCount"`
}

type WeekSummary struct {
	StartsOn     string    `json:"startsOn"`
	Days         []WeekDay `json:"days"`
	TotalSeconds int       `json:"totalSeconds"`
	SessionCount int       `json:"sessionCount"`
}

type Dashboard struct {
	CurrentWorks  []WorkSummary `json:"currentWorks"`
	RecentImports []Asset       `json:"recentImports"`
	Week          WeekSummary   `json:"week"`
}

type PracticeSession struct {
	ID              string     `json:"id"`
	WorkID          string     `json:"workId"`
	WorkTitle       string     `json:"workTitle"`
	MovementID      *string    `json:"movementId,omitempty"`
	ScoreAssetID    *string    `json:"scoreAssetId,omitempty"`
	StartedAt       time.Time  `json:"startedAt"`
	EndedAt         *time.Time `json:"endedAt,omitempty"`
	DurationSeconds int        `json:"durationSeconds"`
	EntryMethod     string     `json:"entryMethod"`
	StartMeasure    *int       `json:"startMeasure,omitempty"`
	EndMeasure      *int       `json:"endMeasure,omitempty"`
	HandPart        string     `json:"handPart,omitempty"`
	StartingBPM     *int       `json:"startingBpm,omitempty"`
	EndingBPM       *int       `json:"endingBpm,omitempty"`
	Notes           string     `json:"notes,omitempty"`
}

type ValidationError struct {
	Fields map[string]string
}

func (e ValidationError) Error() string { return "validation failed" }
