package app

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// IMSLP names downloads "IMSLP<file number>-<rest>.pdf", e.g.
// "IMSLP01240-Debussy_-_Suite_bergamasque_-_3_Clair_de_lune.pdf".
var imslpFileNumber = regexp.MustCompile(`^IMSLP0*(\d{1,8})-`)

// imslpFileNumberOf returns the IMSLP file number in a download's filename.
func imslpFileNumberOf(filename string) (string, bool) {
	match := imslpFileNumber.FindStringSubmatch(filename)
	if match == nil {
		return "", false
	}
	return match[1], true
}

// resolveFile maps an IMSLP file number to its work through
// Special:ReverseLookup. It shares the search's outbound limiter and breaker and
// never fails the caller: any answer but a redirect to a work page means no work.
func (s *imslpSearcher) resolveFile(number string) (IMSLPWork, bool) {
	if work, ok := s.cachedFile(number); ok {
		return work, true
	}
	probe, ok := s.admit()
	if !ok {
		return IMSLPWork{}, false
	}
	release, ok := s.acquireOutbound()
	if !ok {
		s.abandonProbe(probe)
		return IMSLPWork{}, false
	}
	defer release()
	work, found, retryAfter, err := s.reverseLookup(number)
	s.record(probe, err, retryAfter)
	if found {
		s.storeFile(number, work)
	}
	return work, found
}

// reverseLookup reads only the redirect target; the work page is never fetched.
// Errors carry no URL, so the breaker log line never includes a file number.
func (s *imslpSearcher) reverseLookup(number string) (IMSLPWork, bool, time.Duration, error) {
	request, err := http.NewRequest(http.MethodGet, s.cfg.WikiURL+"Special:ReverseLookup/"+number, nil)
	if err != nil {
		return IMSLPWork{}, false, 0, errors.New("invalid IMSLP lookup request")
	}
	request.Header.Set("User-Agent", imslpAgent)
	response, err := s.client.Do(request)
	if err != nil {
		var urlError *url.Error
		if errors.As(err, &urlError) {
			err = urlError.Err
		}
		return IMSLPWork{}, false, 0, err
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64<<10))
	switch status := response.StatusCode; {
	case status == http.StatusTooManyRequests:
		return IMSLPWork{}, false, s.retryAfter(response.Header.Get("Retry-After")), errors.New("IMSLP lookup HTTP 429")
	case status >= 500:
		return IMSLPWork{}, false, 0, fmt.Errorf("IMSLP lookup HTTP %d", status)
	case status >= 300 && status < 400:
		work, ok := imslpWorkFromLocation(response.Header.Get("Location"))
		if !ok {
			// Like a redirect from api.php, a redirect off the wiki is IMSLP's browser check.
			return IMSLPWork{}, false, 0, errors.New("IMSLP lookup redirected away from a work page")
		}
		return work, true, 0, nil
	default:
		// IMSLP answered, but the number names no file (404) or no redirect (200).
		return IMSLPWork{}, false, 0, nil
	}
}

// imslpWorkFromLocation reads ReverseLookup's redirect target, normally
// "//imslp.org/wiki/<Work_(Last,_First)>#IMSLP<number>", as a canonical work.
func imslpWorkFromLocation(location string) (IMSLPWork, bool) {
	raw, _, _ := strings.Cut(strings.TrimSpace(location), "#")
	switch {
	case strings.HasPrefix(raw, "//"):
		raw = "https:" + raw
	case strings.HasPrefix(raw, "/wiki/"):
		raw = "https://imslp.org" + raw
	case strings.HasPrefix(raw, "http://"):
		raw = "https://" + strings.TrimPrefix(raw, "http://")
	}
	workURL, ok := canonicalIMSLPWorkURL(raw)
	if !ok {
		return IMSLPWork{}, false
	}
	parsed, err := url.Parse(workURL)
	if err != nil {
		return IMSLPWork{}, false
	}
	title, composer, ok := imslpWorkName(strings.ReplaceAll(strings.TrimPrefix(parsed.Path, "/wiki/"), "_", " "))
	if !ok {
		return IMSLPWork{}, false
	}
	return IMSLPWork{Title: title, Composer: composer, URL: workURL}, true
}

// File lookups are cached only when they found a work: a file number always
// names the same work, while a miss may be IMSLP having a bad moment.
func (s *imslpSearcher) cachedFile(number string) (IMSLPWork, bool) {
	now := s.cfg.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	element := s.fileEntries[number]
	if element == nil {
		return IMSLPWork{}, false
	}
	entry := element.Value.(*imslpFileEntry)
	if !now.Before(entry.expires) {
		s.files.Remove(element)
		delete(s.fileEntries, number)
		return IMSLPWork{}, false
	}
	s.files.MoveToFront(element)
	return entry.work, true
}

func (s *imslpSearcher) storeFile(number string, work IMSLPWork) {
	entry := &imslpFileEntry{number: number, work: work, expires: s.cfg.Now().Add(s.cfg.FileCacheTTL)}
	s.mu.Lock()
	defer s.mu.Unlock()
	if element := s.fileEntries[number]; element != nil {
		element.Value = entry
		s.files.MoveToFront(element)
		return
	}
	s.fileEntries[number] = s.files.PushFront(entry)
	for s.files.Len() > s.cfg.FileCacheSize {
		oldest := s.files.Back()
		s.files.Remove(oldest)
		delete(s.fileEntries, oldest.Value.(*imslpFileEntry).number)
	}
}
