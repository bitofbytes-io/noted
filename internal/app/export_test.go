package app

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/bitofbytes-io/noted/internal/assets"
)

func TestExportLimiterConcurrentStarts(t *testing.T) {
	now := time.Unix(1000, 0)
	limiter := newExportLimiter(func() time.Time { return now })
	start := make(chan struct{})
	winners := make(chan func(), 32)
	var attempts sync.WaitGroup
	for range 32 {
		attempts.Add(1)
		go func() {
			defer attempts.Done()
			<-start
			if release, _ := limiter.acquire("same-owner"); release != nil {
				winners <- release
			}
		}()
	}
	close(start)
	attempts.Wait()
	close(winners)
	count := 0
	for release := range winners {
		count++
		release()
	}
	if count != 1 {
		t.Fatalf("concurrent starts admitted %d exports", count)
	}
}

type exportTestSnapshot struct {
	records      []exportRecord
	calls        int
	failPage     int
	commitErr    error
	committed    bool
	beforeCommit func()
}

func (s *exportTestSnapshot) page(_ context.Context, after string) ([]exportRecord, error) {
	s.calls++
	if s.calls == s.failPage {
		return nil, errors.New("private SQL error")
	}
	var result []exportRecord
	for _, r := range s.records {
		if after == "" || r.piece.ID > after {
			result = append(result, r)
			if len(result) == exportPageSize {
				break
			}
		}
	}
	return result, nil
}
func (s *exportTestSnapshot) commit(context.Context) error {
	if s.beforeCommit != nil {
		s.beforeCommit()
	}
	if s.commitErr != nil {
		return s.commitErr
	}
	s.committed = true
	return nil
}

type exportTestStore struct {
	assets.Store
	open func(context.Context, string) (assets.ReadSeekCloser, error)
}

func (s exportTestStore) Open(ctx context.Context, key string) (assets.ReadSeekCloser, error) {
	return s.open(ctx, key)
}

type exportTestReader struct {
	io.Reader
	closed   *int
	closeErr error
}

func (r *exportTestReader) Close() error { *r.closed++; return r.closeErr }
func (*exportTestReader) Seek(int64, int) (int64, error) {
	return 0, errors.New("export must not seek")
}
func exportTestRecord(i int, data []byte) exportRecord {
	r := exportRecord{piece: exportPiece{ID: fmt.Sprintf("%08x-0000-4000-8000-%012x", i, i), Title: "=Private title", Status: StatusShelved, Aliases: "+Alias", Notes: "@notes"}, key: "private-key"}
	if data != nil {
		sum := sha256.Sum256(data)
		r.piece.PDF = &exportPDF{OriginalFilename: "original.pdf", SizeBytes: int64(len(data)), ChecksumSHA256: hex.EncodeToString(sum[:]), PageCount: 1}
	}
	return r
}
func readExportZIP(t *testing.T, data []byte) map[string][]byte {
	t.Helper()
	archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	result := map[string][]byte{}
	for _, f := range archive.File {
		r, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(r)
		closeErr := r.Close()
		if err != nil || closeErr != nil {
			t.Fatal(err, closeErr)
		}
		if _, exists := result[f.Name]; exists {
			t.Fatal("duplicate ZIP name")
		}
		result[f.Name] = body
	}
	return result
}
func TestExportMetadataAndEmptyArchive(t *testing.T) {
	for _, empty := range []bool{false, true} {
		t.Run(fmt.Sprint(empty), func(t *testing.T) {
			data := []byte("rights-safe synthetic PDF bytes")
			record := exportTestRecord(1, data)
			record.piece.Favorite = true
			record.piece.Opus, record.piece.MusicKey = "Op. 10", "C♯ minor"
			snapshot := &exportTestSnapshot{}
			if !empty {
				snapshot.records = []exportRecord{record, exportTestRecord(2, nil)}
			}
			closed := 0
			store := exportTestStore{open: func(context.Context, string) (assets.ReadSeekCloser, error) {
				return &exportTestReader{Reader: bytes.NewReader(data), closed: &closed}, nil
			}}
			var output bytes.Buffer
			snapshot.beforeCommit = func() {
				if _, err := zip.NewReader(bytes.NewReader(output.Bytes()), int64(output.Len())); err == nil {
					t.Error("archive finalized before commit")
				}
			}
			if err := streamLibrary(context.Background(), &output, snapshot, store, time.Unix(123, 0)); err != nil {
				t.Fatal(err)
			}
			files := readExportZIP(t, output.Bytes())
			var manifest struct {
				SchemaVersion int           `json:"schemaVersion"`
				Pieces        []exportPiece `json:"pieces"`
			}
			if err := json.Unmarshal(files["library.json"], &manifest); err != nil {
				t.Fatal(err)
			}
			rows, err := csv.NewReader(bytes.NewReader(files["pieces.csv"])).ReadAll()
			if err != nil {
				t.Fatal(err)
			}
			if manifest.SchemaVersion != 1 || !snapshot.committed {
				t.Fatal("missing version/commit")
			}
			if empty {
				if len(files) != 2 || len(rows) != 1 || len(manifest.Pieces) != 0 {
					t.Fatal("invalid empty export")
				}
				return
			}
			if len(manifest.Pieces) != 2 || manifest.Pieces[0].ReaderState != nil || manifest.Pieces[1].PDF != nil {
				t.Fatal("synthesized or missing metadata")
			}
			if manifest.Pieces[0].Opus != "Op. 10" || manifest.Pieces[0].MusicKey != "C♯ minor" || rows[0][18] != "opus" || rows[0][19] != "musicKey" || rows[1][18] != "Op. 10" || rows[1][19] != "C♯ minor" {
				t.Fatal("musical metadata missing from export")
			}
			if !bytes.Equal(files[manifest.Pieces[0].PDF.Path], data) || closed != 1 {
				t.Fatal("PDF/close mismatch")
			}
			if manifest.Pieces[0].Title != "=Private title" || rows[1][1] != "'=Private title" || rows[1][3] != "'+Alias" || rows[1][8] != "'@notes" {
				t.Fatal("JSON/CSV changed unsafe metadata incorrectly")
			}
			if bytes.Contains(files["library.json"], []byte("private-key")) || bytes.Contains(files["library.json"], []byte("contentUrl")) {
				t.Fatal("internal data leaked")
			}
		})
	}
}
func TestExportNamesAndFormulaSafety(t *testing.T) {
	for _, title := range []string{
		"../../evil\\path\x00\n", " . ", "CON", strings.Repeat("曲", 200), "same",
		"CON.txt", "cOn.TxT", "AUX.music", "aUx.MUSIC", "PRN.pdf", "NUL.score",
		"COM1.ext", "com9.ext", "LPT1.ext", "lPt9.ext",
		"COM¹.ext", "LPT¹.ext", "COM².ext", "LPT³.ext", "CONIN$.txt", "CONOUT$.txt",
	} {
		a, err := exportScorePath(title, "aaaaaaaa-0000-4000-8000-000000000001", 1)
		if err != nil {
			t.Fatal(err)
		}
		b, err := exportScorePath(title, "aaaaaaaa-0000-4000-8000-000000000002", 2)
		if err != nil {
			t.Fatal(err)
		}
		if a == b || path.Clean(a) != a || !strings.HasPrefix(a, "scores/score-") || strings.ContainsAny(strings.TrimPrefix(a, "scores/"), "/\\\x00\n") || len(path.Base(a)) > 160 || !utf8.ValidString(a) {
			t.Fatalf("unsafe/colliding name: %q %q", a, b)
		}
		stem, _, _ := strings.Cut(path.Base(a), ".")
		switch strings.ToUpper(strings.TrimRight(stem, " ")) {
		case "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$",
			"COM1", "COM9", "LPT1", "LPT9", "COM¹", "LPT¹", "COM²", "LPT³":
			t.Fatalf("reserved Windows device name: %q", a)
		}
	}
	for _, value := range []string{"=1+1", " +1", "\ttext", "\rtext", "\ntext", "\u2003@SUM(A1)", "-1"} {
		if !strings.HasPrefix(exportCSVCell(value), "'") {
			t.Fatalf("unprotected %q", value)
		}
	}
	if exportCSVCell("Bach, J.S.") != "Bach, J.S." {
		t.Fatal("ordinary text changed")
	}
}

type exportReadFunc func([]byte) (int, error)

func (f exportReadFunc) Read(p []byte) (int, error) { return f(p) }
func TestExportFailuresNeverFinalizeArchive(t *testing.T) {
	for _, failure := range []string{"open", "short", "extra", "checksum", "read", "close", "commit", "cancel", "page"} {
		t.Run(failure, func(t *testing.T) {
			data := []byte("score data")
			record := exportTestRecord(1, data)
			snapshot := &exportTestSnapshot{records: []exportRecord{record}}
			closed := 0
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if failure == "commit" {
				snapshot.commitErr = errors.New("commit failed")
			}
			if failure == "page" {
				for i := 2; i <= exportPageSize; i++ {
					snapshot.records = append(snapshot.records, exportTestRecord(i, nil))
				}
				snapshot.failPage = 2
			}
			store := exportTestStore{open: func(context.Context, string) (assets.ReadSeekCloser, error) {
				if failure == "open" {
					return nil, errors.New("private missing path")
				}
				var reader io.Reader = bytes.NewReader(data)
				var closeErr error
				switch failure {
				case "short":
					reader = bytes.NewReader(data[:2])
				case "extra":
					reader = bytes.NewReader(append(data, '!'))
				case "checksum":
					reader = bytes.NewReader([]byte("SCORE DATA"))
				case "read":
					reader = exportReadFunc(func([]byte) (int, error) { return 0, errors.New("read failed") })
				case "close":
					closeErr = errors.New("close failed")
				case "cancel":
					reader = exportReadFunc(func(p []byte) (int, error) { cancel(); return copy(p, data), nil })
				}
				return &exportTestReader{Reader: reader, closed: &closed, closeErr: closeErr}, nil
			}}
			var output bytes.Buffer
			if err := streamLibrary(ctx, &output, snapshot, store, time.Now()); err == nil {
				t.Fatal("failure was ignored")
			}
			if _, err := zip.NewReader(bytes.NewReader(output.Bytes()), int64(output.Len())); err == nil {
				t.Fatal("partial export was a valid ZIP")
			}
			if failure != "open" && failure != "page" && closed != 1 {
				t.Fatalf("reader closed %d times", closed)
			}
			if snapshot.committed {
				t.Fatal("failed export committed")
			}
		})
	}
}

type exportCountingWriter struct {
	written   int64
	failAfter int64
}

func (w *exportCountingWriter) Write(p []byte) (int, error) {
	if w.failAfter > 0 && w.written >= w.failAfter {
		return 0, errors.New("client gone")
	}
	w.written += int64(len(p))
	return len(p), nil
}
func TestExportStreamsLargeAssetsAndClosesOnWriterFailure(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(fmt.Sprint(fail), func(t *testing.T) {
			const size = 16 << 20
			hash := sha256.New()
			if _, err := io.CopyN(hash, exportReadFunc(func(p []byte) (int, error) { clear(p); return len(p), nil }), size); err != nil {
				t.Fatal(err)
			}
			r := exportTestRecord(1, []byte("x"))
			r.piece.PDF.SizeBytes = size
			r.piece.PDF.ChecksumSHA256 = hex.EncodeToString(hash.Sum(nil))
			snapshot := &exportTestSnapshot{records: []exportRecord{r, r}}
			snapshot.records[1].piece.ID = "00000002-0000-4000-8000-000000000002"
			output := &exportCountingWriter{}
			if fail {
				output.failAfter = 64 << 10
			}
			closed, opened := 0, 0
			store := exportTestStore{open: func(context.Context, string) (assets.ReadSeekCloser, error) {
				if opened != closed {
					t.Fatal("more than one reader open")
				}
				opened++
				left := int64(size)
				reader := exportReadFunc(func(p []byte) (int, error) {
					if output.written == 0 {
						t.Fatal("no streaming output before asset read")
					}
					if len(p) > 32<<10 {
						t.Fatal("unbounded read")
					}
					if left == 0 {
						return 0, io.EOF
					}
					n := min(int64(len(p)), left)
					clear(p[:n])
					left -= n
					return int(n), nil
				})
				return &exportTestReader{Reader: reader, closed: &closed}, nil
			}}
			err := streamLibrary(context.Background(), output, snapshot, store, time.Now())
			if (err != nil) != fail || opened != closed {
				t.Fatalf("error=%v opened=%d closed=%d", err, opened, closed)
			}
			if !fail && output.written < 2*size {
				t.Fatal("large assets omitted")
			}
		})
	}
}
func TestExportLimiterRateConcurrencyAndActiveRetention(t *testing.T) {
	now := time.Unix(1000, 0)
	limiter := newExportLimiter(func() time.Time { return now })
	release, wait := limiter.acquire("a")
	if release == nil || wait != 0 {
		t.Fatal("first start refused")
	}
	if next, wait := limiter.acquire("a"); next != nil || wait <= 0 {
		t.Fatal("concurrent export allowed")
	}
	other, _ := limiter.acquire("b")
	if other == nil {
		t.Fatal("owners share limit")
	}
	other()
	now = now.Add(20 * time.Minute)
	if next, _ := limiter.acquire("a"); next != nil {
		t.Fatal("active entry evicted")
	}
	release()
	release()
	next, _ := limiter.acquire("a")
	if next == nil {
		t.Fatal("slot not released")
	}
	next()
	if next, wait := limiter.acquire("a"); next != nil || wait < 299*time.Second {
		t.Fatal("rate not enforced")
	}
	now = now.Add(5 * time.Minute)
	next, _ = limiter.acquire("a")
	if next == nil {
		t.Fatal("token did not refill")
	}
	next()
}
