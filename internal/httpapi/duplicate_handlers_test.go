package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/bitofbytes-io/noted/internal/app"
)

func duplicateFinalizeRequest(t *testing.T, draftID string, revision int64, pdf []byte) *http.Request {
	t.Helper()
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	if err := form.WriteField("revision", strconv.FormatInt(revision, 10)); err != nil {
		t.Fatal(err)
	}
	file, err := form.CreateFormFile("file", "score.pdf")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write(pdf); err != nil {
		t.Fatal(err)
	}
	if err := form.Close(); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/imports/"+draftID+"/finalize", &body)
	request.Header.Set("Content-Type", form.FormDataContentType())
	return request
}

type duplicateBackend struct {
	*fakeBackend
	ImportBackend
	result app.FinalizeResult
	owner  string
}

func (b *duplicateBackend) FinalizeImport(_ context.Context, owner, _ string, _ int64, _ io.Reader) (app.FinalizeResult, error) {
	b.owner = owner
	return b.result, nil
}

func TestDuplicateFinalizeResponseKeepsPieceShape(t *testing.T) {
	for _, duplicate := range []*app.DuplicatePiece{nil, {ID: "existing", Title: "<b>Existing score</b>"}} {
		backend := &duplicateBackend{
			fakeBackend: &fakeBackend{},
			result: app.FinalizeResult{
				Piece:       app.Piece{ID: "saved", Title: "Saved score"},
				DuplicateOf: duplicate,
			},
		}
		response := serve(testRouter(backend, 1024), duplicateFinalizeRequest(t, "00000000-0000-4000-8000-000000000001", 1, []byte("pdf")))
		var result app.FinalizeResult
		if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &result) != nil || result.ID != "saved" || result.Title != "Saved score" || backend.owner != testUserID {
			t.Fatal("piece response compatibility", response.Code, response.Body.String())
		}
		if duplicate == nil {
			if bytes.Contains(response.Body.Bytes(), []byte("duplicateOf")) {
				t.Fatal("absent warning should be omitted")
			}
		} else if result.DuplicateOf == nil || *result.DuplicateOf != *duplicate {
			t.Fatal("warning metadata changed")
		}
	}
}
