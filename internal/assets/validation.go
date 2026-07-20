package assets

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"path"
	"path/filepath"
	"strings"
)

type Format struct {
	AssetType string
	MediaType string
	Extension string
}

var ErrUnsupportedUpload = errors.New("unsupported score or playback-media upload")

func DetectUpload(header *multipart.FileHeader, file multipart.File) (Format, io.Reader, error) {
	const sniffSize = 64 << 10
	ext := strings.ToLower(filepath.Ext(header.Filename))
	if ext == ".mxl" {
		format, stream, err := detectCompressedMusicXML(file)
		if err != nil {
			return Format{}, nil, fmt.Errorf("%w: %v", ErrUnsupportedUpload, err)
		}
		return format, stream, nil
	}
	prefix, err := io.ReadAll(io.LimitReader(file, sniffSize))
	if err != nil {
		return Format{}, nil, fmt.Errorf("read upload header: %w", err)
	}
	if ext == ".pdf" && bytes.HasPrefix(bytes.TrimSpace(prefix), []byte("%PDF-")) {
		return Format{AssetType: "pdf", MediaType: "application/pdf", Extension: ".pdf"}, io.MultiReader(bytes.NewReader(prefix), file), nil
	}
	if (ext == ".mid" || ext == ".midi") && bytes.HasPrefix(prefix, []byte("MThd")) {
		return Format{AssetType: "midi", MediaType: "audio/midi", Extension: ext}, io.MultiReader(bytes.NewReader(prefix), file), nil
	}
	if ext == ".mp3" && (bytes.HasPrefix(prefix, []byte("ID3")) || hasMP3FrameSync(prefix)) {
		return Format{AssetType: "audio", MediaType: "audio/mpeg", Extension: ext}, io.MultiReader(bytes.NewReader(prefix), file), nil
	}
	if (ext == ".m4a" || ext == ".mp4") && isMP4Audio(prefix) {
		return Format{AssetType: "audio", MediaType: "audio/mp4", Extension: ext}, io.MultiReader(bytes.NewReader(prefix), file), nil
	}
	if (ext == ".ogg" || ext == ".oga") && bytes.HasPrefix(prefix, []byte("OggS")) {
		return Format{AssetType: "audio", MediaType: "audio/ogg", Extension: ext}, io.MultiReader(bytes.NewReader(prefix), file), nil
	}
	if (ext == ".jpg" || ext == ".jpeg") && len(prefix) >= 3 && prefix[0] == 0xff && prefix[1] == 0xd8 && prefix[2] == 0xff {
		return Format{AssetType: "image", MediaType: "image/jpeg", Extension: ext}, io.MultiReader(bytes.NewReader(prefix), file), nil
	}
	if ext == ".png" && bytes.HasPrefix(prefix, []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}) {
		return Format{AssetType: "image", MediaType: "image/png", Extension: ext}, io.MultiReader(bytes.NewReader(prefix), file), nil
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
	return Format{}, nil, fmt.Errorf("%w: file content does not match its extension", ErrUnsupportedUpload)
}

func hasMP3FrameSync(data []byte) bool {
	return len(data) >= 2 && data[0] == 0xff && data[1]&0xe0 == 0xe0
}

func isMP4Audio(data []byte) bool {
	if len(data) < 12 || !bytes.Equal(data[4:8], []byte("ftyp")) {
		return false
	}
	brand := string(data[8:12])
	return brand == "M4A " || brand == "M4B " || brand == "mp42" || brand == "isom"
}

const (
	maxCompressedMusicXMLEntries = 128
	maxCompressedMusicXMLBytes   = 64 << 20
	maxContainerXMLBytes         = 256 << 10
	maxCompressedScoreBytes      = 32 << 20
)

type compressedMusicXMLContainer struct {
	Rootfiles []struct {
		FullPath string `xml:"full-path,attr"`
	} `xml:"rootfiles>rootfile"`
}

func detectCompressedMusicXML(file multipart.File) (Format, io.Reader, error) {
	size, err := file.Seek(0, io.SeekEnd)
	if err != nil {
		return Format{}, nil, fmt.Errorf("measure compressed MusicXML: %w", err)
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return Format{}, nil, fmt.Errorf("rewind compressed MusicXML: %w", err)
	}
	archive, err := zip.NewReader(file, size)
	if err != nil {
		return Format{}, nil, fmt.Errorf("compressed MusicXML is not a valid ZIP container: %w", err)
	}
	if len(archive.File) == 0 || len(archive.File) > maxCompressedMusicXMLEntries {
		return Format{}, nil, fmt.Errorf("compressed MusicXML must contain between 1 and %d entries", maxCompressedMusicXMLEntries)
	}

	var (
		containerEntry *zip.File
		totalExpanded  uint64
	)
	for _, entry := range archive.File {
		if !safeArchivePath(entry.Name) {
			return Format{}, nil, fmt.Errorf("compressed MusicXML contains an unsafe entry path")
		}
		totalExpanded += entry.UncompressedSize64
		if totalExpanded > maxCompressedMusicXMLBytes {
			return Format{}, nil, fmt.Errorf("compressed MusicXML expands beyond %d bytes", maxCompressedMusicXMLBytes)
		}
		if entry.Name == "META-INF/container.xml" {
			containerEntry = entry
		}
	}
	if containerEntry == nil {
		return Format{}, nil, fmt.Errorf("compressed MusicXML is missing META-INF/container.xml")
	}
	containerData, err := readZipEntry(containerEntry, maxContainerXMLBytes)
	if err != nil {
		return Format{}, nil, fmt.Errorf("read compressed MusicXML container: %w", err)
	}
	var container compressedMusicXMLContainer
	if err := xml.Unmarshal(containerData, &container); err != nil || len(container.Rootfiles) == 0 {
		return Format{}, nil, fmt.Errorf("compressed MusicXML container has no valid rootfile")
	}
	rootPath := container.Rootfiles[0].FullPath
	if !safeArchivePath(rootPath) {
		return Format{}, nil, fmt.Errorf("compressed MusicXML rootfile has an unsafe path")
	}
	rootExtension := strings.ToLower(path.Ext(rootPath))
	if rootExtension != ".musicxml" && rootExtension != ".xml" {
		return Format{}, nil, fmt.Errorf("compressed MusicXML rootfile must be MusicXML")
	}
	var scoreEntry *zip.File
	for _, entry := range archive.File {
		if entry.Name == rootPath {
			scoreEntry = entry
			break
		}
	}
	if scoreEntry == nil {
		return Format{}, nil, fmt.Errorf("compressed MusicXML rootfile is missing")
	}
	scorePrefix, err := readZipEntry(scoreEntry, maxCompressedScoreBytes)
	if err != nil {
		return Format{}, nil, fmt.Errorf("read compressed MusicXML score: %w", err)
	}
	if !hasMusicXMLRoot(scorePrefix) {
		return Format{}, nil, fmt.Errorf("compressed MusicXML rootfile is not a score")
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return Format{}, nil, fmt.Errorf("rewind compressed MusicXML: %w", err)
	}
	return Format{AssetType: "musicxml", MediaType: "application/vnd.recordare.musicxml", Extension: ".mxl"}, file, nil
}

func safeArchivePath(name string) bool {
	if name == "" || strings.Contains(name, "\\") || path.IsAbs(name) {
		return false
	}
	cleaned := path.Clean(name)
	return cleaned != "." && cleaned != ".." && !strings.HasPrefix(cleaned, "../") && cleaned == strings.TrimSuffix(name, "/")
}

func readZipEntry(entry *zip.File, maxBytes int64) ([]byte, error) {
	if entry.UncompressedSize64 > uint64(maxBytes) {
		return nil, fmt.Errorf("entry expands beyond %d bytes", maxBytes)
	}
	reader, err := entry.Open()
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	data, err := io.ReadAll(io.LimitReader(reader, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxBytes {
		return nil, fmt.Errorf("entry expands beyond %d bytes", maxBytes)
	}
	return data, nil
}

func hasMusicXMLRoot(data []byte) bool {
	decoder := xml.NewDecoder(bytes.NewReader(data))
	for {
		token, err := decoder.Token()
		if err != nil {
			return false
		}
		if start, ok := token.(xml.StartElement); ok {
			return start.Name.Local == "score-partwise" || start.Name.Local == "score-timewise"
		}
	}
}
