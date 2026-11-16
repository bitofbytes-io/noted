package app

import (
	"container/list"
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"golang.org/x/sync/singleflight"
)

const (
	imslpAPIURL  = "https://imslp.org/api.php"
	imslpWikiURL = "https://imslp.org/wiki/" // #nosec G101 -- Public IMSLP endpoint, not a credential.
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

	users *userLimiter

	mu        sync.Mutex
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
		users:   newUserLimiter(cfg.UserRate, cfg.UserBurst, cfg.UserIdle, cfg.Now),
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
		return IMSLPSearch{}, invalid("search must be 2 to 100 characters")
	}
	return s.imslp.search(ctx, userID, query)
}
