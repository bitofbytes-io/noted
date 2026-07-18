# Noted: POC API Contract Outline

Status: Implemented contract; active post-POC extensions included
Last updated: 2026-07-18

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

## Active post-POC OCR extension

These authenticated learner-scoped routes are implemented after the historical POC boundary:

- `POST /api/assets/{assetId}/recognition-jobs` — explicitly request OCR for an authorized eligible source.
- `GET /api/assets/{assetId}/recognition-jobs` — list attempts newest first so a derived output can be matched to its exact quality report/project.
- `GET /api/recognition-jobs/{jobId}` — return learner-scoped status, engine/version, timestamps, stable sanitized failure details, quality report, project URL, and output asset when available.
- `GET /api/recognition-jobs/{jobId}/project` — download the retained private Audiveris `.omr` correction project for the owning learner.
- `POST /api/recognition-jobs/{jobId}/retry` — create a bounded retry after a terminal failure.
- `DELETE /api/recognition-jobs/{jobId}` — cancel a queued/processing attempt; it is an idempotent no-op for a terminal attempt and never deletes the source.

A successful job returns a normal MusicXML asset linked to its source with `verificationState: "unverified_ocr"`. The UI must display that state and quality summary before playback. Job creation returns `202 Accepted`; the unique active-job rule returns the existing `queued`/`processing` job for the same source/user instead of starting a duplicate. The API dispatcher claims jobs with renewable database leases and never holds the upload request open while recognition runs.

`RecognitionJob` fields are:

- `id`, `sourceAssetId`, optional `outputAssetId`;
- `status`: `queued`, `processing`, `succeeded`, `failed`, or `cancelled`;
- `engine`, `engineVersion`;
- optional `errorCode` and `failureMessage` (bounded and sanitized);
- optional `flaggedMeasures`, `correctedMeasures`, and `report`;
- optional `projectDownloadUrl` only when a retained project exists;
- `createdAt`, optional `startedAt`/`finishedAt`, and `updatedAt`.

The dual-engine worker sends a bounded `multipart/mixed` response with `X-Noted-Artifact: score`, optional `project`, and required `report` parts. The API rejects unknown/duplicate artifacts, invalid content types, oversized data, unsafe archives, missing reports from `audiveris+homr`, and schema-invalid reports before importing any asset.

The quality report uses schema version 1:

```json
{
  "schemaVersion": 1,
  "totalMeasures": 1,
  "flaggedMeasures": 0,
  "correctedMeasures": 0,
  "suspectMeasures": 0,
  "selectedEngine": "fusion",
  "engines": {
    "audiveris": { "version": "5.10.2", "status": "succeeded" },
    "homr": { "version": "0.7.0", "status": "succeeded" }
  },
  "measures": [
    {
      "partId": "P1",
      "number": "1",
      "measureIndex": 1,
      "sourceEngine": "audiveris",
      "agreement": true,
      "confidence": "high",
      "corrected": false,
      "issues": []
    }
  ],
  "playability": { "status": "passed", "measureCount": 1, "totalTicks": 3840 }
}
```

The example illustrates shape, not a real recognition result. `measures` contains rows for every part/measure in an actual report. Counts are summary indexes across parts; `confidence` is `high`, `medium`, or `low`, and is review guidance rather than an accuracy probability. Full validation constraints are in [the data model](data-model.md#quality-report-schema-v1).

The worker's internal `POST /v1/recognize` route is private and bearer-authenticated. A final headless alphaTab failure returns HTTP `422` and `unplayable_output`; the API persists that stable code on the failed job and imports no MusicXML. This differs from `playback_validation_status: "needs_review"` on user-supplied MusicXML, which may still be playable with warnings.

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
- `unplayable_output`

## Contract tests expected

- One user cannot fetch or mutate another user's learner state or practice.
- Unsafe filenames cannot escape the asset root.
- Unsupported and oversized uploads fail without leaving files or rows.
- Asset content requires authorization.
- Movement/asset references in practice belong to the selected work.
- Week boundaries begin on Monday.
- Timer conflicts and invalid measure ranges return stable errors.
- OCR jobs cannot read another learner's source or expose another learner's output/report/project; invalid, oversized, timed-out, cancelled, unplayable, and failed jobs leave no imported MusicXML or job temporary files.
- The API rejects missing/duplicate/oversized quality reports, unknown fields, invalid counts, invalid confidence values, and a playability measure count that differs from `totalMeasures`.
- Fallback is tested for either engine failing; the dual-engine contract requires a report even when only one engine survives.
