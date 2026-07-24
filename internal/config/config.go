package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

type Config struct {
	Port           string
	DatabaseURL    string
	AssetRoot      string
	MaxUploadBytes int64
	AllowedOrigin  string
}

func Load() (Config, error) {
	databaseURL, err := getEnvOrFile("DATABASE_URL")
	if err != nil {
		return Config{}, err
	}
	if databaseURL == "" {
		databaseURL = "postgres://noted:noted@localhost:5434/noted?sslmode=disable"
	}
	allowedOrigin := value("ALLOWED_ORIGIN", "")
	if allowedOrigin == "" {
		allowedOrigin = value("ALLOWED_ORIGINS", "http://localhost:4200")
	}
	cfg := Config{
		Port:           value("PORT", "8080"),
		DatabaseURL:    databaseURL,
		AssetRoot:      value("ASSET_ROOT", ".local/noted-assets"),
		MaxUploadBytes: 50 << 20,
		AllowedOrigin:  allowedOrigin,
	}
	if raw := os.Getenv("MAX_UPLOAD_BYTES"); raw != "" {
		size, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || size < 1024 {
			return Config{}, fmt.Errorf("MAX_UPLOAD_BYTES must be an integer of at least 1024")
		}
		cfg.MaxUploadBytes = size
	}
	if cfg.DatabaseURL == "" {
		return Config{}, fmt.Errorf("DATABASE_URL is required")
	}
	return cfg, nil
}

func getEnvOrFile(name string) (string, error) {
	if value := os.Getenv(name); value != "" {
		return strings.TrimSpace(value), nil
	}
	path := os.Getenv(name + "_FILE")
	if path == "" {
		return "", nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("config: reading %s_FILE (%s): %w", name, path, err)
	}
	value := strings.TrimSpace(string(data))
	if value == "" {
		return "", fmt.Errorf("config: %s_FILE (%s) is empty", name, path)
	}
	return value, nil
}

func value(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
