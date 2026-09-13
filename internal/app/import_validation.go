package app

import (
	"bytes"
	"fmt"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/types"
	"golang.org/x/image/ccitt"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"math"
	"net/http"
	"net/url"
	"strings"

	"github.com/google/uuid"
	"github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
)

func ValidateImportBytes(data []byte) (string, int, int, int, error) {
	if len(data) == 0 {
		return "", 0, 0, 0, fmt.Errorf("source must contain a PDF, JPEG or PNG")
	}
	if bytes.HasPrefix(data, []byte("%PDF-")) {
		conf := model.NewDefaultConfiguration()
		conf.ValidationMode = model.ValidationRelaxed
		parsed, err := api.ReadAndValidate(bytes.NewReader(data), conf)
		if err != nil {
			return "", 0, 0, 0, fmt.Errorf("PDF must be readable and unencrypted: %v", err)
		}
		if parsed.Encrypt != nil {
			return "", 0, 0, 0, fmt.Errorf("PDF must be unencrypted; export an unlocked copy first")
		}
		for _, entry := range parsed.Table {
			sd, ok := entry.Object.(types.StreamDict)
			if !ok || !sd.HasSoleFilterNamed("CCITTFaxDecode") {
				continue
			}
			w, h := sd.IntEntry("Width"), sd.IntEntry("Height")
			if w == nil || h == nil || *w <= 0 || *h <= 0 || int64(*w)*int64(*h) > 100000000 {
				return "", 0, 0, 0, fmt.Errorf("PDF image must have supported dimensions")
			}
			params := sd.FilterPipeline[0].DecodeParms
			k := params.IntEntry("K")
			if k != nil && *k < 0 {
				columns, rows := 1728, *h
				if value := params.IntEntry("Columns"); value != nil {
					columns = *value
				}
				if value := params.IntEntry("Rows"); value != nil && *value != 0 {
					rows = *value
				}
				if columns <= 0 || rows <= 0 || columns > 100000000/rows {
					return "", 0, 0, 0, fmt.Errorf("PDF CCITT image must have supported decoding dimensions")
				}
				options := &ccitt.Options{}
				if align := params.BooleanEntry("EncodedByteAlign"); align != nil {
					options.Align = *align
				}
				want := int64((columns+7)/8) * int64(rows)
				n, decodeErr := io.Copy(io.Discard, io.LimitReader(ccitt.NewReader(bytes.NewReader(sd.Raw), ccitt.MSB, ccitt.Group4, columns, rows, options), want+1))
				if decodeErr != nil || n != want {
					return "", 0, 0, 0, fmt.Errorf("PDF must contain complete CCITT image data")
				}
			}
		}
		count := parsed.PageCount
		if count < 1 || count > 10000 {
			return "", 0, 0, 0, fmt.Errorf("PDF must contain between 1 and 10000 pages")
		}
		return "application/pdf", count, 0, 0, nil
	}
	mime := http.DetectContentType(data)
	if mime != "image/jpeg" && mime != "image/png" {
		return "", 0, 0, 0, fmt.Errorf("source must be PDF, JPEG or PNG; export HEIC photos as JPEG first")
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || cfg.Width < 1 || cfg.Height < 1 || int64(cfg.Width)*int64(cfg.Height) > 20000000 {
		return "", 0, 0, 0, fmt.Errorf("photo must be readable and at most 20 megapixels")
	}
	// Decode as well: a valid header does not prove the image data is complete.
	if _, _, err = image.Decode(bytes.NewReader(data)); err != nil {
		return "", 0, 0, 0, fmt.Errorf("photo must contain complete image data")
	}
	return mime, 1, cfg.Width, cfg.Height, nil
}
func ValidateIMSLP(value string) error {
	if value == "" {
		return nil
	}
	u, err := url.Parse(value)
	if err != nil || u.Scheme != "https" || (u.Host != "imslp.org" && u.Host != "www.imslp.org") || u.User != nil || !strings.HasPrefix(u.Path, "/wiki/") || len(value) > 2000 {
		return fmt.Errorf("IMSLP link must be an HTTPS work link on imslp.org/wiki/")
	}
	return nil
}
func validateManifest(manifest EditManifest, sources []ImportAsset, allowEmpty bool) error {
	if manifest.Version != 1 || len(manifest.Pages) > 100 || (!allowEmpty && len(manifest.Pages) == 0) {
		return fmt.Errorf("manifest must contain 1 to 100 pages and version 1")
	}
	assets := map[string]ImportAsset{}
	for _, a := range sources {
		assets[a.ID] = a
	}
	seen := map[string]bool{}
	for _, p := range manifest.Pages {
		if _, err := uuid.Parse(p.ID); err != nil || seen[p.ID] {
			return fmt.Errorf("pages must have unique UUID identifiers")
		}
		seen[p.ID] = true
		a, ok := assets[p.SourceID]
		if !ok || p.Page < 0 || p.Page >= a.PageCount {
			return fmt.Errorf("page must refer to a source in this draft")
		}
		if math.IsNaN(p.Angle) || math.IsInf(p.Angle, 0) || math.Abs(p.Angle) > 10 || p.Rotation%90 != 0 || p.Rotation < 0 || p.Rotation > 270 || p.Scale < 0 || p.Scale > 3 || math.Abs(p.X) > 1 || math.Abs(p.Y) > 1 {
			return fmt.Errorf("page adjustment must be within supported bounds")
		}
		if (p.OutputWidth != 0 || p.OutputHeight != 0) && (p.OutputWidth < 36 || p.OutputWidth > 14400 || p.OutputHeight < 36 || p.OutputHeight > 14400 || math.IsNaN(p.OutputWidth) || math.IsNaN(p.OutputHeight)) {
			return fmt.Errorf("output canvas must have two dimensions between 36 and 14400 PDF points")
		}
		if len(p.Crop) > 0 && (len(p.Crop) != 4 || !unitValues(p.Crop) || p.Crop[2]-p.Crop[0] < .05 || p.Crop[3]-p.Crop[1] < .05) {
			return fmt.Errorf("crop must have four normalized edges enclosing an area")
		}
		if p.PaperCleanup && a.MIME == "application/pdf" {
			return fmt.Errorf("paper cleanup is available for photos only")
		}
		if len(p.Corners) > 0 {
			if a.MIME == "application/pdf" || len(p.Corners) != 4 {
				return fmt.Errorf("perspective corners must belong to a photo")
			}
			for _, c := range p.Corners {
				if len(c) != 2 || !unitValues(c) {
					return fmt.Errorf("perspective corners must be normalized pairs")
				}
			}
			for i, c := range p.Corners {
				d, e := p.Corners[(i+1)%4], p.Corners[(i+2)%4]
				if (d[0]-c[0])*(e[1]-d[1])-(d[1]-c[1])*(e[0]-d[0]) <= .0001 {
					return fmt.Errorf("perspective corners must form a clockwise convex page")
				}
			}
		}
	}
	return nil
}
func unitValues(v []float64) bool {
	for _, n := range v {
		if math.IsNaN(n) || math.IsInf(n, 0) || n < 0 || n > 1 {
			return false
		}
	}
	return true
}
