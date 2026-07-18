SHELL := /bin/sh
COMPOSE := docker compose -p noted -f compose.local.yml

REGISTRY ?= registry.tail209cfc.ts.net
API_IMAGE_REPO ?= noted-api
UI_IMAGE_REPO ?= noted-ui
OMR_IMAGE_REPO ?= noted-omr
PLATFORMS ?= linux/arm64/v8
OMR_PLATFORMS ?= linux/amd64
OMR_DOCKERFILE ?= omr/Dockerfile
LOCAL_AUDIVERIS_IMAGE ?= noted-audiveris:5.10.2

.PHONY: setup db-up db-down migrate seed revalidate-musicxml omr-build omr-build-container api-run web-start local test test-api test-web test-migrations test-e2e test-ui-container-mime lint build clean configure-image ensure-image-tag docker-build docker-build-api docker-build-ui docker-build-omr docker-push docker-push-api docker-push-ui docker-push-omr docker-publish docker-buildx docker-buildx-api docker-buildx-ui docker-buildx-omr

configure-image:
	$(eval SHORT_SHA := $(shell git rev-parse --short=7 HEAD 2>/dev/null))
	$(eval REVISION ?= $(shell git rev-parse HEAD 2>/dev/null))
	$(eval IMAGE_TAG ?= $(if $(SHORT_SHA),$(SHORT_SHA),dev))
	$(eval VERSION ?= $(IMAGE_TAG))
	$(eval SOURCE_URL ?= https://github.com/bitofbytes-io/noted)
	$(eval API_IMAGE := $(REGISTRY)/$(API_IMAGE_REPO):$(IMAGE_TAG))
	$(eval UI_IMAGE := $(REGISTRY)/$(UI_IMAGE_REPO):$(IMAGE_TAG))
	$(eval OMR_IMAGE := $(REGISTRY)/$(OMR_IMAGE_REPO):$(IMAGE_TAG))
	@true

ensure-image-tag: configure-image
	@test -n "$(strip $(SHORT_SHA))" || (echo "Unable to determine git short SHA for image tagging." >&2; exit 1)

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

revalidate-musicxml:
	go run ./cmd/revalidate-musicxml

api-run:
	go run ./cmd/api

omr-build:
	@if [ "$$(uname -s)" = Darwin ] && [ "$$(uname -m)" = arm64 ]; then \
		./scripts/install-audiveris-macos.sh; \
	else \
		$(MAKE) omr-build-container; \
	fi

omr-build-container:
	docker build \
		-f omr/Dockerfile.audiveris \
		--platform=linux/amd64 \
		-t $(LOCAL_AUDIVERIS_IMAGE) \
		.

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

docker-build-omr: configure-image
	docker build \
		-f $(OMR_DOCKERFILE) \
		--platform=$(OMR_PLATFORMS) \
		--build-arg VERSION=$(VERSION) \
		--build-arg REVISION=$(REVISION) \
		--build-arg SOURCE_URL=$(SOURCE_URL) \
		-t $(OMR_IMAGE) \
		.

docker-build: docker-build-api docker-build-ui

docker-push-api: ensure-image-tag
	docker push $(API_IMAGE)

docker-push-ui: ensure-image-tag
	docker push $(UI_IMAGE)

docker-push-omr: ensure-image-tag
	docker push $(OMR_IMAGE)

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

docker-buildx-omr: ensure-image-tag
	docker buildx build \
		-f $(OMR_DOCKERFILE) \
		--platform=$(OMR_PLATFORMS) \
		--build-arg VERSION=$(VERSION) \
		--build-arg REVISION=$(REVISION) \
		--build-arg SOURCE_URL=$(SOURCE_URL) \
		-t $(OMR_IMAGE) \
		--push \
		.

docker-buildx: docker-buildx-api docker-buildx-ui

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

test-ui-container-mime:
	./scripts/verify-ui-worker-mime.sh

lint:
	test -z "$$(gofmt -l cmd internal)"
	go vet ./...
	cd web && npm run lint

build:
	go build ./...
	cd web && npm run build

clean:
	rm -rf bin web/dist web/.angular web/test-results web/playwright-report
