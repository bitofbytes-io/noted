# Noted: POC API Contract Outline

Status: Planning contract; payload details may be refined before implementation
Last updated: 2026-07-13

## Conventions

- Base path: `/api`.
- JSON for metadata and commands; multipart upload for score assets.
- UTC timestamps in RFC 3339 format.
- Opaque string IDs.
- Consistent error envelope containing a stable code, readable message, and optional field errors.
- Every learner-owned operation resolves the current user server-side.
- Pagination is optional for the small POC dataset but response shapes should allow it later.

## Health and session

- `GET /api/health` — process liveness.
- `GET /api/ready` — PostgreSQL and asset-storage readiness.
- `GET /api/session` — authentication state, optional current user, authentication mode, and runtime capabilities.
- `GET /api/auth/google` — begin Google OAuth with a one-time server-stored state value.
- `GET /api/auth/google/callback` — exchange the Google code, enforce verified allow-listed email, and create the production session.
- `DELETE /api/session` — revoke the current opaque session and clear its secure cookie.

## Dashboard

- `GET /api/dashboard?week=<date>` — current works, recent imports, and Monday-first weekly metrics.

## Works and catalog

- `GET /api/works?q=&status=&favorite=&tag=` — learner-visible local works.
- `POST /api/works` — create work and optional initial edition.
- `GET /api/works/{workId}` — work, movements, editions/assets, learner state, and practice summary.
- `PATCH /api/works/{workId}` — edit permitted catalog metadata.
- `POST /api/works/{workId}/movements` — add movement.
- `POST /api/works/{workId}/editions` — add edition.

## Learner repertoire

- `PUT /api/works/{workId}/learner-state` — set status, favorite, personal difficulty, notes, last BPM.
- `GET /api/tags` — list current learner's tags.
- `POST /api/tags` — create personal tag.
- `PUT /api/works/{workId}/tags` — replace or update the learner's tags for the work.

## Assets

- `POST /api/editions/{editionId}/assets` — multipart upload plus source/rights metadata.
- `GET /api/assets/{assetId}` — asset metadata.
- `GET /api/assets/{assetId}/content` — authenticated streaming response with range support if required by the selected viewers.
- `DELETE /api/assets/{assetId}` — delete an owned/eligible asset after relationship checks; returns `409 asset_in_use` while practice history references it.

Upload responses include asset identity, type, size, checksum, PDF/playback capabilities, and content endpoint.

## Practice

- `GET /api/practice-sessions?from=&to=&workId=` — recent learner sessions; `from` and `to` are inclusive RFC 3339 `startedAt` bounds.
- `POST /api/practice-sessions/start` — start explicit timer for a work and optional passage context.
- `POST /api/practice-sessions/{sessionId}/stop` — stop timer and add final fields.
- `POST /api/practice-sessions` — create manual session.
- `PATCH /api/practice-sessions/{sessionId}` — correct a learner-owned entry; omitted fields are preserved and explicit `null` clears nullable fields.
- `DELETE /api/practice-sessions/{sessionId}` — delete learner-owned entry.
- `GET /api/practice-summary?week=<date>` — Monday-first daily totals and current-work summary.

The planner may choose a client-only running timer with one final create call for the earliest slice. If so, the implementation must document refresh/sleep behavior and add server-side running timers before claiming durable timer support.

## Preferences

- `GET /api/preferences`
- `PATCH /api/preferences` — week start and metronome preferences.

## Post-POC OCR extension

These routes are reserved for the Audiveris increment and are not implemented by the completed POC:

- `POST /api/assets/{assetId}/recognition-jobs` — explicitly request OCR for an authorized eligible source.
- `GET /api/recognition-jobs/{jobId}` — return learner-scoped status, engine/version, timestamps, sanitized failure details, and output asset when available.
- `GET /api/recognition-jobs/{jobId}/project` — download the retained private Audiveris `.omr` correction project for the owning learner.
- `POST /api/recognition-jobs/{jobId}/retry` — create a bounded retry after a terminal failure.
- `DELETE /api/recognition-jobs/{jobId}` — cancel when possible or remove terminal job artifacts subject to retention policy; never delete the original source implicitly.

A successful job returns a normal MusicXML asset linked to its source with `verificationState: "unverified_ocr"`. The UI must display that state before playback. Job creation is idempotent for an active source/user/configuration fingerprint and returns `202 Accepted`; it never holds the upload request open while Audiveris runs.

## Representative error codes

- `validation_failed`
- `not_authenticated`
- `not_authorized`
- `not_found`
- `conflict`
- `unsupported_asset_type`
- `upload_too_large`
- `asset_storage_unavailable`
- `invalid_measure_range`
- `practice_timer_already_running`
- `recognition_already_running`
- `recognition_unsupported_source`
- `recognition_failed`
- `recognition_timed_out`
- `recognition_output_invalid`

## Contract tests expected

- One user cannot fetch or mutate another user's learner state or practice.
- Unsafe filenames cannot escape the asset root.
- Unsupported and oversized uploads fail without leaving files or rows.
- Asset content requires authorization.
- Movement/asset references in practice belong to the selected work.
- Week boundaries begin on Monday.
- Timer conflicts and invalid measure ranges return stable errors.
- Future OCR jobs cannot read another learner's source or expose their output/logs; invalid, oversized, timed-out, and failed jobs leave no imported MusicXML or temporary files.
