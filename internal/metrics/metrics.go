// Package metrics exports Prometheus metrics on an internal listener that is
// separate from the public API, so public routers can never expose them.
package metrics

import (
	"errors"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Off as the listen address disables the metrics listener.
const Off = "off"

// Unmatched is the route label for requests that matched no route, so raw
// paths never become label values.
const Unmatched = "unmatched"

// Upload kinds: a draft source page, the final PDF that creates a piece, and a
// Send to Noted shortcut file.
const (
	UploadSource   = "source"
	UploadFinalize = "finalize"
	UploadShortcut = "shortcut"
)

// Outcomes for uploads and jobs. Uploads are rejected on a 4xx response and
// fail on a 5xx one.
const (
	ResultSuccess  = "success"
	ResultRejected = "rejected"
	ResultError    = "error"
)

// OAuth failures happen before Google names a user; login failures reject a
// user Google or a shortcut token did name.
const (
	OAuthProviderError = "provider_error"
	OAuthInvalidState  = "invalid_state"
	OAuthMissingCode   = "missing_code"
	OAuthExchange      = "exchange"
	OAuthInternal      = "internal"

	LoginNotAllowed       = "not_allowed"
	LoginIdentityConflict = "identity_conflict"
	LoginShortcutToken    = "shortcut_token"
)

const JobImportCleanup = "import_cleanup"

// Metrics owns a private registry. A nil *Metrics records nothing, so handlers
// built without one still work.
type Metrics struct {
	registry      *prometheus.Registry
	requests      *prometheus.CounterVec
	duration      *prometheus.HistogramVec
	uploads       *prometheus.CounterVec
	oauthFailures *prometheus.CounterVec
	loginFailures *prometheus.CounterVec
	jobs          *prometheus.CounterVec
}

func New() *Metrics {
	m := &Metrics{
		registry: prometheus.NewRegistry(),
		requests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "http_requests_total",
			Help: "HTTP requests by method, route pattern, and status code.",
		}, []string{"method", "route", "status"}),
		duration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "http_request_duration_seconds",
			Help:    "HTTP request latency by method, route pattern, and status code.",
			Buckets: prometheus.DefBuckets,
		}, []string{"method", "route", "status"}),
		uploads: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "noted_uploads_total",
			Help: "Score file uploads by kind and result.",
		}, []string{"kind", "result"}),
		oauthFailures: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "noted_oauth_failures_total",
			Help: "OAuth sign-in callbacks that failed before a user was identified.",
		}, []string{"provider", "reason"}),
		loginFailures: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "noted_login_failures_total",
			Help: "Sign-ins and shortcut token uses that Noted rejected.",
		}, []string{"reason"}),
		jobs: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "noted_jobs_total",
			Help: "Background job runs by job and result.",
		}, []string{"job", "result"}),
	}
	m.registry.MustRegister(
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
		m.requests, m.duration, m.uploads, m.oauthFailures, m.loginFailures, m.jobs,
	)
	// Start every domain series at zero so rate() and absence alerts work
	// before the first event.
	for _, kind := range []string{UploadSource, UploadFinalize, UploadShortcut} {
		for _, result := range []string{ResultSuccess, ResultRejected, ResultError} {
			m.uploads.WithLabelValues(kind, result)
		}
	}
	for _, reason := range []string{
		OAuthProviderError, OAuthInvalidState, OAuthMissingCode, OAuthExchange, OAuthInternal,
	} {
		m.oauthFailures.WithLabelValues("google", reason)
	}
	for _, reason := range []string{LoginNotAllowed, LoginIdentityConflict, LoginShortcutToken} {
		m.loginFailures.WithLabelValues(reason)
	}
	for _, result := range []string{ResultSuccess, ResultError} {
		m.jobs.WithLabelValues(JobImportCleanup, result)
	}
	return m
}

// Handler serves GET /metrics. Mount it only on the internal listener.
func (m *Metrics) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.Handle("GET /metrics", promhttp.HandlerFor(m.registry, promhttp.HandlerOpts{Registry: m.registry}))
	return mux
}

// Serve starts the internal metrics listener and returns its server for
// shutdown. It returns nil when addr is Off or cannot be bound: losing metrics
// must never stop the API.
func (m *Metrics) Serve(addr string) *http.Server {
	if addr == Off {
		slog.Info("metrics listener disabled")
		return nil
	}
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		slog.Error("metrics listener could not start", "address", addr, "error", err)
		return nil
	}
	server := &http.Server{
		Handler:           m.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	go func() {
		slog.Info("metrics listening", "address", listener.Addr().String())
		if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("metrics listener stopped", "error", err)
		}
	}()
	return server
}

// Middleware records RED metrics for a chi router. Labels use the matched
// route pattern, never the raw path. Requests to skip paths and /metrics are
// not recorded.
func (m *Metrics) Middleware(skip ...string) func(http.Handler) http.Handler {
	skipped := map[string]bool{"/metrics": true}
	for _, path := range skip {
		skipped[path] = true
	}
	return func(next http.Handler) http.Handler {
		if m == nil {
			return next
		}
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if skipped[r.URL.Path] {
				next.ServeHTTP(w, r)
				return
			}
			start := time.Now()
			wrapped := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
			next.ServeHTTP(wrapped, r)
			labels := []string{method(r.Method), routePattern(r), strconv.Itoa(status(wrapped))}
			m.requests.WithLabelValues(labels...).Inc()
			m.duration.WithLabelValues(labels...).Observe(time.Since(start).Seconds())
		})
	}
}

// CountUploads records one upload of kind per request, with its result taken
// from the response status.
func (m *Metrics) CountUploads(kind string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		if m == nil {
			return next
		}
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			wrapped := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
			next.ServeHTTP(wrapped, r)
			result := ResultSuccess
			switch code := status(wrapped); {
			case code >= 500:
				result = ResultError
			case code >= 400:
				result = ResultRejected
			}
			m.uploads.WithLabelValues(kind, result).Inc()
		})
	}
}

func (m *Metrics) OAuthFailure(provider, reason string) {
	if m != nil {
		m.oauthFailures.WithLabelValues(provider, reason).Inc()
	}
}

func (m *Metrics) LoginFailure(reason string) {
	if m != nil {
		m.loginFailures.WithLabelValues(reason).Inc()
	}
}

// JobRun records one run of job; a nil err is a success.
func (m *Metrics) JobRun(job string, err error) {
	if m == nil {
		return
	}
	result := ResultSuccess
	if err != nil {
		result = ResultError
	}
	m.jobs.WithLabelValues(job, result).Inc()
}

func status(w middleware.WrapResponseWriter) int {
	if code := w.Status(); code != 0 {
		return code
	}
	return http.StatusOK
}

// routePattern asks the router whether the request matched a route, because a
// miss inside a subrouter still leaves a partial "/prefix/*" pattern behind.
func routePattern(r *http.Request) string {
	rctx := chi.RouteContext(r.Context())
	if rctx == nil || rctx.Routes == nil {
		return Unmatched
	}
	path := r.URL.RawPath
	if path == "" {
		path = r.URL.Path
	}
	pattern := rctx.RoutePattern()
	if pattern == "" || !rctx.Routes.Match(chi.NewRouteContext(), r.Method, path) {
		return Unmatched
	}
	return pattern
}

// method bounds the method label to the standard methods.
func method(value string) string {
	switch value {
	case http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut, http.MethodPatch,
		http.MethodDelete, http.MethodOptions, http.MethodConnect, http.MethodTrace:
		return value
	default:
		return "OTHER"
	}
}
