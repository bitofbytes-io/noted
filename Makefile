SHELL := /bin/sh

.PHONY: setup db-up db-down migrate seed api-run web-start local test test-api test-web test-e2e lint build clean

setup:
	mkdir -p .local/noted-assets/temporary .local/noted-assets/originals/pdf .local/noted-assets/originals/musicxml
	test -f .env || cp .env.example .env
	go mod download
	cd web && npm ci

db-up:
	docker compose -f compose.local.yml up -d postgres

db-down:
	docker compose -f compose.local.yml down

migrate:
	go run ./cmd/migrate

seed:
	go run ./cmd/seed

api-run:
	go run ./cmd/api

web-start:
	cd web && npm start

local: db-up
	@echo "PostgreSQL is running. In separate terminals run: make migrate seed api-run web-start"

test: db-up migrate seed test-api test-web

test-api:
	NOTED_INTEGRATION=1 go test ./...

test-web:
	cd web && npm test -- --watch=false

test-e2e:
	cd web && npm run e2e

lint:
	test -z "$$(gofmt -l cmd internal)"
	go vet ./...
	cd web && npm run lint

build:
	go build ./...
	cd web && npm run build

clean:
	rm -rf bin web/dist web/.angular web/test-results web/playwright-report
