package assets

import (
	"bytes"
	"encoding/xml"
	"fmt"
	"io"
	"mime/multipart"
	"path/filepath"
	"strings"
)

type Format struct {
	AssetType string
	MediaType string
	Extension string
}

func DetectUpload(header *multipart.FileHeader, file multipart.File) (Format, io.Reader, error) {
	const sniffSize = 64 << 10
	prefix, err := io.ReadAll(io.LimitReader(file, sniffSize))
	if err != nil {
		return Format{}, nil, fmt.Errorf("read upload header: %w", err)
	}
	ext := strings.ToLower(filepath.Ext(header.Filename))
	if ext == ".pdf" && bytes.HasPrefix(bytes.TrimSpace(prefix), []byte("%PDF-")) {
		return Format{AssetType: "pdf", MediaType: "application/pdf", Extension: ".pdf"}, io.MultiReader(bytes.NewReader(prefix), file), nil
	}
	if ext == ".musicxml" || ext == ".xml" {
		decoder := xml.NewDecoder(bytes.NewReader(prefix))
		for {
			token, tokenErr := decoder.Token()
			if tokenErr != nil {
				break
			}
			if start, ok := token.(xml.StartElement); ok {
				if start.Name.Local == "score-partwise" || start.Name.Local == "score-timewise" {
					return Format{AssetType: "musicxml", MediaType: "application/vnd.recordare.musicxml+xml", Extension: ext}, io.MultiReader(bytes.NewReader(prefix), file), nil
				}
				break
			}
		}
	}
	return Format{}, nil, fmt.Errorf("file content does not match a supported PDF or MusicXML extension")
}
