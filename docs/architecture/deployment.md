# Noted: Deployment Architecture

Status: Proposed production topology with implemented application/OMR images
Last updated: 2026-07-18

## Production topology

```text
Browser / iPad
      |
      | HTTPS: noted.bitofbytes.io
      v
Traefik on Crystal Docker Swarm
      |-- /api/* ----------> noted-api:8080
      |                         |-- NAS PostgreSQL :8432
      |                         |-- private score storage on NAS
      |                         `-- private HTTP :8788
      |                                  |
      |                                  v
      |                         noted-omr-worker on bahamut
      |                         (NAS / AMD64; promotion gated)
      `-- all other paths ---> noted-ui:80

CI / deployment
      |
      | Tailscale
      v
registry.tail209cfc.ts.net
      |
      `-- noted-api:<commit>, noted-ui:<commit>, and noted-omr:<commit>
```

## Alignment with Anthology and home_swarm

- One application repository containing Go API and Angular UI source.
- Split production Dockerfiles and independently deployable API/UI images.
- Commit-derived image tags and multi-architecture builds.
- Private image registry reached through the tailnet.
- `home_swarm` receives a `noted-stack.yml`, deployment target, log aliases, version reporting, Traefik routers/services, and deployment hook following existing conventions.
- UI runtime configuration supplies the API URL at container start.
- API reads database and OAuth credentials from Swarm secrets using `_FILE` variables.
- Postgres migrations are versioned with the API and applied through an explicit migration policy.
- Both services have health checks, start-first rolling updates, and rollback configuration.
- Application logs flow through the existing Swarm log-collection path.

## Data placement

### PostgreSQL on NAS

Stores:

- Accounts and sessions.
- Catalog and provenance metadata.
- Learner-specific state, tags, and preferences.
- Practice sessions and aggregates.
- Asset metadata and storage keys.

Does not store the binary contents of full PDF or MusicXML files.

### Private score storage on NAS

Stores:

- Original uploaded PDFs.
- MusicXML/MEI files.
- Derived render or playback artifacts if needed.
- Future annotation and recognition artifacts.

Storage must support stable identifiers, authorization through the API, backups, integrity checks, size limits, and deletion. Direct public URLs should not bypass Noted authorization.

## Selected initial asset-storage direction

Use a dedicated Synology NFS shared folder mounted into the Noted API service. Do not introduce an S3-compatible service for the first version.

Rationale:

- DSM Container Manager can run MinIO or another S3-compatible container, but this would add another stateful service, credential boundary, upgrade path, monitoring target, and backup concern.
- Noted is initially a small private household application and does not require object-store scale.
- The NAS already provides the durable storage and backup boundary.
- Only the Go API needs filesystem access; browsers and the Angular UI never access the share directly.
- An internal storage interface in the Go application can allow a later move to S3 without changing domain or HTTP APIs.

### Proposed NFS layout

- Synology shared folder: a dedicated location such as `noted-assets` rather than a general-purpose household share.
- Container mount point: `/data/assets` in `noted-api` only.
- Application object keys use opaque IDs rather than user-provided filenames.
- Original filename, media type, checksum, size, ownership, provenance, and logical asset relationship live in PostgreSQL.
- Temporary uploads are written to a staging path, validated, then atomically moved into their final location.
- The API streams authorized downloads or returns them through an authenticated endpoint.

Example logical layout:

```text
/data/assets/
├── originals/
│   ├── pdf/<asset-id>
│   └── musicxml/<asset-id>
├── derived/<asset-id>/
├── temporary/
└── quarantine/
```

### Swarm/NFS requirements

- Every node eligible to run `noted-api` must be able to reach the NAS NFS service.
- Prefer a Swarm-managed NFS volume definition over an implicit host bind path so a missing mount fails deployment rather than silently writing to a node's local disk.
- Restrict the Synology NFS export to the Crystal/Swarm network addresses that require it.
- Use a dedicated NAS service identity or consistent numeric UID/GID with only the required permissions.
- Do not grant the API access to unrelated NAS shares.
- Decide whether API replicas may write concurrently; uploads should use unique keys and atomic finalization.
- Add a storage readiness check so an API task does not accept uploads when the shared volume is unavailable.
- Keep upload size limits and free-space thresholds in configuration.
- Validate the exact Synology NFS version and mount options on Crystal before production deployment.

### Backup and restore

- Include the `noted-assets` shared folder in Synology snapshots and/or Hyper Backup.
- Back up PostgreSQL and assets on a coordinated schedule.
- Preserve database asset records and filesystem objects as one logical restore set.
- Run a restore drill that verifies a restored database record can open and play its restored score assets.
- Periodically reconcile database asset records against files and checksums to find missing or orphaned objects.

## Initial security boundary

- Google OAuth is required in production.
- Only explicitly allowed email addresses can create sessions.
- The API owns authorization decisions; UI visibility is not treated as access control.
- Score downloads use authenticated API streaming or short-lived signed URLs.
- Learner-specific practice, tags, status, and annotations remain private.
- Shared household assets do not automatically share private learner state.
- Uploads are validated by size, declared type, and detected file signature.

## Future portability

The Go backend should define asset storage behind a small internal interface supporting put, open, delete, existence, and metadata/checksum operations. The first implementation uses the NFS filesystem. A future S3 implementation can be added if signed URLs, external integrations, scale, or independent storage services become valuable.

## Private OMR worker

Active post-POC development adds a private, asynchronous `noted-omr-worker` image with Audiveris
5.10.2, homr 0.7.0 and its ONNX weights, music21 10.3.0, and alphaTab 1.8.4. The component and its
[synthetic-corpus benchmark](../implementation/omr-benchmark.md) are implemented, but it is not
production-accepted until the representative real-score, NAS-resource/failure,
dependency/license, and owner-acceptance gates in [ADR 0002](../decisions/0002-audiveris-ocr-pipeline.md) are recorded.

- Do not expose the worker through Traefik or grant it OAuth/session secrets.
- Run the worker on `bahamut` through Synology Container Manager. Do not schedule Audiveris, homr, or the repair/fusion pipeline on the ARM Raspberry Pi Crystal Swarm; those nodes keep the lightweight API/UI and job-orchestration responsibilities.
- Give the worker no PostgreSQL, NFS, Google, or session credentials. The Go API streams an already-authorized PDF over private TCP with a dedicated bearer secret; the worker returns artifacts to the API rather than choosing or persisting learner objects itself.
- Permit private TCP `8788` only from the Crystal application nodes. The browser never calls `/v1/recognize`, `/healthz`, or `/readyz` directly.
- Run one request at a time with a two-CPU, 4-GiB container ceiling and a 1-GiB scratch ceiling. Independently retain worker limits of 25 MiB input/output, 25 pages, two-minute upload, ten-minute processing, bounded logs/archives, and 512 MiB post-conversion job footprint.
- Keep PostgreSQL job ownership, authorization, claim/lease recovery, retries, and cancellation in the Go API. API replicas use database leases; the worker's one-slot queue returns `429 busy`, which the API retries with bounded backoff.
- Disable outbound runtime network access. `homr --init` must run at image build time; the deployed image must contain the required weights and pass the exact-version plus ONNX-checksum readiness checks without downloading anything.
- Use a non-root UID, `no-new-privileges`, read-only application/dependency paths, isolated per-job HOME/XDG/temp/cache directories, and cleanup after terminal requests and process restart. The bounded NAS scratch mount must permit execution because Audiveris/JavaCPP extracts native libraries there; application and dependency paths remain read-only.
- Preserve image revision, engine/dependency versions, bounded logs, Audiveris package checksum, homr model manifest, quality report, output checksums, and optional `.omr` project artifacts for troubleshooting/future correction.
- Include derived MusicXML, retained `.omr` artifacts, and job state in backup/restore and reconciliation policy.
- Complete and accept the exact Audiveris/homr AGPL packaging/network review, every bundled model's source/hash/license/citation/redistribution inventory, music21 BSD/corpus review, and alphaTab MPL/subasset notices before the worker is released.
- Attach actual pinned-image before/after harness output and representative runtime/memory/scratch/cancellation evidence to the release. A reference self-check alone does not satisfy this gate.
