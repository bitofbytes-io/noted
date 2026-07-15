package assets

import (
	"archive/zip"
	"bytes"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"os"
	"testing"
)

func TestDetectUploadValidatesExtensionAndContent(t *testing.T) {
	tests := []struct {
		name      string
		filename  string
		contents  string
		assetType string
	}{
		{name: "pdf", filename: "score.pdf", contents: "%PDF-1.4\nfixture", assetType: "pdf"},
		{name: "musicxml", filename: "score.musicxml", contents: `<?xml version="1.0"?><score-partwise version="4.0"></score-partwise>`, assetType: "musicxml"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			file := uploadFile(t, test.contents)
			format, reader, err := DetectUpload(&multipart.FileHeader{Filename: test.filename}, file)
			if err != nil {
				t.Fatal(err)
			}
			if format.AssetType != test.assetType {
				t.Fatalf("asset type = %q, want %q", format.AssetType, test.assetType)
			}
			got, err := io.ReadAll(reader)
			if err != nil {
				t.Fatal(err)
			}
			if string(got) != test.contents {
				t.Fatal("upload reader did not preserve the complete file")
			}
		})
	}

	for _, test := range []struct {
		filename string
		contents string
	}{
		{filename: "spoofed.pdf", contents: `<score-partwise version="4.0"></score-partwise>`},
		{filename: "spoofed.musicxml", contents: "%PDF-1.4\nfixture"},
		{filename: "score.exe", contents: "%PDF-1.4\nfixture"},
	} {
		file := uploadFile(t, test.contents)
		if _, _, err := DetectUpload(&multipart.FileHeader{Filename: test.filename}, file); err == nil {
			t.Fatalf("expected %q with mismatched content to be rejected", test.filename)
		}
	}
}

func TestDetectUploadAcceptsBoundedCompressedMusicXML(t *testing.T) {
	contents := compressedMusicXML(t, map[string]string{
		"META-INF/container.xml": `<?xml version="1.0"?><container><rootfiles><rootfile full-path="score.musicxml" media-type="application/vnd.recordare.musicxml+xml"/></rootfiles></container>`,
		"score.musicxml":         `<?xml version="1.0"?><score-partwise version="4.0"></score-partwise>`,
	})
	file := uploadBytes(t, contents)
	format, reader, err := DetectUpload(&multipart.FileHeader{Filename: "score.mxl", Size: int64(len(contents))}, file)
	if err != nil {
		t.Fatal(err)
	}
	if format.AssetType != "musicxml" || format.Extension != ".mxl" || format.MediaType != "application/vnd.recordare.musicxml" {
		t.Fatalf("unexpected compressed MusicXML format: %+v", format)
	}
	got, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, contents) {
		t.Fatal("compressed upload reader did not preserve the complete archive")
	}
}

func TestDetectUploadRejectsUnsafeOrOversizedCompressedMusicXMLContainers(t *testing.T) {
	tests := []struct {
		name    string
		entries map[string]string
	}{
		{
			name: "unsafe path",
			entries: map[string]string{
				"META-INF/container.xml": `<container><rootfiles><rootfile full-path="../score.musicxml"/></rootfiles></container>`,
				"../score.musicxml":      `<score-partwise></score-partwise>`,
			},
		},
		{
			name: "invalid score root",
			entries: map[string]string{
				"META-INF/container.xml": `<container><rootfiles><rootfile full-path="score.musicxml"/></rootfiles></container>`,
				"score.musicxml":         `%PDF-1.4`,
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			contents := compressedMusicXML(t, test.entries)
			file := uploadBytes(t, contents)
			if _, _, err := DetectUpload(&multipart.FileHeader{Filename: "score.mxl", Size: int64(len(contents))}, file); !errors.Is(err, ErrUnsupportedUpload) {
				t.Fatalf("compressed MusicXML error = %v, want ErrUnsupportedUpload", err)
			}
		})
	}

	manyEntries := map[string]string{
		"META-INF/container.xml": `<container><rootfiles><rootfile full-path="score.musicxml"/></rootfiles></container>`,
		"score.musicxml":         `<score-partwise></score-partwise>`,
	}
	for index := 0; index < maxCompressedMusicXMLEntries; index++ {
		manyEntries[fmt.Sprintf("extra/%03d.txt", index)] = "x"
	}
	contents := compressedMusicXML(t, manyEntries)
	file := uploadBytes(t, contents)
	if _, _, err := DetectUpload(&multipart.FileHeader{Filename: "score.mxl", Size: int64(len(contents))}, file); !errors.Is(err, ErrUnsupportedUpload) {
		t.Fatalf("entry limit error = %v, want ErrUnsupportedUpload", err)
	}
}

func uploadFile(t *testing.T, contents string) *os.File {
	return uploadBytes(t, []byte(contents))
}

func uploadBytes(t *testing.T, contents []byte) *os.File {
	t.Helper()
	file, err := os.CreateTemp(t.TempDir(), "upload")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = file.Close() })
	if _, err := file.Write(contents); err != nil {
		t.Fatal(err)
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	return file
}

func compressedMusicXML(t *testing.T, entries map[string]string) []byte {
	t.Helper()
	var contents bytes.Buffer
	writer := zip.NewWriter(&contents)
	for name, value := range entries {
		entry, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := io.WriteString(entry, value); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return contents.Bytes()
}
