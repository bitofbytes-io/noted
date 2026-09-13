SHELL := /bin/sh
COMPOSE := docker compose -p noted -f compose.local.yml

REGISTRY ?= registry.tail209cfc.ts.net
API_IMAGE_REPO ?= noted-api
UI_IMAGE_REPO ?= noted-ui
PLATFORMS ?= linux/arm64/v8

.PHONY: setup db-up db-down db-reset migrate api-run web-start local test test-api test-web test-integration test-migrations test-e2e test-ui-container-mime lint build clean configure-image ensure-image-tag docker-build docker-build-api docker-build-ui docker-push docker-push-api docker-push-ui docker-publish docker-buildx docker-buildx-api docker-buildx-ui

configure-image:
	$(eval SHORT_SHA := $(shell git rev-parse --short=7 HEAD 2>/dev/null))
	$(eval REVISION ?= $(shell git rev-parse HEAD 2>/dev/null))
	$(eval IMAGE_TAG ?= $(if $(SHORT_SHA),$(SHORT_SHA),dev))
	$(eval VERSION ?= $(IMAGE_TAG))
	$(eval SOURCE_URL ?= https://github.com/bitofbytes-io/noted)
	$(eval API_IMAGE := $(REGISTRY)/$(API_IMAGE_REPO):$(IMAGE_TAG))
	$(eval UI_IMAGE := $(REGISTRY)/$(UI_IMAGE_REPO):$(IMAGE_TAG))
	@true

ensure-image-tag: configure-image
	@test -n "$(strip $(SHORT_SHA))" || (echo "Unable to determine git short SHA for image tagging." >&2; exit 1)

setup:
	mkdir -p .local/noted-assets/objects .local/noted-assets/temporary
	test -f .env || cp .env.example .env
	go mod download
	cd web && npm ci

db-up:
	$(COMPOSE) up -d --wait postgres

db-down:
	$(COMPOSE) down

# This removes only the dedicated noted Compose volume.
db-reset:
	$(COMPOSE) down --volumes
	$(MAKE) db-up migrate

migrate:
	go run ./cmd/migrate

api-run:
	go run ./cmd/api

docker-build-api: configure-image
	docker build \
		-f Docker/Dockerfile.api \
		--build-arg VERSION=$(VERSION) \
		--build-arg REVISION=$(REVISION) \
		--build-arg SOURCE_URL=$(SOURCE_URL) \
		-t $(API_IMAGE) \
		.

docker-build-ui: configure-image
	docker build \
		-f Docker/Dockerfile.ui \
		--build-arg VERSION=$(VERSION) \
		--build-arg REVISION=$(REVISION) \
		--build-arg SOURCE_URL=$(SOURCE_URL) \
		-t $(UI_IMAGE) \
		.

docker-build: docker-build-api docker-build-ui

docker-push-api: ensure-image-tag
	docker push $(API_IMAGE)

docker-push-ui: ensure-image-tag
	docker push $(UI_IMAGE)

docker-push: docker-push-api docker-push-ui

docker-publish: docker-build docker-push

docker-buildx-api: ensure-image-tag
	docker buildx build \
		-f Docker/Dockerfile.api \
		--platform=$(PLATFORMS) \
		--build-arg VERSION=$(VERSION) \
		--build-arg REVISION=$(REVISION) \
		--build-arg SOURCE_URL=$(SOURCE_URL) \
		-t $(API_IMAGE) \
		--push \
		.

docker-buildx-ui: ensure-image-tag
	docker buildx build \
		-f Docker/Dockerfile.ui \
		--platform=$(PLATFORMS) \
		--build-arg VERSION=$(VERSION) \
		--build-arg REVISION=$(REVISION) \
		--build-arg SOURCE_URL=$(SOURCE_URL) \
		-t $(UI_IMAGE) \
		--push \
		.

docker-buildx: docker-buildx-api docker-buildx-ui

web-start:
	cd web && npm start

local: db-up migrate
	@set -eu; \
		go run ./cmd/api & api_pid=$$!; \
		trap 'kill "$$api_pid" 2>/dev/null || true' EXIT INT TERM; \
		cd web && npm start

test: test-api test-web

test-api:
	go test ./...

test-web:
	cd web && npm test -- --watch=false

test-integration: db-up
	./scripts/run-integration-tests.sh

test-migrations: db-up
	./scripts/verify-migrations.sh

test-e2e: db-up
	./scripts/run-e2e-tests.sh

test-ui-container-mime: docker-build-ui
	./scripts/verify-ui-worker-mime.sh $(UI_IMAGE)

lint:
	test -z "$$(gofmt -l cmd internal migrations)"
	go vet ./...
	cd web && npm run lint

build:
	go build ./...
	cd web && npm run build

clean:
	rm -rf web/dist web/.angular web/test-results web/playwright-report
