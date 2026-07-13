# Noted: Deployment Architecture

Status: Proposed, aligned with existing infrastructure
Last updated: 2026-07-13

## Production topology

```text
Browser / iPad
      |
      | HTTPS: noted.bitofbytes.io
      v
Traefik on Crystal Docker Swarm
      |-- /api/* ----------> noted-api:8080
      |                         |-- NAS PostgreSQL :8432
      |                         `-- private score storage on NAS
      `-- all other paths ---> noted-ui:80

CI / deployment
      |
      | Tailscale
      v
registry.tail209cfc.ts.net
      |
      `-- noted-api:<commit> and noted-ui:<commit>
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

## Future Audiveris worker

The post-POC OCR increment adds a private, asynchronous `noted-omr-worker` running a pinned Audiveris/Java distribution. It is not part of the initial deployment definition of done.

- Do not expose the worker through Traefik or grant it OAuth/session secrets.
- Give it read/write access only to bounded job staging and derived-output paths, not the entire household share when the platform can enforce narrower mounts.
- Schedule conservatively with explicit CPU, memory, temporary-space, page-count, runtime, and concurrency limits; multi-page OMR is substantially heavier than ordinary API work.
- Keep PostgreSQL job ownership and authorization in the Go API. Prefer an internal claim/lease protocol or narrowly scoped queue over direct browser invocation.
- Disable outbound network access unless a documented runtime dependency requires it.
- Preserve version/configuration provenance, bounded logs, checksums, and optional `.omr` project artifacts for troubleshooting/future correction.
- Include derived MusicXML, retained `.omr` artifacts, and job state in backup/restore and reconciliation policy.
- Complete an AGPL-3.0 compliance review for the exact packaging, deployment, modifications, and user interaction before the worker is released.
