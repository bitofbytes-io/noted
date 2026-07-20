package omrworker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
)

type MeasureBox struct {
	MeasureNumber int     `json:"measureNumber"`
	X             float64 `json:"x"`
	Y             float64 `json:"y"`
	Width         float64 `json:"width"`
	Height        float64 `json:"height"`
}

type MeasureMapPage struct {
	PageNumber int          `json:"pageNumber"`
	Width      float64      `json:"width"`
	Height     float64      `json:"height"`
	DPI        int          `json:"dpi"`
	Measures   []MeasureBox `json:"measures"`
}

type MeasureMapResult struct {
	Pages         []MeasureMapPage `json:"pages"`
	EngineVersion string           `json:"engineVersion"`
}

type MeasureMapper interface {
	MapMeasures(context.Context, string, string) (MeasureMapResult, error)
}

func (r *CommandRecognizer) MapMeasures(ctx context.Context, inputPath, outputDirectory string) (MeasureMapResult, error) {
	if r.MeasureMapScript == "" || r.PythonCommand == "" {
		return MeasureMapResult{}, workerError("worker_unavailable", "measure-map extraction is unavailable", nil)
	}
	maxPages := r.MaxPages
	if maxPages <= 0 {
		maxPages = DefaultMaxPages
	}
	jobRoot := filepath.Dir(outputDirectory)
	paths, err := createPipelineEnvironment(jobRoot)
	if err != nil {
		return MeasureMapResult{}, err
	}
	environment := pipelineEnvironment(paths)
	prepared := filepath.Join(outputDirectory, "prepared")
	audiveris := filepath.Join(outputDirectory, "audiveris-measures")
	if err := os.MkdirAll(prepared, 0o700); err != nil {
		return MeasureMapResult{}, err
	}
	if err := os.MkdirAll(audiveris, 0o700); err != nil {
		return MeasureMapResult{}, err
	}

	pageImages := []string{}
	if isPDFFile(inputPath) {
		pages, err := r.pageCount(ctx, inputPath)
		if err != nil {
			return MeasureMapResult{}, err
		}
		if pages > maxPages {
			return MeasureMapResult{}, workerError("too_many_pages", fmt.Sprintf("score exceeds the %d-page limit", maxPages), nil)
		}
		pageImages, err = r.preprocessPages(ctx, inputPath, prepared, pages, environment, jobRoot)
		if err != nil {
			return MeasureMapResult{}, err
		}
	} else {
		pageImage := filepath.Join(prepared, "page-001"+filepath.Ext(inputPath))
		contents, err := os.ReadFile(inputPath)
		if err != nil {
			return MeasureMapResult{}, err
		}
		if err := os.WriteFile(pageImage, contents, 0o600); err != nil {
			return MeasureMapResult{}, err
		}
		pageImages = []string{pageImage}
	}

	// Audiveris's structure-only pass is preferred. Failure is non-fatal because
	// the CV extractor uses the same deterministic page images as a fallback.
	_ = runPipelineStage(ctx, r.Command, []string{"-batch", "-step", "MEASURES", "-save", "-output", audiveris, "--", inputPath}, environment, jobRoot)
	project, _ := findAndValidateProject(audiveris)
	outputPath := filepath.Join(outputDirectory, "measure-map.json")
	dpi := r.DPI
	if dpi <= 0 {
		dpi = defaultPreprocessDPI
	}
	arguments := []string{r.MeasureMapScript, "--output", outputPath, "--dpi", strconv.Itoa(dpi)}
	if project != "" {
		arguments = append(arguments, "--omr", project)
	}
	arguments = append(arguments, pageImages...)
	if err := runPipelineStage(ctx, r.PythonCommand, arguments, environment, jobRoot); err != nil {
		return MeasureMapResult{}, pipelineWorkerError(ctx, "conversion_failed", "measure geometry could not be extracted", err)
	}
	file, err := os.Open(outputPath)
	if err != nil {
		return MeasureMapResult{}, err
	}
	defer file.Close()
	decoder := json.NewDecoder(file)
	decoder.DisallowUnknownFields()
	var result MeasureMapResult
	if err := decoder.Decode(&result); err != nil {
		return MeasureMapResult{}, workerError("invalid_output", "measure-map output is invalid", err)
	}
	if err := validateWorkerMeasureMap(result); err != nil {
		return MeasureMapResult{}, workerError("invalid_output", "measure-map geometry is invalid", err)
	}
	return result, nil
}

func isPDFFile(path string) bool {
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()
	header := make([]byte, 1024)
	read, _ := file.Read(header)
	return read >= 5 && string(header[:5]) == "%PDF-"
}

func validateWorkerMeasureMap(result MeasureMapResult) error {
	if result.EngineVersion == "" || len(result.Pages) < 1 || len(result.Pages) > DefaultMaxPages {
		return errors.New("missing version or pages")
	}
	measures := 0
	for _, page := range result.Pages {
		if page.PageNumber < 1 || page.Width <= 0 || page.Height <= 0 || page.DPI < 72 || page.DPI > 1200 {
			return errors.New("invalid page")
		}
		for _, box := range page.Measures {
			measures++
			if box.MeasureNumber < 1 || box.X < 0 || box.Y < 0 || box.Width <= 0 || box.Height <= 0 || box.X+box.Width > page.Width+1 || box.Y+box.Height > page.Height+1 {
				return errors.New("invalid box")
			}
		}
	}
	if measures < 1 || measures > 10000 {
		return errors.New("invalid measure count")
	}
	return nil
}
