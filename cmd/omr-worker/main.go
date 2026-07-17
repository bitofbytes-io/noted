package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/bitofbytes-io/noted/internal/omrworker"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	token, err := readSecret("OMR_TOKEN", "OMR_TOKEN_FILE", "/run/secrets/noted_omr_token")
	if err != nil {
		logger.Error("load worker token", "error", err)
		os.Exit(1)
	}
	recognizer := omrworker.NewCommandRecognizer()
	handler, err := omrworker.NewHandler(omrworker.Config{
		Token:      token,
		TempRoot:   envOrDefault("OMR_TEMP_ROOT", "/tmp/noted-omr"),
		Recognizer: recognizer,
		Logger:     logger,
	})
	if err != nil {
		logger.Error("configure worker", "error", err)
		os.Exit(1)
	}
	address := envOrDefault("OMR_LISTEN_ADDR", ":8788")
	server := &http.Server{
		Addr:              address,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       omrworker.DefaultUploadTimeout + 30*time.Second,
		WriteTimeout:      omrworker.DefaultUploadTimeout + omrworker.DefaultTimeout + 2*time.Minute,
		IdleTimeout:       60 * time.Second,
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	serverErrors := make(chan error, 1)
	go func() {
		serverErrors <- server.ListenAndServe()
	}()
	logger.Info("starting OMR worker", "address", address, "engine", omrworker.EngineName, "version", omrworker.EngineVersion)
	select {
	case err := <-serverErrors:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("worker stopped", "error", err)
			os.Exit(1)
		}
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			logger.Error("shutdown worker", "error", err)
			_ = server.Close()
		}
		if err := <-serverErrors; err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("worker stopped during shutdown", "error", err)
		}
	}
}

func readSecret(environmentName, fileEnvironmentName, defaultPath string) (string, error) {
	if path := strings.TrimSpace(os.Getenv(fileEnvironmentName)); path != "" {
		return readSecretFile(path)
	}
	if value := strings.TrimSpace(os.Getenv(environmentName)); value != "" {
		return value, nil
	}
	return readSecretFile(defaultPath)
}

func readSecretFile(path string) (string, error) {
	contents, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	value := strings.TrimSpace(string(contents))
	if value == "" {
		return "", fmt.Errorf("secret file %s is empty", path)
	}
	return value, nil
}

func envOrDefault(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}
