package app

import (
	"container/list"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"golang.org/x/sync/singleflight"
)

const (
	imslpAPIURL  = "https://imslp.org/api.php"
	imslpWikiURL = "https://imslp.org/wiki/"
	imslpAgent   = "Noted/1.0 (private score binder; live work search)"
)

const (
	IMSLPStatusReady       = "ready"
	IMSLPStatusUnavailable = "unavailable"
	IMSLPStatusThrottled   = "throttled"
)

// ErrIMSLPThrottled means one user is searching faster than the per-user limit.
var ErrIMSLPThrottled = errors.New("IMSLP search requests are arriving too quickly")

type IMSLPWork struct {
	Title    string `json:"title"`
	Composer string `json:"composer"`
	URL      string `json:"url"`
}

type IMSLPSearch struct {
	Status  string      `json:"status"`
	Results []IMSLPWork `json:"results"`
}

// IMSLPSearchConfig holds the controls that keep live work search polite to
// IMSLP. Zero fields take the defaults from docs/product/imslp-live-search-plan.md.
type IMSLPSearchConfig struct {
	BaseURL string
	// WikiURL is the prefix for Special:ReverseLookup, used by Send to Noted.
	WikiURL string
	Client  *http.Client
	Now     func() time.Time
	Sleep   func(context.Context, time.Duration) error

	UserRate  float64
	UserBurst int
	UserIdle  time.Duration

	OutboundRate        float64
	OutboundBurst       int
	OutboundConcurrency int
	OutboundMaxWait     time.Duration

	CacheSize   int
	CacheTTL    time.Duration
	NegativeTTL time.Duration

	BreakerFailures int
	BreakerCooldown time.Duration
	MaxRetryAfter   time.Duration

	FileCacheSize int
	FileCacheTTL  time.Duration
}

func (cfg IMSLPSearchConfig) withDefaults() IMSLPSearchConfig {
	if cfg.BaseURL == "" {
		cfg.BaseURL = imslpAPIURL
	}
	if cfg.WikiURL == "" {
		cfg.WikiURL = imslpWikiURL
	}
	if cfg.Client == nil {
		cfg.Client = &http.Client{Timeout: 5 * time.Second}
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Sleep == nil {
		cfg.Sleep = sleepContext
	}
	setDefault(&cfg.UserRate, 2)
	setDefault(&cfg.UserBurst, 4)
	setDefault(&cfg.UserIdle, 10*time.Minute)
	setDefault(&cfg.OutboundRate, 5)
	setDefault(&cfg.OutboundBurst, 5)
	setDefault(&cfg.OutboundConcurrency, 4)
	setDefault(&cfg.OutboundMaxWait, 2*time.Second)
	setDefault(&cfg.CacheSize, 500)
	setDefault(&cfg.CacheTTL, 20*time.Minute)
	setDefault(&cfg.NegativeTTL, 5*time.Minute)
	setDefault(&cfg.BreakerFailures, 3)
	setDefault(&cfg.BreakerCooldown, 60*time.Second)
	setDefault(&cfg.MaxRetryAfter, 60*time.Second)
	setDefault(&cfg.FileCacheSize, 500)
	setDefault(&cfg.FileCacheTTL, 24*time.Hour)
	return cfg
}

func setDefault[T int | float64 | time.Duration](value *T, fallback T) {
	if *value <= 0 {
		*value = fallback
	}
}

func sleepContext(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// imslpSearcher proxies work search to IMSLP's MediaWiki API. All state is
// in-process: a single API replica is the deployment model.
type imslpSearcher struct {
	cfg    IMSLPSearchConfig
	client *http.Client
	flight singleflight.Group
	slots  chan struct{}

	mu        sync.Mutex
	users     map[string]*imslpUserBucket
	nextSweep time.Time
	outbound  tokenBucket
	cache     *list.List
	entries   map[string]*list.Element
	failures  int
	open      bool
	openUntil time.Time
	probing   bool

	// files caches IMSLP file number → work for Send to Noted, apart from searches.
	files       *list.List
	fileEntries map[string]*list.Element
}

type imslpUserBucket struct {
	bucket tokenBucket
	seen   time.Time
}

type imslpCacheEntry struct {
	key     string
	works   []IMSLPWork
	expires time.Time
}

type imslpFileEntry struct {
	number  string
	work    IMSLPWork
	expires time.Time
}

func newIMSLPSearcher(cfg IMSLPSearchConfig) *imslpSearcher {
	cfg = cfg.withDefaults()
	client := *cfg.Client
	// A redirect from api.php means IMSLP's browser check, never search results.
	// ReverseLookup answers with a redirect that is read, never followed.
	client.CheckRedirect = func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}
	return &imslpSearcher{
		cfg:     cfg,
		client:  &client,
		slots:   make(chan struct{}, cfg.OutboundConcurrency),
		users:   map[string]*imslpUserBucket{},
		cache:   list.New(),
		entries: map[string]*list.Element{},

		files:       list.New(),
		fileEntries: map[string]*list.Element{},
	}
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

func (s *Service) SearchIMSLP(ctx context.Context, userID, query string) (IMSLPSearch, error) {
	query = strings.TrimSpace(query)
	if count := utf8.RuneCountInString(query); count < 2 || count > 100 {
		return IMSLPSearch{}, errors.New("search must be 2 to 100 characters")
	}
	return s.imslp.search(ctx, userID, query)
}

func normaliseIMSLPQuery(query string) string {
	return strings.ToLower(strings.Join(strings.Fields(query), " "))
}

func (s *imslpSearcher) search(ctx context.Context, userID, query string) (IMSLPSearch, error) {
	if !s.allowUser(userID) {
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

func (s *imslpSearcher) allowUser(userID string) bool {
	now := s.cfg.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	if !now.Before(s.nextSweep) {
		for id, user := range s.users {
			if now.Sub(user.seen) >= s.cfg.UserIdle {
				delete(s.users, id)
			}
		}
		s.nextSweep = now.Add(s.cfg.UserIdle)
	}
	user := s.users[userID]
	if user == nil {
		user = &imslpUserBucket{}
		s.users[userID] = user
	}
	user.seen = now
	return user.bucket.allow(now, s.cfg.UserRate, s.cfg.UserBurst)
}

// admit applies the circuit breaker. After the cooldown exactly one probe is
// let through; its outcome closes the breaker or keeps it open.
func (s *imslpSearcher) admit() (probe, ok bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.open {
		return false, true
	}
	if s.cfg.Now().Before(s.openUntil) || s.probing {
		return false, false
	}
	s.probing = true
	return true, true
}

func (s *imslpSearcher) abandonProbe(probe bool) {
	if !probe {
		return
	}
	s.mu.Lock()
	s.probing = false
	s.mu.Unlock()
}

func (s *imslpSearcher) record(probe bool, err error, retryAfter time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if probe {
		s.probing = false
	}
	if err == nil {
		// Only the half-open probe may close an open breaker: a request admitted
		// before it opened says nothing about the cooldown or Retry-After.
		if s.open && !probe {
			return
		}
		s.failures = 0
		if s.open {
			s.open = false
			slog.Info("IMSLP search resumed")
		}
		return
	}
	s.failures++
	if !s.open && s.failures < s.cfg.BreakerFailures && retryAfter == 0 {
		return
	}
	cooldown := s.cfg.BreakerCooldown
	if retryAfter > 0 {
		cooldown = retryAfter
	}
	if !s.open {
		slog.Warn("IMSLP search paused after upstream failures", "error", err, "pause", cooldown)
	}
	s.open = true
	if until := s.cfg.Now().Add(cooldown); until.After(s.openUntil) {
		s.openUntil = until
	}
}

// acquireOutbound shares IMSLP's request budget across all users. A request
// that would wait longer than OutboundMaxWait is refused without calling IMSLP.
func (s *imslpSearcher) acquireOutbound() (func(), bool) {
	s.mu.Lock()
	wait, ok := s.outbound.reserve(s.cfg.Now(), s.cfg.OutboundRate, s.cfg.OutboundBurst, s.cfg.OutboundMaxWait)
	s.mu.Unlock()
	if !ok {
		return nil, false
	}
	ctx, cancel := context.WithTimeout(context.Background(), s.cfg.OutboundMaxWait)
	defer cancel()
	// A request that never goes out hands its token back.
	refund := func() (func(), bool) {
		s.mu.Lock()
		s.outbound.refund(s.cfg.OutboundBurst)
		s.mu.Unlock()
		return nil, false
	}
	if wait > 0 {
		if err := s.cfg.Sleep(ctx, wait); err != nil {
			return refund()
		}
	}
	select {
	case s.slots <- struct{}{}:
		return func() { <-s.slots }, true
	case <-ctx.Done():
		return refund()
	}
}

func (s *imslpSearcher) cached(key string) ([]IMSLPWork, bool) {
	now := s.cfg.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	element := s.entries[key]
	if element == nil {
		return nil, false
	}
	entry := element.Value.(*imslpCacheEntry)
	if !now.Before(entry.expires) {
		s.cache.Remove(element)
		delete(s.entries, key)
		return nil, false
	}
	s.cache.MoveToFront(element)
	return entry.works, true
}

func (s *imslpSearcher) store(key string, works []IMSLPWork) {
	ttl := s.cfg.CacheTTL
	if len(works) == 0 {
		ttl = s.cfg.NegativeTTL
	}
	entry := &imslpCacheEntry{key: key, works: works, expires: s.cfg.Now().Add(ttl)}
	s.mu.Lock()
	defer s.mu.Unlock()
	if element := s.entries[key]; element != nil {
		element.Value = entry
		s.cache.MoveToFront(element)
		return
	}
	s.entries[key] = s.cache.PushFront(entry)
	for s.cache.Len() > s.cfg.CacheSize {
		oldest := s.cache.Back()
		s.cache.Remove(oldest)
		delete(s.entries, oldest.Value.(*imslpCacheEntry).key)
	}
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
	defer response.Body.Close()
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

// IMSLP work pages are titled "Work title (Last, First)", the same rule the
// Prepare screen uses for a pasted work link.
var imslpWorkTitle = regexp.MustCompile(`^(.*?)\s*\(([^()]+, [^()]+)\)$`)

// imslpWorkName splits a work page title into the work and its composer
// ("Last, First"). Pages not titled that way are not works.
func imslpWorkName(title string) (work, composer string, ok bool) {
	match := imslpWorkTitle.FindStringSubmatch(title)
	if match == nil || strings.TrimSpace(match[1]) == "" {
		return "", "", false
	}
	return strings.TrimSpace(match[1]), strings.TrimSpace(match[2]), true
}

type imslpPage struct {
	NS      int             `json:"ns"`
	Title   string          `json:"title"`
	Index   int             `json:"index"`
	FullURL string          `json:"fullurl"`
	Missing json.RawMessage `json:"missing"`
}

// parseIMSLPSearch reads one combined list=search + generator=search reply.
// IMSLP runs MediaWiki 1.18, which ignores formatversion=2: pages arrive as an
// object keyed by page id and sorted by title, with no index field. The
// list=search rows carry IMSLP's rank, and redirects map a ranked redirect
// title onto the page that generator=search collapsed it into.
func parseIMSLPSearch(body io.Reader) ([]IMSLPWork, error) {
	var payload struct {
		Error json.RawMessage `json:"error"`
		Query *struct {
			Search []struct {
				Title string `json:"title"`
			} `json:"search"`
			Redirects []struct {
				From string `json:"from"`
				To   string `json:"to"`
			} `json:"redirects"`
			Pages json.RawMessage `json:"pages"`
		} `json:"query"`
	}
	if err := json.NewDecoder(body).Decode(&payload); err != nil {
		return nil, errors.New("invalid IMSLP search JSON")
	}
	if len(payload.Error) > 0 {
		return nil, errors.New("IMSLP search API error")
	}
	works := []IMSLPWork{}
	if payload.Query == nil || len(payload.Query.Pages) == 0 {
		return works, nil
	}
	var pages []imslpPage
	if err := json.Unmarshal(payload.Query.Pages, &pages); err != nil {
		var byID map[string]imslpPage
		if err := json.Unmarshal(payload.Query.Pages, &byID); err != nil {
			return nil, errors.New("invalid IMSLP search pages")
		}
		for _, page := range byID {
			pages = append(pages, page)
		}
	}
	redirects := map[string]string{}
	for _, redirect := range payload.Query.Redirects {
		redirects[redirect.From] = redirect.To
	}
	rank := map[string]int{}
	for position, hit := range payload.Query.Search {
		title := hit.Title
		if target, ok := redirects[title]; ok {
			title = target
		}
		if _, seen := rank[title]; !seen {
			rank[title] = position + 1
		}
	}
	order := func(page imslpPage) int {
		if page.Index > 0 {
			return page.Index
		}
		if position, ok := rank[page.Title]; ok {
			return position
		}
		return math.MaxInt
	}
	sort.SliceStable(pages, func(i, j int) bool {
		if order(pages[i]) != order(pages[j]) {
			return order(pages[i]) < order(pages[j])
		}
		return pages[i].Title < pages[j].Title
	})
	seen := map[string]bool{}
	for _, page := range pages {
		title, composer, isWork := imslpWorkName(page.Title)
		if page.NS != 0 || len(page.Missing) > 0 || !isWork {
			continue
		}
		raw := page.FullURL
		if strings.HasPrefix(raw, "//") {
			raw = "https:" + raw
		}
		workURL, valid := canonicalIMSLPWorkURL(raw)
		if !valid || seen[workURL] {
			continue
		}
		seen[workURL] = true
		works = append(works, IMSLPWork{Title: title, Composer: composer, URL: workURL})
	}
	return works, nil
}

// tokenBucket is a plain token bucket; a new bucket starts full.
type tokenBucket struct {
	tokens float64
	last   time.Time
}

func (b *tokenBucket) refill(now time.Time, rate float64, burst int) {
	if b.last.IsZero() {
		b.tokens, b.last = float64(burst), now
		return
	}
	if elapsed := now.Sub(b.last); elapsed > 0 {
		b.tokens = math.Min(float64(burst), b.tokens+elapsed.Seconds()*rate)
		b.last = now
	}
}

func (b *tokenBucket) allow(now time.Time, rate float64, burst int) bool {
	b.refill(now, rate, burst)
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// reserve takes a token now or in the future and returns how long to wait for
// it. When that wait would exceed maxWait nothing is taken.
func (b *tokenBucket) reserve(now time.Time, rate float64, burst int, maxWait time.Duration) (time.Duration, bool) {
	b.refill(now, rate, burst)
	var wait time.Duration
	if b.tokens < 1 {
		wait = time.Duration((1 - b.tokens) / rate * float64(time.Second))
	}
	if wait > maxWait {
		return 0, false
	}
	b.tokens--
	return wait, true
}

// refund returns a token taken by reserve for a request that was never made.
func (b *tokenBucket) refund(burst int) {
	b.tokens = math.Min(float64(burst), b.tokens+1)
}
