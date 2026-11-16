package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

func normaliseIMSLPQuery(query string) string {
	return strings.ToLower(strings.Join(strings.Fields(query), " "))
}

func (s *imslpSearcher) search(ctx context.Context, userID, query string) (IMSLPSearch, error) {
	if !s.users.allow(userID) {
		return IMSLPSearch{}, ErrIMSLPThrottled
	}
	key := normaliseIMSLPQuery(query)
	if works, ok := s.cached(key); ok {
		return IMSLPSearch{Status: IMSLPStatusReady, Results: works}, nil
	}
	// The upstream call is detached from this request: a client that moves on to
	// a newer query must not cancel a lookup that others share or that fills the cache.
	result := s.flight.DoChan(key, func() (any, error) {
		return s.lookup(key), nil
	})
	select {
	case done := <-result:
		return done.Val.(IMSLPSearch), nil
	case <-ctx.Done():
		return IMSLPSearch{}, ctx.Err()
	}
}

// lookup searches work titles first. Title search misses nicknames that live only
// in the page text ("Moonlight"), so an empty title result costs one more
// request in text mode. Both requests pass the outbound limiter and breaker.
func (s *imslpSearcher) lookup(query string) IMSLPSearch {
	unavailable := IMSLPSearch{Status: IMSLPStatusUnavailable, Results: []IMSLPWork{}}
	if works, ok := s.cached(query); ok {
		return IMSLPSearch{Status: IMSLPStatusReady, Results: works}
	}
	works := []IMSLPWork{}
	if terms := imslpSearchTerms(query); terms != "" {
		var ok bool
		works, ok = s.attempt(terms, "title")
		if ok && len(works) == 0 {
			works, ok = s.attempt(terms, "text")
		}
		if !ok {
			return unavailable
		}
	}
	s.store(query, works)
	return IMSLPSearch{Status: IMSLPStatusReady, Results: works}
}

func (s *imslpSearcher) attempt(terms, what string) ([]IMSLPWork, bool) {
	probe, ok := s.admit()
	if !ok {
		return nil, false
	}
	release, ok := s.acquireOutbound()
	if !ok {
		s.abandonProbe(probe)
		return nil, false
	}
	defer release()
	works, retryAfter, err := s.fetch(terms, what)
	s.record(probe, err, retryAfter)
	return works, err == nil
}

// MediaWiki 1.18 hands srsearch to MySQL boolean full-text search, where these
// characters are operators.
var imslpSearchOperators = strings.NewReplacer(`"`, "", "*", "", "+", "", "~", "", "<", "", ">", "", "(", "", ")", "")

// imslpSearchTerms turns a typed query into prefix matches so a half-typed word
// still finds works ("satie gymnop" finds 3 Gymnopédies). IMSLP's index ignores
// a wildcard on prefixes shorter than four characters ("deb*" matches nothing),
// so those stay whole words.
func imslpSearchTerms(query string) string {
	terms := []string{}
	for _, token := range strings.Fields(query) {
		token = strings.TrimLeft(imslpSearchOperators.Replace(token), "-")
		if token == "" {
			continue
		}
		if utf8.RuneCountInString(token) >= 4 {
			token += "*"
		}
		terms = append(terms, token)
	}
	return strings.Join(terms, " ")
}

// fetch reads only IMSLP's MediaWiki search API, never edition or file pages.
// Errors carry no URL, so the breaker log line never includes a user's query.
func (s *imslpSearcher) fetch(terms, what string) ([]IMSLPWork, time.Duration, error) {
	// list=search returns IMSLP's ranking; generator=search returns the same
	// hits as pages with redirects collapsed and their canonical fullurl.
	params := url.Values{
		"action":        {"query"},
		"format":        {"json"},
		"formatversion": {"2"},
		"list":          {"search"},
		"srsearch":      {terms},
		"srnamespace":   {"0"},
		"srlimit":       {"10"},
		"srwhat":        {what},
		"srprop":        {""},
		"generator":     {"search"},
		"gsrsearch":     {terms},
		"gsrnamespace":  {"0"},
		"gsrlimit":      {"10"},
		"gsrwhat":       {what},
		"redirects":     {"1"},
		"prop":          {"info"},
		"inprop":        {"url"},
	}
	request, err := http.NewRequest(http.MethodGet, s.cfg.BaseURL+"?"+params.Encode(), nil)
	if err != nil {
		return nil, 0, errors.New("invalid IMSLP search request")
	}
	request.Header.Set("User-Agent", imslpAgent)
	request.Header.Set("Accept", "application/json")
	response, err := s.client.Do(request)
	if err != nil {
		var urlError *url.Error
		if errors.As(err, &urlError) {
			err = urlError.Err
		}
		return nil, 0, err
	}
	defer response.Body.Close() //nolint:errcheck // Read-only stream; the read/response result is handled separately.
	if response.StatusCode == http.StatusTooManyRequests {
		return nil, s.retryAfter(response.Header.Get("Retry-After")), errors.New("IMSLP search HTTP 429")
	}
	if response.StatusCode != http.StatusOK {
		return nil, 0, fmt.Errorf("IMSLP search HTTP %d", response.StatusCode)
	}
	works, err := parseIMSLPSearch(io.LimitReader(response.Body, 1<<20))
	return works, 0, err
}

func (s *imslpSearcher) retryAfter(header string) time.Duration {
	delay := s.cfg.MaxRetryAfter
	if seconds, err := strconv.Atoi(strings.TrimSpace(header)); err == nil && seconds > 0 {
		delay = time.Duration(seconds) * time.Second
	} else if at, err := http.ParseTime(header); err == nil && at.After(s.cfg.Now()) {
		delay = at.Sub(s.cfg.Now())
	}
	return min(delay, s.cfg.MaxRetryAfter)
}
