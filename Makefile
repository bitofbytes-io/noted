SHELL := /bin/sh
COMPOSE := docker compose -p noted -f compose.local.yml

.PHONY: setup db-up db-down migrate seed api-run web-start local test test-api test-web test-migrations test-e2e lint build clean

setup:
	mkdir -p .local/noted-assets/temporary .local/noted-assets/originals/pdf .local/noted-assets/originals/musicxml
	test -f .env || cp .env.example .env
	go mod download
	cd web && npm ci

db-up:
	$(COMPOSE) up -d --wait postgres

db-down:
	$(COMPOSE) down

migrate:
	go run ./cmd/migrate

seed:
	go run ./cmd/seed

api-run:
	go run ./cmd/api

web-start:
	cd web && npm start

local: db-up migrate seed
	@set -eu; \
		go run ./cmd/api & api_pid=$$!; \
		trap 'kill "$$api_pid" 2>/dev/null || true' EXIT INT TERM; \
		cd web && npm start

test: db-up migrate seed test-api test-web test-migrations

test-api:
	NOTED_INTEGRATION=1 go test ./...

test-web:
	cd web && npm test -- --watch=false

test-migrations:
	./scripts/with-test-database.sh migrations ./scripts/verify-migrations.sh

test-e2e:
	./scripts/with-test-database.sh e2e ./scripts/run-playwright.sh

lint:
	test -z "$$(gofmt -l cmd internal)"
	go vet ./...
	cd web && npm run lint

build:
	go build ./...
	cd web && npm run build

clean:
	rm -rf bin web/dist web/.angular web/test-results web/playwright-report
