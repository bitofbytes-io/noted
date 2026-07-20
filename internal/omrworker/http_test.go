package omrworker

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/bitofbytes-io/noted/internal/omrreport"
)

const testToken = "test-token-with-enough-entropy"

type fakeRecognizer struct {
	readyVersion string
	recognize    func(context.Context, string, string) (Result, error)
}

type fakeMappingRecognizer struct{ fakeRecognizer }

func (f *fakeMappingRecognizer) MapMeasures(_ context.Context, input, _ string) (MeasureMapResult, error) {
	contents, err := os.ReadFile(input)
	if err != nil {
		return MeasureMapResult{}, err
	}
	if !bytes.Equal(contents, minimalPDF()) {
		return MeasureMapResult{}, errors.New("measure mapper received different input bytes")
	}
	return MeasureMapResult{
		EngineVersion: "audiveris-5.10.2-measures+measure-map-1-omr",
		Pages: []MeasureMapPage{{
			PageNumber: 1, Width: 2550, Height: 3300, DPI: 300,
			Measures: []MeasureBox{{MeasureNumber: 1, X: 100, Y: 200, Width: 500, Height: 250}},
		}},
	}, nil
}

func (f *fakeRecognizer) Ready(context.Context) (string, error) {
	if f.readyVersion == "" {
		return EngineVersion, nil
	}
	return f.readyVersion, nil
}

func (f *fakeRecognizer) Recognize(ctx context.Context, input, output string) (Result, error) {
	return f.recognize(ctx, input, output)
}

func TestHealthAndReadiness(t *testing.T) {
	handler := newTestHandler(t, &fakeRecognizer{readyVersion: EngineVersion, recognize: successfulRecognition})

	health := httptest.NewRecorder()
	handler.ServeHTTP(health, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if health.Code != http.StatusOK {
		t.Fatalf("health status = %d, body = %s", health.Code, health.Body.String())
	}

	ready := httptest.NewRecorder()
	handler.ServeHTTP(ready, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if ready.Code != http.StatusOK {
		t.Fatalf("ready status = %d, body = %s", ready.Code, ready.Body.String())
	}
	var body map[string]string
	if err := json.Unmarshal(ready.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["engine"] != EngineName || body["version"] != EngineVersion {
		t.Fatalf("ready body = %#v", body)
	}
	if EngineVersion != "audiveris-5.10.2+homr-0.7.0+music21-10.3.0+alphatab-1.8.4" {
		t.Fatalf("worker component version = %q", EngineVersion)
	}
}

func TestNewHandlerRemovesInterruptedJobDirectories(t *testing.T) {
	tempRoot := t.TempDir()
	staleJob := filepath.Join(tempRoot, "noted-omr-job-interrupted")
	if err := os.Mkdir(staleJob, 0o700); err != nil {
		t.Fatal(err)
	}
	_, err := NewHandler(Config{Token: testToken, TempRoot: tempRoot, Recognizer: &fakeRecognizer{recognize: successfulRecognition}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(staleJob); !os.IsNotExist(err) {
		t.Fatalf("interrupted job directory still exists: %s", staleJob)
	}
}

func TestRecognizeRequiresBearerToken(t *testing.T) {
	handler := newTestHandler(t, &fakeRecognizer{recognize: successfulRecognition})
	request := multipartRequest(t, minimalPDF(), true)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	assertErrorCode(t, response, http.StatusUnauthorized, "unauthorized")
}

func TestMeasureMapRequiresAuthAndReturnsBoundedGeometry(t *testing.T) {
	recognizer := &fakeMappingRecognizer{fakeRecognizer: fakeRecognizer{recognize: successfulRecognition}}
	handler := newTestHandler(t, recognizer)
	unauthorized := multipartRequest(t, minimalPDF(), true)
	unauthorized.URL.Path = "/v1/measure-map"
	unauthorizedResponse := httptest.NewRecorder()
	handler.ServeHTTP(unauthorizedResponse, unauthorized)
	assertErrorCode(t, unauthorizedResponse, http.StatusUnauthorized, "unauthorized")

	request := multipartRequest(t, minimalPDF(), true)
	request.URL.Path = "/v1/measure-map"
	request.Header.Set("Authorization", "Bearer "+testToken)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var result MeasureMapResult
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.EngineVersion == "" || len(result.Pages) != 1 || len(result.Pages[0].Measures) != 1 {
		t.Fatalf("measure map = %+v", result)
	}
}

func TestRecognizeStreamsMusicXMLAndCleansJobDirectory(t *testing.T) {
	var jobRoot string
	recognizer := &fakeRecognizer{recognize: func(ctx context.Context, input, output string) (Result, error) {
		jobRoot = filepath.Dir(input)
		contents, err := os.ReadFile(input)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(contents, minimalPDF()) {
			t.Fatalf("stored PDF = %q", contents)
		}
		return successfulRecognition(ctx, input, output)
	}}
	handler := newTestHandler(t, recognizer)
	request := multipartRequest(t, minimalPDF(), true)
	request.Header.Set("Authorization", "Bearer "+testToken)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if response.Header().Get("X-Noted-OMR-Version") != EngineVersion {
		t.Fatalf("version header = %q", response.Header().Get("X-Noted-OMR-Version"))
	}
	if !bytes.Equal(response.Body.Bytes(), validMusicXML()) {
		t.Fatalf("response body = %q", response.Body.Bytes())
	}
	if _, err := os.Stat(jobRoot); !os.IsNotExist(err) {
		t.Fatalf("job directory still exists: %s", jobRoot)
	}
}

func TestRecognizeStreamsLinkedScoreAndCorrectionProject(t *testing.T) {
	recognizer := &fakeRecognizer{recognize: func(ctx context.Context, input, output string) (Result, error) {
		result, err := successfulRecognition(ctx, input, output)
		if err != nil {
			return Result{}, err
		}
		projectPath := filepath.Join(output, "score.omr")
		if err := os.WriteFile(projectPath, validOMRProject(t), 0o600); err != nil {
			return Result{}, err
		}
		result.ProjectPath = projectPath
		report := validQualityReport()
		result.Report = &report
		return result, nil
	}}
	handler := newTestHandler(t, recognizer)
	request := multipartRequest(t, minimalPDF(), true)
	request.Header.Set("Authorization", "Bearer "+testToken)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	mediaType, parameters, err := mime.ParseMediaType(response.Header().Get("Content-Type"))
	if err != nil || mediaType != "multipart/mixed" {
		t.Fatalf("content type = %q, error = %v", response.Header().Get("Content-Type"), err)
	}
	reader := multipart.NewReader(response.Body, parameters["boundary"])
	artifacts := map[string][]byte{}
	for {
		part, err := reader.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		artifacts[part.Header.Get("X-Noted-Artifact")], err = io.ReadAll(part)
		if err != nil {
			t.Fatal(err)
		}
	}
	if !bytes.Equal(artifacts["score"], validMusicXML()) {
		t.Fatalf("score artifact = %q", artifacts["score"])
	}
	if !bytes.Equal(artifacts["project"], validOMRProject(t)) {
		t.Fatal("correction project artifact was not preserved")
	}
	var report omrreport.Report
	if err := json.Unmarshal(artifacts["report"], &report); err != nil {
		t.Fatalf("decode quality report: %v", err)
	}
	if err := report.Validate(); err != nil {
		t.Fatalf("quality report = %+v: %v", report, err)
	}
}

func TestRecognizeClassifiesUnplayableOutput(t *testing.T) {
	handler := newTestHandler(t, &fakeRecognizer{recognize: func(context.Context, string, string) (Result, error) {
		return Result{}, workerError("unplayable_output", "alphaTab could not load the recognized score", nil)
	}})
	request := multipartRequest(t, minimalPDF(), true)
	request.Header.Set("Authorization", "Bearer "+testToken)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	assertErrorCode(t, response, http.StatusUnprocessableEntity, "unplayable_output")
}

func TestRecognizeRejectsInvalidAndOversizedInput(t *testing.T) {
	handler := newTestHandlerWithConfig(t, &fakeRecognizer{recognize: successfulRecognition}, Config{MaxInputBytes: 8})
	for _, test := range []struct {
		name   string
		input  []byte
		status int
		code   string
	}{
		{name: "not pdf", input: []byte("not-pdf"), status: http.StatusUnprocessableEntity, code: "invalid_pdf"},
		{name: "too large", input: []byte("%PDF-12345"), status: http.StatusRequestEntityTooLarge, code: "input_too_large"},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := multipartRequest(t, test.input, true)
			request.Header.Set("Authorization", "Bearer "+testToken)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			assertErrorCode(t, response, test.status, test.code)
		})
	}
}

func TestRecognizeEnforcesSingleConcurrentJob(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	recognizer := &fakeRecognizer{recognize: func(ctx context.Context, input, output string) (Result, error) {
		once.Do(func() { close(started) })
		select {
		case <-release:
			return successfulRecognition(ctx, input, output)
		case <-ctx.Done():
			return Result{}, ctx.Err()
		}
	}}
	handler := newTestHandler(t, recognizer)
	server := httptest.NewServer(handler)
	defer server.Close()

	firstDone := make(chan error, 1)
	go func() {
		response, err := doMultipartRequest(server.URL, minimalPDF())
		if err == nil {
			_, _ = io.Copy(io.Discard, response.Body)
			_ = response.Body.Close()
		}
		firstDone <- err
	}()
	<-started
	second, err := doMultipartRequest(server.URL, minimalPDF())
	if err != nil {
		t.Fatal(err)
	}
	defer second.Body.Close()
	secondBody, _ := io.ReadAll(second.Body)
	response := httptest.NewRecorder()
	response.Code = second.StatusCode
	response.Body = bytes.NewBuffer(secondBody)
	assertErrorCode(t, response, http.StatusTooManyRequests, "busy")
	if second.Header.Get("Retry-After") != "5" {
		t.Fatalf("Retry-After = %q", second.Header.Get("Retry-After"))
	}
	close(release)
	if err := <-firstDone; err != nil {
		t.Fatal(err)
	}
}

func TestRecognizeTimesOutAndCleansJobDirectory(t *testing.T) {
	var jobRoot string
	recognizer := &fakeRecognizer{recognize: func(ctx context.Context, input, output string) (Result, error) {
		jobRoot = filepath.Dir(input)
		<-ctx.Done()
		return Result{}, workerError("timeout", "recognition exceeded its time limit", ctx.Err())
	}}
	handler := newTestHandlerWithConfig(t, recognizer, Config{Timeout: 10 * time.Millisecond})
	request := multipartRequest(t, minimalPDF(), true)
	request.Header.Set("Authorization", "Bearer "+testToken)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	assertErrorCode(t, response, http.StatusGatewayTimeout, "timeout")
	if _, err := os.Stat(jobRoot); !os.IsNotExist(err) {
		t.Fatalf("job directory still exists: %s", jobRoot)
	}
}

func TestRecognizeTimesOutStalledUpload(t *testing.T) {
	reader, writer := io.Pipe()
	defer writer.Close()
	handler := newTestHandlerWithConfig(t, &fakeRecognizer{recognize: successfulRecognition}, Config{UploadTimeout: 10 * time.Millisecond})
	request := httptest.NewRequest(http.MethodPost, "/v1/recognize", reader)
	request.Header.Set("Authorization", "Bearer "+testToken)
	request.Header.Set("Content-Type", "multipart/form-data; boundary=stalled")
	response := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		handler.ServeHTTP(response, request)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("stalled upload did not time out")
	}
	assertErrorCode(t, response, http.StatusGatewayTimeout, "timeout")
}

func TestServerReturnsClassifiedTimeoutBeforeReadDeadline(t *testing.T) {
	handler := newTestHandlerWithConfig(t, &fakeRecognizer{recognize: successfulRecognition}, Config{UploadTimeout: 20 * time.Millisecond})
	server := httptest.NewUnstartedServer(handler)
	server.Config.ReadTimeout = 100 * time.Millisecond
	server.Start()
	defer server.Close()

	reader, writer := io.Pipe()
	defer writer.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, server.URL+"/v1/recognize", reader)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+testToken)
	request.Header.Set("Content-Type", "multipart/form-data; boundary=stalled")
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	recorder.Code = response.StatusCode
	recorder.Body = bytes.NewBuffer(body)
	assertErrorCode(t, recorder, http.StatusGatewayTimeout, "timeout")
}

func newTestHandler(t *testing.T, recognizer Recognizer) *Handler {
	t.Helper()
	return newTestHandlerWithConfig(t, recognizer, Config{})
}

func newTestHandlerWithConfig(t *testing.T, recognizer Recognizer, override Config) *Handler {
	t.Helper()
	config := override
	config.Token = testToken
	config.TempRoot = t.TempDir()
	config.Recognizer = recognizer
	handler, err := NewHandler(config)
	if err != nil {
		t.Fatal(err)
	}
	return handler
}

func multipartRequest(t *testing.T, contents []byte, includeFile bool) *http.Request {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if includeFile {
		part, err := writer.CreateFormFile("file", "score.pdf")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := part.Write(contents); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/v1/recognize", &body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	return request
}

func doMultipartRequest(baseURL string, contents []byte) (*http.Response, error) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, _ := writer.CreateFormFile("file", "score.pdf")
	_, _ = part.Write(contents)
	_ = writer.Close()
	request, _ := http.NewRequest(http.MethodPost, baseURL+"/v1/recognize", &body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	request.Header.Set("Authorization", "Bearer "+testToken)
	return http.DefaultClient.Do(request)
}

func successfulRecognition(_ context.Context, _ string, output string) (Result, error) {
	path := filepath.Join(output, "score.musicxml")
	if err := os.WriteFile(path, validMusicXML(), 0o600); err != nil {
		return Result{}, err
	}
	return Result{Path: path, ContentType: "application/vnd.recordare.musicxml+xml", Extension: ".musicxml"}, nil
}

func validMusicXML() []byte {
	return []byte(`<score-partwise><part><measure><note><pitch><step>C</step></pitch></note></measure></part></score-partwise>`)
}

func validOMRProject(t *testing.T) []byte {
	t.Helper()
	var output bytes.Buffer
	archive := zip.NewWriter(&output)
	entry, err := archive.Create("book.xml")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(entry, `<book/>`); err != nil {
		t.Fatal(err)
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	return output.Bytes()
}

func validQualityReport() omrreport.Report {
	return omrreport.Report{
		SchemaVersion: 1, TotalMeasures: 1, FlaggedMeasures: 1, SuspectMeasures: 1, SelectedEngine: "audiveris",
		Engines: map[string]json.RawMessage{
			"audiveris": json.RawMessage(`{"version":"5.10.2","status":"succeeded"}`),
			"homr":      json.RawMessage(`{"version":"0.7.0","status":"failed"}`),
		},
		Measures: []omrreport.Measure{{
			PartID: "P1", Number: "1", MeasureIndex: 1, SourceEngine: "audiveris",
			Agreement: false, Confidence: "medium", Issues: []string{},
		}},
		Playability: omrreport.Playability{Status: "passed", MeasureCount: 1, TotalTicks: 3840},
	}
}

func minimalPDF() []byte { return []byte("%PDF-1.7\n%%EOF\n") }

func assertErrorCode(t *testing.T, response *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if response.Code != status {
		t.Fatalf("status = %d, want %d, body = %s", response.Code, status, response.Body.String())
	}
	var body struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Error.Code != code {
		t.Fatalf("error code = %q, want %q", body.Error.Code, code)
	}
}
