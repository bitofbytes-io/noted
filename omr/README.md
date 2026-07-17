# Noted OMR worker

The OMR image runs a private, single-job HTTP wrapper around the Audiveris batch CLI. It is intended for the AMD64 NAS host and must not be published through Traefik or exposed to the browser.

## Runtime contract

- `GET /healthz` checks the Go process.
- `GET /readyz` verifies writable temporary storage and the pinned Audiveris executable/version.
- `POST /v1/recognize` accepts one multipart field named `file` and requires `Authorization: Bearer <token>`.
- A successful response streams `.musicxml` or `.mxl` and reports the engine in `X-Noted-OMR-Engine` and `X-Noted-OMR-Version`.
- Errors use `{"error":{"code":"...","message":"..."}}`. Stable codes include `unauthorized`, `invalid_request`, `invalid_pdf`, `input_too_large`, `too_many_pages`, `busy`, `timeout`, `cancelled`, `conversion_failed`, `output_too_large`, `invalid_output`, `worker_unavailable`, and `worker_version_mismatch`.

The worker permits one request at a time, limits inputs and outputs to 25 MiB, limits PDFs to 25 pages, terminates stalled uploads after two minutes, and terminates conversion after 10 minutes. Each request uses a private directory under `OMR_TEMP_ROOT`; terminal requests and interrupted-job remnants found at startup are removed.

Configuration:

- `OMR_TOKEN_FILE` defaults to `/run/secrets/noted_omr_token`. `OMR_TOKEN` is available only as a local-development fallback.
- `OMR_LISTEN_ADDR` defaults to `:8788`.
- `OMR_TEMP_ROOT` defaults to `/tmp/noted-omr`.

The NAS container should be capped at two CPUs and 4 GiB memory, run with `no-new-privileges`, have outbound networking denied, and allow private TCP `8788` only from the Crystal node addresses. It receives no PostgreSQL, Google OAuth, session, or NFS credentials. CPU, memory, and a 1 GiB scratch-storage ceiling belong to the NAS container runtime; the HTTP worker independently enforces concurrency, byte, page, time, and a 512 MiB post-conversion job-footprint limit. Audiveris HOME, XDG, and temporary directories are isolated inside each cleaned job directory.

## Audiveris provenance and release gate

The image installs the official `Audiveris-5.10.2-ubuntu22.04-x86_64.deb` release asset from <https://github.com/Audiveris/audiveris/releases/tag/5.10.2>. The worker invokes the package's `/opt/audiveris/bin/Audiveris` executable directly. Its pinned SHA-256 is:

`9470d15e79dd4fe45f817b8545ba9f8e57ddaebff3b3a1031f21218647602068`

Audiveris is licensed under AGPL-3.0-or-later. The package license and corresponding source are available from <https://github.com/Audiveris/audiveris/tree/5.10.2>. The image changes only the installed launcher configuration's maximum Java heap from 8 GiB to 2560 MiB so it remains below the container's 4 GiB limit; the pinned package itself and Audiveris code are not rebuilt.

Before production release, the owner must record acceptance of the repository's OCR quality spike and AGPL review for this exact image, private network interaction, notices, and corresponding-source delivery. The separate worker boundary does not itself settle license obligations.
