package main

import (
	"context"
	"errors"
	"log"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/bitofbytes-io/noted/internal/app"
	"github.com/bitofbytes-io/noted/internal/assets"
	"github.com/bitofbytes-io/noted/internal/auth"
	"github.com/bitofbytes-io/noted/internal/config"
	"github.com/bitofbytes-io/noted/internal/httpapi"
	"github.com/bitofbytes-io/noted/internal/metrics"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/joho/godotenv"
)

func main() {
	if err := godotenv.Load(); err != nil && !errors.Is(err, os.ErrNotExist) {
		log.Print("optional .env file could not be loaded")
	}
	cfg, err := config.Load()
	if err != nil {
		log.Fatal(err)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatal(err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		log.Fatal(err)
	}
	store, err := assets.NewLocalStore(cfg.AssetRoot)
	if err != nil {
		log.Fatal(err)
	}
	appMetrics := metrics.New()
	if err := appMetrics.RegisterPool(pool); err != nil {
		log.Fatal(err)
	}
	service := app.NewService(pool, store, cfg.MaxUploadBytes)
	// Search still works on stale text, only less well, so a failure is not fatal.
	if refolded, err := service.RefoldSearchText(ctx); err != nil {
		slog.Error("Refolding library search text failed", "error", err)
	} else if refolded > 0 {
		slog.Info("Refolded library search text", "pieces", refolded)
	}
	go service.RunImportCleanup(ctx, func(err error) {
		appMetrics.JobRun(metrics.JobImportCleanup, err)
	})
	server := &http.Server{
		Addr: net.JoinHostPort(cfg.ListenHost, cfg.Port),
		Handler: httpapi.NewRouter(
			service,
			auth.NewService(pool, cfg.AllowedEmails, cfg.SessionTTL),
			cfg,
			appMetrics,
		),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	go func() {
		slog.Info("Noted API listening", "address", server.Addr)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	}()
	// Metrics stay off the public server; a failure to bind is logged, not fatal.
	metricsServer := appMetrics.Serve(cfg.MetricsAddr)
	<-ctx.Done()
	shutdown, stop := context.WithTimeout(context.Background(), 10*time.Second)
	defer stop()
	if err := server.Shutdown(shutdown); err != nil {
		slog.Error("API shutdown failed", "error", err)
	}
	if metricsServer != nil {
		if err := metricsServer.Shutdown(shutdown); err != nil {
			slog.Error("metrics shutdown failed", "error", err)
		}
	}
}
