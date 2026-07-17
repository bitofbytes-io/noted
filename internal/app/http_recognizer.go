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
	request.Header.Set("Accept", "application/vnd.recordare.musicxml, application/vnd.recordare.musicxml+xml")

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
	if !strings.EqualFold(engine, "audiveris") || version == "" {
		return RecognitionOutput{}, errors.New("recognition worker returned invalid engine metadata")
	}
	extension, err := remoteOutputExtension(response.Header.Get("Content-Type"))
	if err != nil {
		return RecognitionOutput{}, err
	}
	if response.ContentLength > maxRecognitionOutputBytes {
		return RecognitionOutput{}, errors.New("recognition output is too large")
	}
	if err := os.MkdirAll(outputDirectory, 0o750); err != nil {
		return RecognitionOutput{}, fmt.Errorf("create recognition output directory: %w", err)
	}
	output, err := os.CreateTemp(outputDirectory, "recognized-*"+extension)
	if err != nil {
		return RecognitionOutput{}, fmt.Errorf("create recognition output: %w", err)
	}
	outputPath := output.Name()
	keep := false
	defer func() {
		_ = output.Close()
		if !keep {
			_ = os.Remove(outputPath)
		}
	}()
	written, copyErr := io.Copy(output, io.LimitReader(response.Body, maxRecognitionOutputBytes+1))
	closeErr := output.Close()
	if copyErr != nil {
		return RecognitionOutput{}, fmt.Errorf("read recognition output: %w", copyErr)
	}
	if closeErr != nil {
		return RecognitionOutput{}, fmt.Errorf("close recognition output: %w", closeErr)
	}
	if written < 1 || written > maxRecognitionOutputBytes {
		return RecognitionOutput{}, errors.New("recognition output is too large")
	}
	if err := validateRecognitionScore(outputPath); err != nil {
		return RecognitionOutput{}, fmt.Errorf("recognition worker produced unusable MusicXML: %w", err)
	}
	keep = true
	return RecognitionOutput{Path: outputPath, EngineVersion: version}, nil
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
