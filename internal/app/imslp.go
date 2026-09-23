package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const imslpWorkListURL = "https://imslp.org/imslpscripts/API.ISCR.php?account=worklist/disclaimer=accepted/sort=id/type=2/start=%d/retformat=json"

const imslpCatalogLock int64 = 0x4e6f746564494d53

var errIMSLPCatalogBusy = errors.New("IMSLP catalogue refresh is already running")
var errIMSLPCatalogData = errors.New("invalid IMSLP worklist data")

type IMSLPWork struct {
	Title    string `json:"title"`
	Composer string `json:"composer"`
	URL      string `json:"url"`
}

type IMSLPSearch struct {
	Status  string      `json:"status"`
	Results []IMSLPWork `json:"results"`
}

type imslpRecord struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Permlink string `json:"permlink"`
	Intvals  struct {
		Title    string `json:"worktitle"`
		Composer string `json:"composer"`
	} `json:"intvals"`
}

func validIMSLPWorkURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && u.Scheme == "https" && (u.Host == "imslp.org" || u.Host == "www.imslp.org") &&
		u.User == nil && strings.HasPrefix(u.Path, "/wiki/") && len(u.Path) > len("/wiki/") &&
		u.RawQuery == "" && u.Fragment == ""
}

// IMSLP sometimes emits literal question marks in wiki titles. In an HTTP URL
// these would be read as a query, so encode only those title characters.
func canonicalIMSLPWorkURL(raw string) (string, bool) {
	if !strings.HasPrefix(raw, "https://imslp.org/wiki/") &&
		!strings.HasPrefix(raw, "https://www.imslp.org/wiki/") {
		return "", false
	}
	canonical := strings.ReplaceAll(strings.ReplaceAll(raw, "?", "%3F"), "#", "%23")
	return canonical, validIMSLPWorkURL(canonical)
}

// fetchIMSLPPage reads only IMSLP's documented worklist API, never edition or file pages.
func fetchIMSLPPage(ctx context.Context, client *http.Client, format string, start int) ([]imslpRecord, bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf(format, start), nil)
	if err != nil {
		return nil, false, err
	}
	req.Header.Set("User-Agent", "Noted/1.0 (private score binder; work catalogue cache)")
	safeClient := *client
	safeClient.CheckRedirect = func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}
	response, err := safeClient.Do(req)
	if err != nil {
		return nil, false, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		if response.StatusCode >= 300 && response.StatusCode < 500 && response.StatusCode != http.StatusTooManyRequests {
			return nil, false, fmt.Errorf("%w: HTTP %d", errIMSLPCatalogData, response.StatusCode)
		}
		return nil, false, fmt.Errorf("IMSLP worklist HTTP %d", response.StatusCode)
	}
	var payload map[string]json.RawMessage
	if err := json.NewDecoder(io.LimitReader(response.Body, 2<<20)).Decode(&payload); err != nil {
		return nil, false, err
	}
	var metadata struct {
		Start *int  `json:"start"`
		Limit *int  `json:"limit"`
		More  *bool `json:"moreresultsavailable"`
	}
	if err := json.Unmarshal(payload["metadata"], &metadata); err != nil || metadata.Start == nil ||
		metadata.Limit == nil || metadata.More == nil || *metadata.Start != start || *metadata.Limit != 1000 {
		return nil, false, fmt.Errorf("%w: metadata", errIMSLPCatalogData)
	}
	delete(payload, "metadata")
	works := make([]imslpRecord, 0, len(payload))
	for i := 0; i < len(payload); i++ {
		data, ok := payload[strconv.Itoa(i)]
		if !ok {
			return nil, false, fmt.Errorf("%w: missing record", errIMSLPCatalogData)
		}
		var work imslpRecord
		if err := json.Unmarshal(data, &work); err != nil {
			return nil, false, fmt.Errorf("%w: record JSON", errIMSLPCatalogData)
		}
		canonical, valid := canonicalIMSLPWorkURL(work.Permlink)
		if work.ID == "" || work.Type != "2" ||
			strings.TrimSpace(work.Intvals.Title) == "" || !valid {
			return nil, false, fmt.Errorf("%w: work record", errIMSLPCatalogData)
		}
		work.Permlink = canonical
		works = append(works, work)
	}
	if len(works) > 1000 || (*metadata.More && len(works) != 1000) {
		return nil, false, fmt.Errorf("%w: incomplete page", errIMSLPCatalogData)
	}
	return works, *metadata.More, nil
}

// RunIMSLPCatalog builds one complete durable snapshot at a time. A database advisory
// lock ensures only one API instance crawls, and the active generation changes only
// after the documented worklist reports its final page.
func (s *Service) RunIMSLPCatalog(ctx context.Context) {
	client := &http.Client{Timeout: 20 * time.Second}
	runIMSLPCatalog(ctx, func(ctx context.Context) error {
		return s.refreshIMSLPCatalog(ctx, client, imslpWorkListURL, 2*time.Second, 250001)
	}, waitIMSLPCatalog)
}

func waitIMSLPCatalog(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func imslpRetryDelay(err error, failures int) time.Duration {
	if err == nil {
		return 24 * time.Hour
	}
	if errors.Is(err, errIMSLPCatalogBusy) {
		return 2 * time.Minute
	}
	if errors.Is(err, errIMSLPCatalogData) {
		return 6 * time.Hour
	}
	delay := 5 * time.Minute
	for attempt := 1; attempt < failures && delay < time.Hour; attempt++ {
		delay *= 3
	}
	if delay > time.Hour {
		return time.Hour
	}
	return delay
}

func runIMSLPCatalog(ctx context.Context, refresh func(context.Context) error, wait func(context.Context, time.Duration) bool) {
	failures := 0
	for {
		err := refresh(ctx)
		if ctx.Err() != nil {
			return
		}
		if err != nil && !errors.Is(err, errIMSLPCatalogBusy) {
			slog.Warn("IMSLP catalogue refresh failed", "error", err)
		}
		if err == nil || errors.Is(err, errIMSLPCatalogBusy) {
			failures = 0
		} else {
			failures++
		}
		if !wait(ctx, imslpRetryDelay(err, failures)) {
			return
		}
	}
}

func (s *Service) refreshIMSLPCatalog(ctx context.Context, client *http.Client, format string, pause time.Duration, minimumWorks int) (refreshErr error) {
	conn, err := s.pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()
	var locked bool
	if err := conn.QueryRow(ctx, `SELECT pg_try_advisory_lock($1)`, imslpCatalogLock).Scan(&locked); err != nil {
		return err
	}
	if !locked {
		return errIMSLPCatalogBusy
	}
	defer func() {
		unlockCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if _, err := conn.Exec(unlockCtx, `SELECT pg_advisory_unlock($1)`, imslpCatalogLock); err != nil {
			// A pooled connection must never retain the refresh lock.
			_ = conn.Conn().Close(context.Background())
		}
	}()

	var refreshed *time.Time
	if err := conn.QueryRow(ctx, `SELECT refreshed_at FROM imslp_catalog_state WHERE id=TRUE`).Scan(&refreshed); err != nil {
		return err
	}
	if refreshed != nil && time.Since(*refreshed) < 7*24*time.Hour {
		return nil
	}

	generation := uuid.NewString()
	_, err = conn.Exec(ctx, `DELETE FROM imslp_catalog_works WHERE generation <> (SELECT active_generation FROM imslp_catalog_state WHERE id=TRUE) OR
		(SELECT active_generation FROM imslp_catalog_state WHERE id=TRUE) IS NULL`)
	if err != nil {
		return err
	}
	defer func() {
		// A failed refresh must never expose a partial catalogue as a no-results search.
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_, _ = conn.Exec(cleanupCtx, `DELETE FROM imslp_catalog_works WHERE generation=$1 AND
			generation IS DISTINCT FROM (SELECT active_generation FROM imslp_catalog_state WHERE id=TRUE)`, generation)
		if refreshErr != nil && ctx.Err() == nil {
			_, _ = conn.Exec(cleanupCtx, `UPDATE imslp_catalog_state SET last_error=$1 WHERE id=TRUE`, refreshErr.Error())
		}
	}()
	count := 0
	for page := 0; page < 400; page++ {
		works, more, err := fetchIMSLPPage(ctx, client, format, page*1000)
		if err != nil {
			return err
		}
		rows := make([][]any, 0, len(works))
		for _, work := range works {
			rows = append(rows, []any{generation, work.ID, work.Intvals.Title, work.Intvals.Composer, work.Permlink})
		}
		if len(rows) > 0 {
			if _, err := conn.CopyFrom(ctx, pgx.Identifier{"imslp_catalog_works"},
				[]string{"generation", "work_id", "title", "composer", "url"}, pgx.CopyFromRows(rows)); err != nil {
				return err
			}
		}
		count += len(rows)
		if !more {
			if count < minimumWorks {
				return fmt.Errorf("%w: only %d works", errIMSLPCatalogData, count)
			}
			var previousCount int
			if err := conn.QueryRow(ctx, `SELECT count(*) FROM imslp_catalog_works WHERE generation=(SELECT active_generation FROM imslp_catalog_state WHERE id=TRUE)`).Scan(&previousCount); err != nil {
				return err
			}
			if previousCount > 0 && count < previousCount*95/100 {
				return fmt.Errorf("%w: worklist shrank unexpectedly from %d to %d works", errIMSLPCatalogData, previousCount, count)
			}
			_, err = conn.Exec(ctx, `UPDATE imslp_catalog_state SET active_generation=$1, refreshed_at=now(), last_error=NULL WHERE id=TRUE`, generation)
			return err
		}
		if page == 399 {
			return fmt.Errorf("%w: exceeded bounded snapshot size", errIMSLPCatalogData)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(pause):
		}
	}
	return fmt.Errorf("%w: did not complete", errIMSLPCatalogData)
}

func (s *Service) SearchIMSLP(ctx context.Context, query string) (IMSLPSearch, error) {
	query = strings.TrimSpace(query)
	if len([]rune(query)) < 2 || len([]rune(query)) > 100 {
		return IMSLPSearch{}, errors.New("search must be 2 to 100 characters")
	}
	var generation *string
	var lastError *string
	if err := s.pool.QueryRow(ctx, `SELECT active_generation, last_error FROM imslp_catalog_state WHERE id=TRUE`).Scan(&generation, &lastError); err != nil {
		return IMSLPSearch{}, err
	}
	if generation == nil {
		if lastError != nil {
			return IMSLPSearch{Status: "unavailable", Results: []IMSLPWork{}}, nil
		}
		return IMSLPSearch{Status: "loading", Results: []IMSLPWork{}}, nil
	}
	pattern := "%" + strings.NewReplacer("\\", "\\\\", "%", "\\%", "_", "\\_").Replace(query) + "%"
	rows, err := s.pool.Query(ctx, `SELECT title, composer, url FROM imslp_catalog_works
		WHERE generation=$1 AND (title ILIKE $2 OR composer ILIKE $2)
		ORDER BY CASE WHEN lower(title)=lower($3) THEN 0 WHEN title ILIKE $2 THEN 1 ELSE 2 END,
			lower(title), lower(composer) LIMIT 30`, *generation, pattern, query)
	if err != nil {
		return IMSLPSearch{}, err
	}
	defer rows.Close()
	result := IMSLPSearch{Status: "ready", Results: []IMSLPWork{}}
	for rows.Next() {
		var work IMSLPWork
		if err := rows.Scan(&work.Title, &work.Composer, &work.URL); err != nil {
			return IMSLPSearch{}, err
		}
		result.Results = append(result.Results, work)
	}
	return result, rows.Err()
}
