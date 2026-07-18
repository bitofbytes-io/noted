package omrworker

import (
	"archive/zip"
	"bufio"
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	pathpkg "path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	EngineName    = "audiveris"
	EngineVersion = "5.10.2"

	DefaultMaxPages       = 25
	DefaultMaxOutputBytes = int64(25 << 20)
	maxLogBytes           = 16 << 10
	maxArchiveEntries     = 128
	maxJobFiles           = 4096
	maxJobBytes           = int64(512 << 20)
)

type Result struct {
	Path        string
	ContentType string
	Extension   string
	ProjectPath string
}

type Recognizer interface {
	Ready(context.Context) (string, error)
	Recognize(context.Context, string, string) (Result, error)
}

type CommandRecognizer struct {
	Command        string
	PDFInfoCommand string
	Version        string
	MaxPages       int
	MaxOutputBytes int64

	readyMu      sync.Mutex
	readyVersion string
}

func NewCommandRecognizer() *CommandRecognizer {
	return &CommandRecognizer{
		Command:        "/opt/audiveris/bin/Audiveris",
		PDFInfoCommand: "pdfinfo",
		Version:        EngineVersion,
		MaxPages:       DefaultMaxPages,
		MaxOutputBytes: DefaultMaxOutputBytes,
	}
}

func (r *CommandRecognizer) Ready(ctx context.Context) (string, error) {
	r.readyMu.Lock()
	defer r.readyMu.Unlock()
	if r.readyVersion != "" {
		return r.readyVersion, nil
	}
	if _, err := exec.LookPath(r.Command); err != nil {
		return "", workerError("worker_unavailable", "Audiveris is unavailable", err)
	}
	if _, err := exec.LookPath(r.PDFInfoCommand); err != nil {
		return "", workerError("worker_unavailable", "PDF inspection is unavailable", err)
	}
	output, err := exec.CommandContext(ctx, r.Command, "-batch", "-version").CombinedOutput()
	if err != nil {
		return "", workerError("worker_unavailable", "Audiveris failed its version check", err)
	}
	if !strings.Contains(string(output), r.Version) {
		return "", workerError("worker_version_mismatch", "Audiveris version does not match the pinned worker version", nil)
	}
	r.readyVersion = r.Version
	return r.readyVersion, nil
}

func (r *CommandRecognizer) Recognize(ctx context.Context, inputPath, outputDirectory string) (Result, error) {
	pages, err := r.pageCount(ctx, inputPath)
	if err != nil {
		return Result{}, err
	}
	if pages > r.MaxPages {
		return Result{}, workerError("too_many_pages", fmt.Sprintf("PDF exceeds the %d-page limit", r.MaxPages), nil)
	}

	var output limitedBuffer
	jobRoot := filepath.Dir(outputDirectory)
	jobEnvironment := map[string]string{}
	for _, directory := range []string{"home", "cache", "config", "data", "tmp"} {
		path := filepath.Join(jobRoot, directory)
		if err := os.MkdirAll(path, 0o700); err != nil {
			return Result{}, workerError("internal_error", "isolated recognition storage could not be created", err)
		}
		jobEnvironment[directory] = path
	}
	command := exec.CommandContext(ctx, r.Command,
		"-batch", "-transcribe", "-save", "-export", "-output", outputDirectory, "--", inputPath)
	configureProcessGroup(command)
	javaOptions := strings.TrimSpace(os.Getenv("JAVA_TOOL_OPTIONS"))
	javaOptions = strings.TrimSpace(javaOptions + " -Djava.io.tmpdir=" + jobEnvironment["tmp"])
	command.Env = replaceEnvironment(os.Environ(), map[string]string{
		"HOME":              jobEnvironment["home"],
		"JAVA_TOOL_OPTIONS": javaOptions,
		"TMPDIR":            jobEnvironment["tmp"],
		"XDG_CACHE_HOME":    jobEnvironment["cache"],
		"XDG_CONFIG_HOME":   jobEnvironment["config"],
		"XDG_DATA_HOME":     jobEnvironment["data"],
	})
	command.Stdout = &output
	command.Stderr = &output
	if err := command.Run(); err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return Result{}, workerError("timeout", "recognition exceeded its time limit", ctx.Err())
		}
		if errors.Is(ctx.Err(), context.Canceled) {
			return Result{}, workerError("cancelled", "recognition was cancelled", ctx.Err())
		}
		return Result{}, workerError("conversion_failed", "Audiveris could not convert the score", fmt.Errorf("%w: %s", err, output.String()))
	}

	if err := validateJobFootprint(jobRoot); err != nil {
		return Result{}, err
	}
	result, err := findAndValidateResult(outputDirectory, r.MaxOutputBytes)
	if err != nil {
		return Result{}, err
	}
	projectPath, err := findAndValidateProject(outputDirectory)
	if err != nil {
		return Result{}, err
	}
	result.ProjectPath = projectPath
	return result, nil
}

func replaceEnvironment(current []string, replacements map[string]string) []string {
	result := make([]string, 0, len(current)+len(replacements))
	for _, entry := range current {
		key, _, ok := strings.Cut(entry, "=")
		if ok {
			if _, replaced := replacements[key]; replaced {
				continue
			}
		}
		result = append(result, entry)
	}
	for key, value := range replacements {
		result = append(result, key+"="+value)
	}
	return result
}

func validateJobFootprint(root string) error {
	var files int
	var total int64
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !entry.Type().IsRegular() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		files++
		if info.Size() > maxJobBytes-total {
			return workerError("output_too_large", "recognition job exceeded its temporary-storage budget", nil)
		}
		total += info.Size()
		if files > maxJobFiles {
			return workerError("output_too_large", "recognition job created too many temporary files", nil)
		}
		return nil
	})
	if err != nil {
		var typed *Error
		if errors.As(err, &typed) {
			return err
		}
		return workerError("invalid_output", "recognition job output could not be inspected", err)
	}
	return nil
}

func configureProcessGroup(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	command.Cancel = func() error {
		if command.Process == nil {
			return os.ErrProcessDone
		}
		err := syscall.Kill(-command.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		}
		return err
	}
	command.WaitDelay = 5 * time.Second
}

func (r *CommandRecognizer) pageCount(ctx context.Context, inputPath string) (int, error) {
	var output limitedBuffer
	command := exec.CommandContext(ctx, r.PDFInfoCommand, inputPath)
	command.Stdout = &output
	command.Stderr = &output
	if err := command.Run(); err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return 0, workerError("timeout", "PDF inspection exceeded its time limit", ctx.Err())
		}
		if errors.Is(ctx.Err(), context.Canceled) {
			return 0, workerError("cancelled", "PDF inspection was cancelled", ctx.Err())
		}
		return 0, workerError("invalid_pdf", "PDF metadata could not be read", err)
	}
	scanner := bufio.NewScanner(strings.NewReader(output.String()))
	for scanner.Scan() {
		key, value, ok := strings.Cut(scanner.Text(), ":")
		if !ok || !strings.EqualFold(strings.TrimSpace(key), "pages") {
			continue
		}
		pages, err := strconv.Atoi(strings.TrimSpace(value))
		if err != nil || pages < 1 {
			break
		}
		return pages, nil
	}
	return 0, workerError("invalid_pdf", "PDF page count could not be determined", nil)
}

func findAndValidateResult(root string, maxBytes int64) (Result, error) {
	var candidates []string
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.Type().IsRegular() {
			extension := strings.ToLower(filepath.Ext(path))
			if extension == ".mxl" || extension == ".musicxml" || extension == ".xml" {
				candidates = append(candidates, path)
			}
		}
		return nil
	})
	if err != nil {
		return Result{}, workerError("invalid_output", "recognition output could not be inspected", err)
	}
	if len(candidates) == 0 {
		return Result{}, workerError("conversion_failed", "Audiveris produced no MusicXML output", nil)
	}

	var lastErr error
	for _, path := range candidates {
		extension := strings.ToLower(filepath.Ext(path))
		if extension == ".mxl" {
			lastErr = validateMXL(path, maxBytes)
		} else {
			lastErr = validateMusicXMLFile(path, maxBytes)
		}
		if lastErr == nil {
			if extension == ".mxl" {
				return Result{Path: path, ContentType: "application/vnd.recordare.musicxml", Extension: ".mxl"}, nil
			}
			return Result{Path: path, ContentType: "application/vnd.recordare.musicxml+xml", Extension: ".musicxml"}, nil
		}
	}
	if codeForError(lastErr, "") == "output_too_large" {
		return Result{}, lastErr
	}
	return Result{}, workerError("invalid_output", "Audiveris produced invalid MusicXML", lastErr)
}

func findAndValidateProject(root string) (string, error) {
	var candidates []string
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.Type().IsRegular() && strings.EqualFold(filepath.Ext(path), ".omr") {
			candidates = append(candidates, path)
		}
		return nil
	})
	if err != nil {
		return "", workerError("invalid_output", "recognition project could not be inspected", err)
	}
	if len(candidates) == 0 {
		return "", nil
	}
	sort.Strings(candidates)
	if err := validateOMR(candidates[0]); err != nil {
		return "", workerError("invalid_output", "Audiveris produced an invalid correction project", err)
	}
	return candidates[0], nil
}

func validateOMR(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if info.Size() < 1 || info.Size() > maxJobBytes {
		return errors.New("Audiveris project exceeds the permitted size")
	}
	archive, err := zip.OpenReader(path)
	if err != nil {
		return err
	}
	defer archive.Close()
	if len(archive.File) < 1 || len(archive.File) > maxJobFiles {
		return errors.New("Audiveris project has an invalid entry count")
	}
	var expanded uint64
	bookSeen := false
	for _, entry := range archive.File {
		if !safeArchivePath(entry.Name) {
			return errors.New("Audiveris project contains an unsafe path")
		}
		expanded, err = addExpandedSize(expanded, entry.UncompressedSize64, uint64(maxJobBytes))
		if err != nil {
			return err
		}
		if entry.Name == "book.xml" {
			bookSeen = true
		}
	}
	if !bookSeen {
		return errors.New("Audiveris project is missing book.xml")
	}
	return nil
}

func validateMusicXMLFile(path string, maxBytes int64) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if info.Size() < 1 || info.Size() > maxBytes {
		return workerError("output_too_large", "MusicXML output exceeds the permitted size", nil)
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	return validateMusicXML(file, maxBytes)
}

func validateMXL(path string, maxBytes int64) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if info.Size() < 1 || info.Size() > maxBytes {
		return workerError("output_too_large", "compressed MusicXML output exceeds the permitted size", nil)
	}
	archive, err := zip.OpenReader(path)
	if err != nil {
		return err
	}
	defer archive.Close()
	if len(archive.File) < 1 || len(archive.File) > maxArchiveEntries {
		return errors.New("compressed MusicXML has an invalid entry count")
	}
	var expanded uint64
	validScore := false
	for _, entry := range archive.File {
		if !safeArchivePath(entry.Name) {
			return errors.New("compressed MusicXML contains an unsafe path")
		}
		var err error
		expanded, err = addExpandedSize(expanded, entry.UncompressedSize64, uint64(maxBytes))
		if err != nil {
			return workerError("output_too_large", "compressed MusicXML expands beyond the permitted size", nil)
		}
		if entry.FileInfo().IsDir() || !strings.HasSuffix(strings.ToLower(entry.Name), ".xml") || strings.HasPrefix(entry.Name, "META-INF/") {
			continue
		}
		reader, err := entry.Open()
		if err != nil {
			return err
		}
		err = validateMusicXML(reader, maxBytes)
		_ = reader.Close()
		if err == nil {
			validScore = true
		}
	}
	if validScore {
		return nil
	}
	return errors.New("compressed MusicXML contains no valid score")
}

func safeArchivePath(name string) bool {
	if name == "" || strings.ContainsAny(name, "\\\x00") {
		return false
	}
	clean := pathpkg.Clean(name)
	if clean == "." || pathpkg.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, "../") {
		return false
	}
	first, _, _ := strings.Cut(clean, "/")
	return !strings.Contains(first, ":")
}

func addExpandedSize(current, addition, limit uint64) (uint64, error) {
	if current > limit || addition > limit-current {
		return current, errors.New("expanded size exceeds limit")
	}
	return current + addition, nil
}

func validateMusicXML(reader io.Reader, maxBytes int64) error {
	limited := &io.LimitedReader{R: reader, N: maxBytes + 1}
	decoder := xml.NewDecoder(limited)
	var score, measure bool
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return err
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
		}
	}
	if limited.N <= 0 {
		return errors.New("MusicXML exceeds the permitted size")
	}
	if !score || !measure {
		return errors.New("output is not a valid MusicXML score")
	}
	return nil
}

type limitedBuffer struct{ bytes.Buffer }

func (b *limitedBuffer) Write(data []byte) (int, error) {
	original := len(data)
	if b.Len() < maxLogBytes {
		remaining := maxLogBytes - b.Len()
		if len(data) > remaining {
			data = data[:remaining]
		}
		_, _ = b.Buffer.Write(data)
	}
	return original, nil
}
