package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/bitofbytes-io/noted/internal/omrreport"
)

const (
	maxRemoteErrorBytes              = 64 << 10
	defaultRemoteRecognitionAttempts = 8
	defaultRemoteRetryDelay          = time.Second
	maxRemoteRetryDelay              = 30 * time.Second
)

// HTTPRecognizer streams a PDF to the private Noted OMR worker and writes the
// bounded, validated MusicXML response into the caller's job directory.
type HTTPRecognizer struct {
	BaseURL           string
	Token             string
	Client            *http.Client
	MaxAttempts       int
	InitialRetryDelay time.Duration
}

type RemoteRecognitionError struct {
	StatusCode int
	Code       string
	Message    string
}

func (e *RemoteRecognitionError) Error() string {
	if e.Code == "" {
		return e.Message
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

func (r HTTPRecognizer) Recognize(ctx context.Context, inputPath, outputDirectory string) (RecognitionOutput, error) {
	if strings.TrimSpace(r.BaseURL) == "" || strings.TrimSpace(r.Token) == "" {
		return RecognitionOutput{}, ErrRecognitionUnavailable
	}
	info, err := os.Stat(inputPath)
	if err != nil {
		return RecognitionOutput{}, fmt.Errorf("inspect recognition input: %w", err)
	}
	if !info.Mode().IsRegular() || info.Size() < 1 || info.Size() > maxRecognitionBytes {
		return RecognitionOutput{}, errors.New("recognition input exceeds the permitted size")
	}
	attempts := r.MaxAttempts
	if attempts <= 0 || attempts > defaultRemoteRecognitionAttempts {
		attempts = defaultRemoteRecognitionAttempts
	}
	initialDelay := r.InitialRetryDelay
	if initialDelay <= 0 {
		initialDelay = defaultRemoteRetryDelay
	}
	for attempt := 0; ; attempt++ {
		output, err := r.recognizeOnce(ctx, inputPath, outputDirectory)
		var remoteErr *RemoteRecognitionError
		if err == nil || !errors.As(err, &remoteErr) || remoteErr.StatusCode != http.StatusTooManyRequests || attempt+1 >= attempts {
			return output, err
		}
		delay := initialDelay << attempt
		if delay > maxRemoteRetryDelay || delay < 0 {
			delay = maxRemoteRetryDelay
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return RecognitionOutput{}, ctx.Err()
		case <-timer.C:
		}
	}
}

func (r HTTPRecognizer) recognizeOnce(ctx context.Context, inputPath, outputDirectory string) (RecognitionOutput, error) {

	bodyReader, bodyWriter := io.Pipe()
	multipartWriter := multipart.NewWriter(bodyWriter)
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(r.BaseURL, "/")+"/v1/recognize", bodyReader)
	if err != nil {
		_ = bodyReader.Close()
		_ = bodyWriter.Close()
		return RecognitionOutput{}, fmt.Errorf("create recognition request: %w", err)
	}
	request.Header.Set("Authorization", "Bearer "+r.Token)
	request.Header.Set("Content-Type", multipartWriter.FormDataContentType())
	request.Header.Set("Accept", "multipart/mixed, application/vnd.recordare.musicxml, application/vnd.recordare.musicxml+xml")

	streamDone := make(chan error, 1)
	go func() {
		streamDone <- streamRecognitionInput(inputPath, multipartWriter, bodyWriter)
	}()

	client := *http.DefaultClient
	if r.Client != nil {
		client = *r.Client
	}
	client.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	}
	response, requestErr := client.Do(request)
	_ = bodyReader.Close()
	streamErr := <-streamDone
	if requestErr != nil {
		return RecognitionOutput{}, fmt.Errorf("contact recognition worker: %w", requestErr)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return RecognitionOutput{}, decodeRemoteRecognitionError(response)
	}
	if streamErr != nil {
		return RecognitionOutput{}, fmt.Errorf("stream recognition input: %w", streamErr)
	}

	engine := sanitizeRemoteError(response.Header.Get("X-Noted-OMR-Engine"), 100)
	version := sanitizeRemoteError(response.Header.Get("X-Noted-OMR-Version"), 100)
	if (!strings.EqualFold(engine, "audiveris") && !strings.EqualFold(engine, "audiveris+homr")) || version == "" {
		return RecognitionOutput{}, errors.New("recognition worker returned invalid engine metadata")
	}
	if err := os.MkdirAll(outputDirectory, 0o750); err != nil {
		return RecognitionOutput{}, fmt.Errorf("create recognition output directory: %w", err)
	}
	scorePath, projectPath, report, err := receiveRecognitionArtifacts(response, outputDirectory)
	if err != nil {
		return RecognitionOutput{}, err
	}
	if strings.EqualFold(engine, "audiveris+homr") && report == nil {
		_ = os.Remove(scorePath)
		_ = os.Remove(projectPath)
		return RecognitionOutput{}, errors.New("dual-engine recognition worker returned no quality report")
	}
	return RecognitionOutput{Path: scorePath, ProjectPath: projectPath, Engine: strings.ToLower(engine), EngineVersion: version, Report: report}, nil
}

func receiveRecognitionArtifacts(response *http.Response, outputDirectory string) (string, string, *omrreport.Report, error) {
	mediaType, parameters, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if err != nil {
		return "", "", nil, errors.New("recognition worker returned an invalid content type")
	}
	if !strings.EqualFold(mediaType, "multipart/mixed") {
		extension, err := remoteOutputExtension(response.Header.Get("Content-Type"))
		if err != nil {
			return "", "", nil, err
		}
		if response.ContentLength > maxRecognitionOutputBytes {
			return "", "", nil, errors.New("recognition output is too large")
		}
		path, err := writeRecognitionArtifact(response.Body, outputDirectory, "recognized-*"+extension, maxRecognitionOutputBytes)
		if err != nil {
			return "", "", nil, err
		}
		if err := validateRecognitionScore(path); err != nil {
			_ = os.Remove(path)
			return "", "", nil, fmt.Errorf("recognition worker produced unusable MusicXML: %w", err)
		}
		return path, "", nil, nil
	}

	boundary := parameters["boundary"]
	if boundary == "" {
		return "", "", nil, errors.New("recognition worker returned multipart output without a boundary")
	}
	reader := multipart.NewReader(response.Body, boundary)
	var scorePath, projectPath string
	var report *omrreport.Report
	keep := false
	defer func() {
		if !keep {
			_ = os.Remove(scorePath)
			_ = os.Remove(projectPath)
		}
	}()
	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return "", "", nil, fmt.Errorf("read recognition multipart output: %w", err)
		}
		artifact := strings.ToLower(strings.TrimSpace(part.Header.Get("X-Noted-Artifact")))
		switch artifact {
		case "score":
			if scorePath != "" {
				_ = part.Close()
				return "", "", nil, errors.New("recognition worker returned multiple score artifacts")
			}
			extension, extensionErr := remoteOutputExtension(part.Header.Get("Content-Type"))
			if extensionErr != nil {
				_ = part.Close()
				return "", "", nil, extensionErr
			}
			scorePath, err = writeRecognitionArtifact(part, outputDirectory, "recognized-*"+extension, maxRecognitionOutputBytes)
		case "project":
			if projectPath != "" {
				_ = part.Close()
				return "", "", nil, errors.New("recognition worker returned multiple project artifacts")
			}
			projectPath, err = writeRecognitionArtifact(part, outputDirectory, "recognized-*.omr", maxRecognitionProjectBytes)
		case "report":
			if report != nil {
				_ = part.Close()
				return "", "", nil, errors.New("recognition worker returned multiple quality reports")
			}
			partMediaType, _, mediaErr := mime.ParseMediaType(part.Header.Get("Content-Type"))
			if mediaErr != nil || !strings.EqualFold(partMediaType, "application/json") {
				err = errors.New("recognition worker returned an invalid quality report content type")
				break
			}
			decoded, decodeErr := omrreport.Decode(part)
			if decodeErr != nil {
				err = fmt.Errorf("recognition worker returned an invalid quality report: %w", decodeErr)
				break
			}
			report = &decoded
		default:
			err = fmt.Errorf("recognition worker returned unknown artifact %q", artifact)
		}
		closeErr := part.Close()
		if err != nil {
			return "", "", nil, err
		}
		if closeErr != nil {
			return "", "", nil, fmt.Errorf("close recognition artifact: %w", closeErr)
		}
	}
	if scorePath == "" {
		return "", "", nil, errors.New("recognition worker returned no score artifact")
	}
	if err := validateRecognitionScore(scorePath); err != nil {
		return "", "", nil, fmt.Errorf("recognition worker produced unusable MusicXML: %w", err)
	}
	if projectPath != "" {
		if err := validateRecognitionProject(projectPath); err != nil {
			return "", "", nil, fmt.Errorf("recognition worker produced unusable Audiveris project: %w", err)
		}
	}
	keep = true
	return scorePath, projectPath, report, nil
}

func writeRecognitionArtifact(reader io.Reader, outputDirectory, pattern string, limit int64) (string, error) {
	output, err := os.CreateTemp(outputDirectory, pattern)
	if err != nil {
		return "", fmt.Errorf("create recognition artifact: %w", err)
	}
	path := output.Name()
	written, copyErr := io.Copy(output, io.LimitReader(reader, limit+1))
	closeErr := output.Close()
	if copyErr != nil {
		_ = os.Remove(path)
		return "", fmt.Errorf("read recognition artifact: %w", copyErr)
	}
	if closeErr != nil {
		_ = os.Remove(path)
		return "", fmt.Errorf("close recognition artifact: %w", closeErr)
	}
	if written < 1 || written > limit {
		_ = os.Remove(path)
		return "", errors.New("recognition artifact is too large")
	}
	return path, nil
}

func streamRecognitionInput(inputPath string, writer *multipart.Writer, pipe *io.PipeWriter) error {
	file, err := os.Open(inputPath)
	if err != nil {
		_ = pipe.CloseWithError(err)
		return err
	}
	defer file.Close()
	part, err := writer.CreateFormFile("file", filepath.Base(inputPath))
	if err == nil {
		_, err = io.Copy(part, file)
	}
	if err == nil {
		err = writer.Close()
	}
	if err != nil {
		_ = pipe.CloseWithError(err)
		return err
	}
	return pipe.Close()
}

func remoteOutputExtension(contentType string) (string, error) {
	mediaType, _, err := mime.ParseMediaType(contentType)
	if err != nil {
		return "", errors.New("recognition worker returned an invalid content type")
	}
	switch strings.ToLower(mediaType) {
	case "application/vnd.recordare.musicxml+xml":
		return ".musicxml", nil
	case "application/vnd.recordare.musicxml":
		return ".mxl", nil
	default:
		return "", fmt.Errorf("recognition worker returned unsupported content type %q", mediaType)
	}
}

func decodeRemoteRecognitionError(response *http.Response) error {
	limited := io.LimitReader(response.Body, maxRemoteErrorBytes)
	var envelope struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	_ = json.NewDecoder(limited).Decode(&envelope)
	code := sanitizeRemoteError(envelope.Error.Code, 64)
	message := sanitizeRemoteError(envelope.Error.Message, 500)
	if code == "" {
		code = "worker_error"
	}
	if message == "" {
		message = "recognition worker returned " + response.Status
	}
	return &RemoteRecognitionError{StatusCode: response.StatusCode, Code: code, Message: message}
}

func sanitizeRemoteError(value string, limit int) string {
	value = strings.ToValidUTF8(value, "�")
	value = strings.Map(func(character rune) rune {
		if character < 0x20 || character == 0x7f {
			return ' '
		}
		return character
	}, value)
	runes := []rune(strings.TrimSpace(value))
	if len(runes) > limit {
		runes = runes[:limit]
	}
	return string(runes)
}
