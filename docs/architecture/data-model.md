# Noted: POC Data Model

Status: Implemented logical model with active post-POC extensions
Last updated: 2026-07-18

## Modeling principles

- The work is the learner-facing musical identity.
- Editions and assets are alternative representations of a work.
- Global/shared catalog metadata is separate from learner-owned state.
- Practice aggregates roll up to the work while retaining optional passage and asset context.
- Binary score contents live outside PostgreSQL.
- IDs should be opaque UUIDs or an equivalently safe generated identifier.

## Core entities

### users

- `id`
- `email` (unique, normalized)
- `display_name`
- `avatar_url`
- `auth_provider`
- `auth_subject`
- `week_starts_on` (Monday initially)
- `created_at`, `updated_at`, `last_login_at`

### composers

- `id`
- `canonical_name`
- `sort_name`
- `birth_year`, `death_year` (optional)
- `created_at`, `updated_at`

### works

- `id`
- `composer_id`
- `title`
- `subtitle`
- `catalog_number`
- `key_signature`
- `form`
- `period`
- `published_difficulty_label`
- `notes`
- `created_by_user_id`
- `created_at`, `updated_at`

POC uniqueness should avoid accidental duplicate creation but must not assume title alone identifies a work.

### movements

- `id`
- `work_id`
- `sequence_number`
- `title`
- `tempo_marking`
- `measure_count` (optional/derived)

### editions

- `id`
- `work_id`
- `name`
- `editor`
- `publisher`
- `publication_year`
- `source_url`
- `rights_note`
- `created_by_user_id`
- `created_at`, `updated_at`

### score_assets

- `id`
- `edition_id`
- `asset_type` (`pdf`, `musicxml` initially)
- `storage_key`
- `original_filename`
- `media_type`
- `byte_size`
- `sha256`
- `source_url`
- `rights_note`
- `playback_capable`
- `uploaded_by_user_id`
- `created_at`, `updated_at`

The POC may allow identical checksums when they are attached intentionally, but should surface duplicates rather than silently create them.

### learner_works

- `id`
- `user_id`
- `work_id`
- `status`
- `is_favorite`
- `personal_difficulty`
- `personal_notes`
- `last_score_asset_id`
- `last_bpm`
- `created_at`, `updated_at`

Unique constraint: `(user_id, work_id)`.

### tags

- `id`
- `user_id`
- `name`
- `normalized_name`
- `created_at`

Unique constraint: `(user_id, normalized_name)`.

### learner_work_tags

- `learner_work_id`
- `tag_id`

### practice_sessions

- `id`
- `user_id`
- `work_id`
- `movement_id` (optional)
- `score_asset_id` (optional)
- `started_at`
- `ended_at` (optional for manual entries)
- `duration_seconds`
- `entry_method` (`timer`, `manual`)
- `start_measure`, `end_measure` (optional)
- `hand_part` (optional)
- `starting_bpm`, `ending_bpm` (optional)
- `notes`
- `created_at`, `updated_at`

Validation:

- Duration is positive and bounded to a reasonable maximum.
- Measure values are positive and end is not less than start.
- BPM values are positive and within the supported product range.
- Optional movement and asset must belong to the selected work.
- Only one active server-side timer/session may exist per learner if running timers are persisted.

### user_preferences

This may be a table or explicit columns on `users` for the POC:

- Default metronome BPM.
- Metronome sound/accent preference.
- Week-start preference.

## Relationship view

```text
composer 1 ── * work 1 ── * movement
                    |
                    ├── * edition 1 ── * score_asset
                    |
                    ├── * learner_work * ── 1 user
                    |         `── * tag (through learner_work_tags)
                    |
                    `── * practice_session * ── 1 user
                              ├── optional movement
                              `── optional score_asset
```

## Later entities intentionally omitted from POC migrations

- Household and sharing grants.
- Physical books, holdings, and book contents.
- Lessons, assignments, and practice targets.
- Annotation layers and strokes.
- External source import jobs.

Do not add empty speculative tables solely for these later concepts. Add them through migrations when their requirements become active.

## Active post-POC recognition model

The dual-engine OMR increment activates recognition lineage without changing the meaning of an original score asset. These fields/tables are current migrations, not reserved placeholders.

### Current score_assets extensions

- `derived_from_asset_id` (nullable self-reference; required for OCR output)
- `verification_state` (`original`, `unverified_ocr`, `verified`, `corrected`)
- `playback_validation_status` (`not_checked`, `ready`, `needs_review`, `blocked`)
- `playback_validation_issues` (bounded JSON array of stable rhythmic/format warnings)

The implemented recognition route currently accepts eligible PDF assets; image-source asset types remain future work. The original and generated MusicXML are separate immutable binary objects. Re-running OCR creates a new result/version rather than silently replacing an existing asset. `unverified_ocr` remains distinct from playback validation: passing the alphaTab gate means the result can be loaded and timed, not that its notes match the PDF.

### recognition_jobs

- `id`
- `user_id`
- `source_asset_id`
- `status` (`queued`, `processing`, `succeeded`, `failed`, `cancelled`)
- `engine` (`audiveris+homr` for the dual-engine worker; legacy local jobs may be `audiveris`)
- `engine_version` (queued rows default to `audiveris-5.10.2+homr-0.7.0`; a successful remote job records worker pipeline contract version `1`; per-engine pins remain in the report/image)
- `output_asset_id` (nullable until success)
- `project_storage_key` (optional private `.omr` artifact)
- `lease_owner`, `lease_expires_at`, `attempt_count`
- `failure_code`, `failure_message` (sanitized; nullable)
- `flagged_measures`, `corrected_measures` (nullable denormalized report summaries)
- `quality_report` (nullable validated JSONB; required from the dual-engine worker on success)
- `started_at`, `finished_at`
- `created_at`, `updated_at`

### Quality report schema v1

The report is a bounded (maximum 1 MiB), strict JSON object. Unknown fields, invalid counts/confidence values, empty engine summaries, missing measures, or a playability result other than `passed` are rejected before persistence.

| Field | Meaning |
|---|---|
| `schemaVersion` | Integer `1`. |
| `totalMeasures` | Master measure count, from 1 through 10,000. |
| `flaggedMeasures` | Unique measure indexes with repair/fusion issues. |
| `correctedMeasures` | Flagged indexes changed by repair or valid-engine substitution; cannot exceed `flaggedMeasures`. |
| `suspectMeasures` | Unique indexes with non-high confidence or issues. |
| `selectedEngine` | `fusion`, `audiveris`, or `homr` for the current producer. |
| `engines` | Per-engine object keyed by `audiveris`/`homr`, including version, status, measure/flag/correction/suspect counts, and bounded sanitized error/warning text when present. |
| `measures[]` | One row per part/measure with `partId`, source XML `number`, 1-based `measureIndex`, `sourceEngine`, `agreement`, `confidence` (`high`, `medium`, `low`), `corrected`, and stable `issues[]`. |
| `playability` | `{status: "passed", measureCount, totalTicks}` from alphaTab 1.8.4; `measureCount` must equal `totalMeasures`. |

Confidence is heuristic review guidance. High means both aligned engine measures agree and pass duration checks; medium covers a valid substitution, valid disagreement, or a valid backbone with an invalid alternate; low covers a single-engine result, missing alignment, or both invalid. It is not a probability or correctness guarantee.

Validation and ownership rules:

- The source must be an eligible PDF asset uploaded by and visible to the requesting learner.
- Source, derived asset, recognition job, edition, and user scope must remain consistent.
- Only one queued/processing job per source/user may run at once; retries create new auditable rows after a terminal job.
- Deleting a derived result does not delete the original. Original deletion must account for or cascade derived/job artifacts deliberately.
- Worker logs and `.omr` projects are private operational artifacts with explicit retention limits. Projects are available only through a learner-scoped authenticated download route.
- Compressed `.mxl` and `.omr` inputs are untrusted archives. Importers enforce entry/count/expanded-size limits and reject unsafe paths or unexpected content; the dual-engine pipeline returns plain MusicXML.
- A failed or cancelled job has no imported output asset or persisted quality report. `unplayable_output` is retained as a stable `failure_code` from the private worker.

## Dashboard query expectations

The implementation plan should account for these read models:

- Current learner works ordered by status/activity.
- Last practice time and latest BPM per work.
- PDF and playback capability flags per work.
- Recently imported assets visible to the learner.
- Monday-first daily practice totals for the selected week.
- Total duration and session count for that week.

These may be implemented as SQL queries/views or service aggregation. They do not require separately stored aggregate tables in the POC.
