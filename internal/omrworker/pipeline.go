package omrworker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/bitofbytes-io/noted/internal/omrreport"
)

const defaultPreprocessDPI = 300

type pipelineEngineState struct {
	Version string `json:"version"`
	Status  string `json:"status"`
	Error   string `json:"error,omitempty"`
	Warning string `json:"warning,omitempty"`
}

type alphaTabGateResult struct {
	Status       string `json:"status"`
	MeasureCount int    `json:"measureCount"`
	TotalTicks   int64  `json:"totalTicks"`
}

func (r *CommandRecognizer) pipelineEnabled() bool {
	return strings.TrimSpace(r.HomrCommand) != ""
}

func (r *CommandRecognizer) readyPipeline(ctx context.Context) error {
	commands := map[string]string{
		"PDF rendering": r.PDFToPPMCommand,
		"homr":          r.HomrCommand,
		"Python":        r.PythonCommand,
		"Node.js":       r.NodeCommand,
	}
	if r.ModelManifest != "" {
		commands["model checksum validation"] = r.SHA256Command
	}
	for name, command := range commands {
		if strings.TrimSpace(command) == "" {
			return workerError("worker_unavailable", name+" is not configured", nil)
		}
		if _, err := exec.LookPath(command); err != nil {
			return workerError("worker_unavailable", name+" is unavailable", err)
		}
	}
	for name, path := range map[string]string{
		"pre-processing":  r.PreprocessScript,
		"measure mapping": r.MeasureMapScript,
		"MusicXML repair": r.RepairScript,
		"MusicXML fusion": r.FuseScript,
		"alphaTab gate":   r.AlphaTabGateScript,
	} {
		info, err := os.Stat(path)
		if err != nil || !info.Mode().IsRegular() {
			return workerError("worker_unavailable", name+" script is unavailable", err)
		}
	}

	pythonCheck := "import importlib.metadata as m; print(m.version('homr') + ' ' + m.version('music21'))"
	output, err := runReadyCommand(ctx, r.PythonCommand, "-c", pythonCheck)
	if err != nil {
		return workerError("worker_unavailable", "Python OMR dependencies failed their version check", err)
	}
	wantPythonVersions := strings.TrimSpace(r.HomrVersion + " " + r.Music21Version)
	if strings.TrimSpace(output) != wantPythonVersions {
		return workerError("worker_version_mismatch", "homr or music21 does not match the pinned worker version", nil)
	}
	output, err = runReadyCommand(ctx, r.NodeCommand, r.AlphaTabGateScript, "--version")
	if err != nil {
		return workerError("worker_unavailable", "alphaTab failed its version check", err)
	}
	if strings.TrimSpace(output) != r.AlphaTabVersion {
		return workerError("worker_version_mismatch", "alphaTab does not match the pinned worker version", nil)
	}
	if r.ModelManifest != "" {
		if _, err := os.Stat(r.ModelManifest); err != nil {
			return workerError("worker_unavailable", "homr model manifest is unavailable", err)
		}
		if _, err := runReadyCommand(ctx, r.SHA256Command, "-c", r.ModelManifest); err != nil {
			return workerError("worker_version_mismatch", "homr model checksums do not match the worker image", err)
		}
	}
	return nil
}

func runReadyCommand(ctx context.Context, command string, arguments ...string) (string, error) {
	var output limitedBuffer
	process := exec.CommandContext(ctx, command, arguments...)
	configureProcessGroup(process)
	process.Stdout = &output
	process.Stderr = &output
	if err := process.Run(); err != nil {
		return output.String(), fmt.Errorf("%w: %s", err, output.String())
	}
	return output.String(), nil
}

func (r *CommandRecognizer) recognizePipeline(ctx context.Context, inputPath, outputDirectory string) (Result, error) {
	return r.recognizePipelineWithOptions(ctx, inputPath, outputDirectory, RecognitionOptions{SourceType: "pdf"})
}

func (r *CommandRecognizer) recognizePipelineWithOptions(ctx context.Context, inputPath, outputDirectory string, options RecognitionOptions) (Result, error) {
	pages := 1
	var err error
	if options.SourceType != "image" {
		pages, err = r.pageCount(ctx, inputPath)
		if err != nil {
			return Result{}, err
		}
	}
	maxPages := r.MaxPages
	if maxPages <= 0 {
		maxPages = DefaultMaxPages
	}
	if pages > maxPages {
		return Result{}, workerError("too_many_pages", fmt.Sprintf("PDF exceeds the %d-page limit", maxPages), nil)
	}
	maxOutputBytes := r.MaxOutputBytes
	if maxOutputBytes <= 0 {
		maxOutputBytes = DefaultMaxOutputBytes
	}
	jobRoot := filepath.Dir(outputDirectory)
	jobEnvironment, err := createPipelineEnvironment(jobRoot)
	if err != nil {
		return Result{}, err
	}
	environment := pipelineEnvironment(jobEnvironment)

	preparedDirectory := filepath.Join(outputDirectory, "prepared")
	audiverisDirectory := filepath.Join(outputDirectory, "audiveris")
	audiverisImplicitDirectory := filepath.Join(outputDirectory, "audiveris-implicit-tuplets")
	repairedDirectory := filepath.Join(outputDirectory, "repaired")
	repairedImplicitDirectory := filepath.Join(outputDirectory, "repaired-implicit-tuplets")
	finalDirectory := filepath.Join(outputDirectory, "final")
	for _, directory := range []string{preparedDirectory, audiverisDirectory, audiverisImplicitDirectory, repairedDirectory, repairedImplicitDirectory, finalDirectory} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			return Result{}, workerError("internal_error", "recognition pipeline storage could not be created", err)
		}
	}

	var pageImages []string
	if options.SourceType == "image" {
		pageImage := filepath.Join(preparedDirectory, "page-001"+filepath.Ext(inputPath))
		contents, readErr := os.ReadFile(inputPath)
		if readErr != nil {
			return Result{}, workerError("invalid_pdf", "score image could not be read", readErr)
		}
		if writeErr := os.WriteFile(pageImage, contents, 0o600); writeErr != nil {
			return Result{}, workerError("internal_error", "score image could not be prepared", writeErr)
		}
		pageImages = []string{pageImage}
	} else {
		pageImages, err = r.preprocessPages(ctx, inputPath, preparedDirectory, pages, environment, jobRoot)
		if err != nil {
			return Result{}, err
		}
	}
	bookImage := filepath.Join(preparedDirectory, "book.tiff")
	arguments := []string{r.PreprocessScript, "--output", bookImage}
	arguments = append(arguments, pageImages...)
	if err := runPipelineStage(ctx, r.PythonCommand, arguments, environment, jobRoot); err != nil {
		return Result{}, pipelineWorkerError(ctx, "conversion_failed", "pre-processed score pages could not be assembled", err)
	}
	if err := validateJobFootprint(jobRoot); err != nil {
		return Result{}, err
	}

	states := map[string]pipelineEngineState{
		"audiveris": {Version: r.Version, Status: "skipped"},
		"homr":      {Version: r.HomrVersion, Status: "skipped"},
	}
	var audiverisRepairReport, homrRepairReport string
	var audiverisScore, audiverisProject, homrScore string
	runAudiveris := func() error {
		result, project, engineErr := r.runPipelineAudiverisWithOptions(ctx, bookImage, audiverisDirectory, environment, maxOutputBytes, options)
		if engineErr == nil {
			audiverisScore, audiverisRepairReport, engineErr = r.repairEngineWithReport(ctx, "audiveris", []string{result.Path}, repairedDirectory, environment, jobRoot, maxOutputBytes)
			audiverisProject = project
		}
		if engineErr != nil {
			audiverisScore = ""
			states["audiveris"] = pipelineEngineState{Version: r.Version, Status: "failed", Error: sanitizePipelineError(engineErr)}
			return engineErr
		}
		state := pipelineEngineState{Version: r.Version, Status: "succeeded"}
		if !options.ImplicitTuplets && shouldRetryImplicitTuplets(audiverisRepairReport) {
			retryOptions := options
			retryOptions.ImplicitTuplets = true
			retryResult, retryProject, retryErr := r.runPipelineAudiverisWithOptions(ctx, bookImage, audiverisImplicitDirectory, environment, maxOutputBytes, retryOptions)
			if retryErr == nil {
				retryScore, retryReport, repairErr := r.repairEngineWithReport(ctx, "audiveris", []string{retryResult.Path}, repairedImplicitDirectory, environment, jobRoot, maxOutputBytes)
				if repairErr == nil {
					audiverisScore, audiverisRepairReport, audiverisProject = retryScore, retryReport, retryProject
					state.Warning = "implicit_tuplets_auto_retry_applied"
				} else {
					state.Warning = "implicit_tuplets_auto_retry_failed"
				}
			} else {
				state.Warning = "implicit_tuplets_auto_retry_failed"
			}
		}
		if options.ImplicitTuplets {
			state.Warning = "implicit_tuplets_hint_applied"
		}
		states["audiveris"] = state
		return nil
	}
	runHomr := func() error {
		outputs, engineErr := r.runPipelineHomr(ctx, pageImages, environment, jobRoot, maxOutputBytes)
		if engineErr == nil {
			homrScore, homrRepairReport, engineErr = r.repairEngineWithReport(ctx, "homr", outputs, repairedDirectory, environment, jobRoot, maxOutputBytes)
		}
		if engineErr != nil {
			homrScore = ""
			states["homr"] = pipelineEngineState{Version: r.HomrVersion, Status: "failed", Error: sanitizePipelineError(engineErr)}
			return engineErr
		}
		states["homr"] = pipelineEngineState{Version: r.HomrVersion, Status: "succeeded"}
		return nil
	}

	runRoutedEngines(options.SourceType, runAudiveris, runHomr)
	if errors.Is(ctx.Err(), context.Canceled) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return Result{}, pipelineWorkerError(ctx, "conversion_failed", "recognition did not complete", ctx.Err())
	}
	if err := validateJobFootprint(jobRoot); err != nil {
		return Result{}, err
	}
	if audiverisScore == "" && homrScore == "" {
		return Result{}, workerError("conversion_failed", "both recognition engines failed", fmt.Errorf("audiveris: %s; homr: %s", states["audiveris"].Error, states["homr"].Error))
	}

	statusPath := filepath.Join(finalDirectory, "engine-status.json")
	statusData, err := json.Marshal(states)
	if err != nil {
		return Result{}, workerError("internal_error", "recognition engine status could not be encoded", err)
	}
	if err := os.WriteFile(statusPath, statusData, 0o600); err != nil {
		return Result{}, workerError("internal_error", "recognition engine status could not be written", err)
	}
	finalScore := filepath.Join(finalDirectory, "recognized.musicxml")
	draftReport := filepath.Join(finalDirectory, "quality-report-draft.json")
	fuseArguments := []string{r.FuseScript, "--status", statusPath, "--output", finalScore, "--report", draftReport}
	if audiverisScore != "" {
		fuseArguments = append(fuseArguments, "--audiveris", audiverisScore, "--audiveris-report", audiverisRepairReport)
	}
	if homrScore != "" {
		fuseArguments = append(fuseArguments, "--homr", homrScore, "--homr-report", homrRepairReport)
	}
	if err := runPipelineStage(ctx, r.PythonCommand, fuseArguments, environment, jobRoot); err != nil {
		return Result{}, pipelineWorkerError(ctx, "conversion_failed", "recognition outputs could not be fused", err)
	}
	if err := validateMusicXMLFile(finalScore, maxOutputBytes); err != nil {
		return Result{}, workerError("invalid_output", "recognition pipeline produced invalid MusicXML", err)
	}

	gatePath := filepath.Join(finalDirectory, "playability.json")
	if err := runPipelineStage(ctx, r.NodeCommand, []string{r.AlphaTabGateScript, finalScore, gatePath}, environment, jobRoot); err != nil {
		return Result{}, pipelineWorkerError(ctx, "unplayable_output", "alphaTab could not load the recognized score", err)
	}
	qualityReport, err := completeQualityReport(draftReport, gatePath, filepath.Join(finalDirectory, "quality-report.json"))
	if err != nil {
		return Result{}, workerError("unplayable_output", "recognition quality report did not match the playable score", err)
	}
	if err := validateJobFootprint(jobRoot); err != nil {
		return Result{}, err
	}
	return Result{
		Path: finalScore, ContentType: "application/vnd.recordare.musicxml+xml", Extension: ".musicxml",
		ProjectPath: audiverisProject, Engine: qualityReport.SelectedEngine, Report: &qualityReport,
	}, nil
}

func runRoutedEngines(sourceType string, runAudiveris, runHomr func() error) {
	if sourceType == "image" {
		if err := runHomr(); err != nil {
			_ = runAudiveris()
		}
		return
	}
	if err := runAudiveris(); err != nil {
		_ = runHomr()
	}
}

func createPipelineEnvironment(jobRoot string) (map[string]string, error) {
	result := map[string]string{}
	for _, directory := range []string{"home", "cache", "config", "data", "tmp"} {
		path := filepath.Join(jobRoot, directory)
		if err := os.MkdirAll(path, 0o700); err != nil {
			return nil, workerError("internal_error", "isolated recognition storage could not be created", err)
		}
		result[directory] = path
	}
	return result, nil
}

func pipelineEnvironment(paths map[string]string) []string {
	javaOptions := strings.TrimSpace(os.Getenv("JAVA_TOOL_OPTIONS"))
	javaOptions = strings.TrimSpace(javaOptions + " -Djava.io.tmpdir=" + paths["tmp"])
	return replaceEnvironment(os.Environ(), map[string]string{
		"HOME": paths["home"], "JAVA_TOOL_OPTIONS": javaOptions, "TMPDIR": paths["tmp"],
		"XDG_CACHE_HOME": paths["cache"], "XDG_CONFIG_HOME": paths["config"], "XDG_DATA_HOME": paths["data"],
		"OMP_NUM_THREADS": "2", "OPENBLAS_NUM_THREADS": "2", "MKL_NUM_THREADS": "2",
	})
}

func (r *CommandRecognizer) preprocessPages(ctx context.Context, inputPath, directory string, pages int, environment []string, jobRoot string) ([]string, error) {
	dpi := r.DPI
	if dpi <= 0 {
		dpi = defaultPreprocessDPI
	}
	results := make([]string, 0, pages)
	for page := 1; page <= pages; page++ {
		prefix := filepath.Join(directory, fmt.Sprintf("page-%03d", page))
		arguments := []string{"-f", strconv.Itoa(page), "-l", strconv.Itoa(page), "-r", strconv.Itoa(dpi), "-png", "-singlefile", inputPath, prefix}
		if err := runPipelineStage(ctx, r.PDFToPPMCommand, arguments, environment, jobRoot); err != nil {
			return nil, pipelineWorkerError(ctx, "invalid_pdf", "PDF page rendering failed", err)
		}
		path := prefix + ".png"
		if err := validatePNG(path); err != nil {
			return nil, workerError("invalid_pdf", "PDF page renderer produced an invalid image", err)
		}
		results = append(results, path)
		if err := validateJobFootprint(jobRoot); err != nil {
			return nil, err
		}
	}
	return results, nil
}

func validatePNG(path string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	header := make([]byte, 8)
	if _, err := io.ReadFull(file, header); err != nil {
		return err
	}
	if !bytes.Equal(header, []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}) {
		return errors.New("page image is not PNG")
	}
	return nil
}

func (r *CommandRecognizer) runPipelineAudiveris(ctx context.Context, inputPath, outputDirectory string, environment []string, maxOutputBytes int64) (Result, string, error) {
	return r.runPipelineAudiverisWithOptions(ctx, inputPath, outputDirectory, environment, maxOutputBytes, RecognitionOptions{})
}

func (r *CommandRecognizer) runPipelineAudiverisWithOptions(ctx context.Context, inputPath, outputDirectory string, environment []string, maxOutputBytes int64, options RecognitionOptions) (Result, string, error) {
	arguments := []string{"-batch"}
	if options.ImplicitTuplets {
		arguments = append(arguments, "-constant", "org.audiveris.omr.sheet.ProcessingSwitches.implicitTuplets=true")
	}
	arguments = append(arguments, "-transcribe", "-save", "-export", "-output", outputDirectory, "--", inputPath)
	if err := runPipelineStage(ctx, r.Command, arguments, environment, filepath.Dir(outputDirectory)); err != nil {
		return Result{}, "", err
	}
	result, err := findAndValidateResult(outputDirectory, maxOutputBytes)
	if err != nil {
		return Result{}, "", err
	}
	projectPath, err := findAndValidateProject(outputDirectory)
	if err != nil {
		return Result{}, "", err
	}
	return result, projectPath, nil
}

func (r *CommandRecognizer) runPipelineHomr(ctx context.Context, pageImages []string, environment []string, jobRoot string, maxOutputBytes int64) ([]string, error) {
	results := make([]string, 0, len(pageImages))
	for _, image := range pageImages {
		if err := runPipelineStage(ctx, r.HomrCommand, []string{"--gpu", "no", image}, environment, jobRoot); err != nil {
			return nil, err
		}
		output := strings.TrimSuffix(image, filepath.Ext(image)) + ".musicxml"
		if err := validateMusicXMLFile(output, maxOutputBytes); err != nil {
			return nil, fmt.Errorf("homr produced invalid MusicXML for %s: %w", filepath.Base(image), err)
		}
		results = append(results, output)
		if err := validateJobFootprint(jobRoot); err != nil {
			return nil, err
		}
	}
	return results, nil
}

func (r *CommandRecognizer) repairEngine(ctx context.Context, engine string, inputs []string, outputDirectory string, environment []string, jobRoot string, maxOutputBytes int64) (string, error) {
	path, _, err := r.repairEngineWithReport(ctx, engine, inputs, outputDirectory, environment, jobRoot, maxOutputBytes)
	return path, err
}

func (r *CommandRecognizer) repairEngineWithReport(ctx context.Context, engine string, inputs []string, outputDirectory string, environment []string, jobRoot string, maxOutputBytes int64) (string, string, error) {
	output := filepath.Join(outputDirectory, engine+".musicxml")
	report := filepath.Join(outputDirectory, engine+"-report.json")
	arguments := []string{r.RepairScript, "--engine", engine, "--output", output, "--report", report}
	for _, input := range inputs {
		arguments = append(arguments, "--input", input)
	}
	if err := runPipelineStage(ctx, r.PythonCommand, arguments, environment, jobRoot); err != nil {
		return "", "", err
	}
	if err := validateMusicXMLFile(output, maxOutputBytes); err != nil {
		return "", "", err
	}
	if info, err := os.Stat(report); err != nil || info.Size() < 1 || info.Size() > omrreport.MaxBytes {
		return "", "", errors.New("repair report is missing or too large")
	}
	return output, report, nil
}

func runPipelineStage(ctx context.Context, command string, arguments []string, environment []string, directory string) error {
	var output limitedBuffer
	process := exec.CommandContext(ctx, command, arguments...)
	configureProcessGroup(process)
	process.Env = environment
	process.Dir = directory
	process.Stdout = &output
	process.Stderr = &output
	if err := process.Run(); err != nil {
		return fmt.Errorf("%w: %s", err, strings.TrimSpace(output.String()))
	}
	return nil
}

func pipelineWorkerError(ctx context.Context, fallbackCode, message string, cause error) error {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return workerError("timeout", "recognition exceeded its time limit", ctx.Err())
	}
	if errors.Is(ctx.Err(), context.Canceled) {
		return workerError("cancelled", "recognition was cancelled", ctx.Err())
	}
	return workerError(fallbackCode, message, cause)
}

func sanitizePipelineError(err error) string {
	if err == nil {
		return ""
	}
	value := strings.ToValidUTF8(err.Error(), "�")
	value = strings.Map(func(character rune) rune {
		if character < 0x20 || character == 0x7f {
			return ' '
		}
		return character
	}, value)
	value = strings.TrimSpace(value)
	if len(value) > 500 {
		value = value[:500]
	}
	return value
}

func shouldRetryImplicitTuplets(reportPath string) bool {
	data, err := os.ReadFile(reportPath)
	if err != nil || len(data) == 0 || len(data) > omrreport.MaxBytes {
		return false
	}
	var report struct {
		MeasureCount             int `json:"measureCount"`
		ImplicitTupletCandidates []struct {
			MeasureIndex int `json:"measureIndex"`
		} `json:"implicitTupletCandidates"`
	}
	if err := json.Unmarshal(data, &report); err != nil || report.MeasureCount < 1 {
		return false
	}
	indexes := map[int]bool{}
	for _, candidate := range report.ImplicitTupletCandidates {
		if candidate.MeasureIndex > 0 && candidate.MeasureIndex <= report.MeasureCount {
			indexes[candidate.MeasureIndex] = true
		}
	}
	return len(indexes)*2 > report.MeasureCount
}

func completeQualityReport(draftPath, gatePath, outputPath string) (omrreport.Report, error) {
	draftData, err := os.ReadFile(draftPath)
	if err != nil {
		return omrreport.Report{}, err
	}
	if len(draftData) < 1 || len(draftData) > omrreport.MaxBytes {
		return omrreport.Report{}, errors.New("quality report draft is empty or too large")
	}
	var report omrreport.Report
	if err := json.Unmarshal(draftData, &report); err != nil {
		return omrreport.Report{}, err
	}
	gateData, err := os.ReadFile(gatePath)
	if err != nil {
		return omrreport.Report{}, err
	}
	var gate alphaTabGateResult
	if err := json.Unmarshal(gateData, &gate); err != nil {
		return omrreport.Report{}, err
	}
	report.Playability = omrreport.Playability{Status: gate.Status, MeasureCount: gate.MeasureCount, TotalTicks: gate.TotalTicks}
	if err := report.Validate(); err != nil {
		return omrreport.Report{}, err
	}
	encoded, err := json.Marshal(report)
	if err != nil {
		return omrreport.Report{}, err
	}
	if len(encoded) > omrreport.MaxBytes {
		return omrreport.Report{}, errors.New("quality report is too large")
	}
	if err := os.WriteFile(outputPath, encoded, 0o600); err != nil {
		return omrreport.Report{}, err
	}
	file, err := os.Open(outputPath)
	if err != nil {
		return omrreport.Report{}, err
	}
	defer file.Close()
	return omrreport.Decode(file)
}
