package httpapi

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/bitofbytes-io/noted/internal/app"
)

func TestIMSLPWorkSearchRequiresValidQueryAndReturnsWork(t *testing.T) {
	fake := &fakeBackend{}
	router := testRouter(fake, 1024)
	for _, path := range []string{"/api/imslp/works", "/api/imslp/works?q=x"} {
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusBadRequest || fake.imslpQuery != "" {
			t.Fatalf("invalid search %s: %d %s", path, response.Code, response.Body.String())
		}
	}
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/imslp/works?q=Prelude", nil))
	if response.Code != http.StatusOK || fake.imslpQuery != "Prelude" || fake.imslpUserID != testUserID ||
		!strings.Contains(response.Body.String(), `"status":"ready"`) {
		t.Fatalf("work search: %d %s", response.Code, response.Body.String())
	}
}

func TestIMSLPWorkSearchMapsPerUserLimitTo429(t *testing.T) {
	fake := &fakeBackend{imslpErr: fmt.Errorf("search: %w", app.ErrIMSLPThrottled)}
	response := httptest.NewRecorder()
	testRouter(fake, 1024).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/imslp/works?q=Prelude", nil))
	if response.Code != http.StatusTooManyRequests || response.Header().Get("Retry-After") != "1" ||
		!strings.Contains(response.Body.String(), `"status":"throttled"`) ||
		!strings.Contains(response.Body.String(), `"results":[]`) {
		t.Fatalf("throttled search: %d %v %s", response.Code, response.Header(), response.Body.String())
	}
}

func TestListPassesSearchAndFavoriteFilters(t *testing.T) {
	fake := &fakeBackend{}
	request := httptest.NewRequest(http.MethodGet, "/api/pieces/?q=bach&favorite=true", nil)
	response := httptest.NewRecorder()
	testRouter(fake, 1024).ServeHTTP(response, request)
	if response.Code != http.StatusOK || fake.listQuery != "bach" ||
		fake.listUserID != testUserID || fake.listFavorite == nil || !*fake.listFavorite {
		t.Fatalf("filters not passed: status=%d query=%q favorite=%v", response.Code, fake.listQuery, fake.listFavorite)
	}

	// The service folds the search, so the handler passes it on as typed.
	fake = &fakeBackend{}
	request = httptest.NewRequest(http.MethodGet, "/api/pieces/?q=Dvo%C5%99%C3%A1k+100%25+a_b", nil)
	response = httptest.NewRecorder()
	testRouter(fake, 1024).ServeHTTP(response, request)
	if response.Code != http.StatusOK || fake.listQuery != "Dvořák 100% a_b" {
		t.Fatalf("search not passed as typed: status=%d query=%q", response.Code, fake.listQuery)
	}
}

func TestListStatusFilter(t *testing.T) {
	for _, test := range []struct {
		path string
		want []string
	}{
		// Absent means Learning and Playing.
		{"/api/pieces/", []string{"learning", "playing"}},
		// A search never hides a Shelved piece.
		{"/api/pieces/?q=bach", nil},
		{"/api/pieces/?q=Fr%C3%A9d%C3%A9ric", nil},
		// Punctuation alone folds to no search at all.
		{"/api/pieces/?q=%25+_", []string{"learning", "playing"}},
		{"/api/pieces/?status=all", nil},
		{"/api/pieces/?status=shelved", []string{"shelved"}},
		// An explicit filter still applies while searching.
		{"/api/pieces/?q=bach&status=learning", []string{"learning"}},
		{"/api/pieces/?status=playing,learning,playing", []string{"playing", "learning"}},
	} {
		fake := &fakeBackend{}
		response := httptest.NewRecorder()
		testRouter(fake, 1024).ServeHTTP(response, httptest.NewRequest(http.MethodGet, test.path, nil))
		if response.Code != http.StatusOK || fmt.Sprint(fake.listStatuses) != fmt.Sprint(test.want) ||
			(test.want == nil) != (fake.listStatuses == nil) {
			t.Fatalf("%s: status=%d statuses=%v, want %v", test.path, response.Code, fake.listStatuses, test.want)
		}
	}
	for _, path := range []string{"/api/pieces/?status=archived", "/api/pieces/?status=learning,"} {
		fake := &fakeBackend{}
		response := httptest.NewRecorder()
		testRouter(fake, 1024).ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusBadRequest || fake.listCalls != 0 {
			t.Fatalf("%s: status=%d calls=%d", path, response.Code, fake.listCalls)
		}
	}
}

func TestListSort(t *testing.T) {
	for path, want := range map[string]string{
		"/api/pieces/":                       "title",
		"/api/pieces/?sort=composer":         "composer",
		"/api/pieces/?sort=recent":           "recent",
		"/api/pieces/?sort=added":            "added",
		"/api/pieces/?q=bach&sort=fresh":     "fresh",
		"/api/pieces/?sort=title&status=all": "title",
	} {
		fake := &fakeBackend{}
		response := httptest.NewRecorder()
		testRouter(fake, 1024).ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusOK || fake.listSort != want {
			t.Fatalf("%s: status=%d sort=%q, want %q", path, response.Code, fake.listSort, want)
		}
	}
	for _, path := range []string{"/api/pieces/?sort=favorite", "/api/pieces/?sort=title%20DESC", "/api/pieces/?sort=Recent"} {
		fake := &fakeBackend{}
		response := httptest.NewRecorder()
		testRouter(fake, 1024).ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusBadRequest || fake.listCalls != 0 ||
			!strings.Contains(response.Body.String(), "sort must be") {
			t.Fatalf("%s: status=%d calls=%d body=%s", path, response.Code, fake.listCalls, response.Body.String())
		}
	}
}

func TestListSummaries(t *testing.T) {
	played := time.Date(2026, 10, 18, 20, 0, 0, 0, time.UTC)
	fake := &fakeBackend{summaries: []app.PieceSummary{{
		ID: testPieceID, Title: "Humoresque", Composer: "Antonín Dvořák", Aliases: "Op. 101",
		Status: "playing", PDF: &app.SummaryPDF{PageCount: 3, ContentURL: "/api/pieces/" + testPieceID + "/pdf"},
		LastPlayedAt: &played, CreatedAt: played.Add(-time.Hour),
		SearchText: "humoresque antonin dvorak op 101 slow and singing",
	}}}
	response := httptest.NewRecorder()
	testRouter(fake, 1024).ServeHTTP(response,
		httptest.NewRequest(http.MethodGet, "/api/pieces/?fields=summary&status=all", nil))
	want := `[{"id":"` + testPieceID + `","title":"Humoresque","composer":"Antonín Dvořák",` +
		`"aliases":"Op. 101","favorite":false,"status":"playing","listeningUrl":"",` +
		`"pdf":{"pageCount":3,"contentUrl":"/api/pieces/` + testPieceID + `/pdf"},` +
		`"lastPlayedAt":"2026-10-18T20:00:00Z","createdAt":"2026-10-18T19:00:00Z",` +
		`"searchText":"humoresque antonin dvorak op 101 slow and singing"}]` + "\n"
	if response.Code != http.StatusOK || response.Body.String() != want ||
		fake.summaryCalls != 1 || fake.listCalls != 0 || fake.listUserID != testUserID ||
		fake.listStatuses != nil || fake.listSort != "title" {
		t.Fatalf("summaries: %d %s calls=%d/%d statuses=%v sort=%q",
			response.Code, response.Body.String(), fake.summaryCalls, fake.listCalls, fake.listStatuses, fake.listSort)
	}
	// No notes in a summary.
	if strings.Contains(response.Body.String(), "notes") {
		t.Fatalf("summary carries notes: %s", response.Body.String())
	}

	// The filters apply to summaries as to the full list.
	fake = &fakeBackend{}
	response = httptest.NewRecorder()
	testRouter(fake, 1024).ServeHTTP(response,
		httptest.NewRequest(http.MethodGet, "/api/pieces/?fields=summary&q=bach&favorite=true&sort=recent", nil))
	if response.Code != http.StatusOK || response.Body.String() != "[]\n" || fake.listQuery != "bach" ||
		fake.listFavorite == nil || !*fake.listFavorite || fake.listSort != "recent" {
		t.Fatalf("filtered summaries: %d %s", response.Code, response.Body.String())
	}

	fake = &fakeBackend{}
	response = httptest.NewRecorder()
	testRouter(fake, 1024).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/pieces/?fields=notes", nil))
	if response.Code != http.StatusBadRequest || fake.listCalls+fake.summaryCalls != 0 ||
		!strings.Contains(response.Body.String(), "fields must be summary") {
		t.Fatalf("unknown fields: %d %s", response.Code, response.Body.String())
	}
}
