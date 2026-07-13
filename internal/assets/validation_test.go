package assets

import (
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

func uploadFile(t *testing.T, contents string) *os.File {
	t.Helper()
	file, err := os.CreateTemp(t.TempDir(), "upload")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = file.Close() })
	if _, err := file.WriteString(contents); err != nil {
		t.Fatal(err)
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	return file
}
