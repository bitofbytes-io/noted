# Noted OMR worker

The OMR image runs a private, single-job dual-engine recognition pipeline. It is intended for the AMD64 NAS host and must not be published through Traefik or exposed to the browser.

For every accepted PDF, the worker deterministically renders each page at 300 DPI and sends the same prepared images to both recognizers, sequentially. Audiveris receives a multi-page TIFF and homr receives the ordered page PNGs with CPU inference forced. Each available MusicXML result is repaired with music21, then aligned and arbitrated measure-by-measure. Audiveris remains the structural backbone when it is usable; a valid homr measure replaces an invalid Audiveris measure, and a complete homr result is the fallback when Audiveris fails. A DOM-free alphaTab import is the final hard gate.

The pinned component identity is `audiveris-5.10.2+homr-0.7.0+music21-10.3.0+alphatab-1.8.4`. Readiness verifies every installed version and the checksums of all bundled homr and RapidOCR ONNX models.

## Runtime contract

- `GET /healthz` checks the Go process.
- `GET /readyz` verifies writable temporary storage, all pinned component versions, the pipeline scripts, and the bundled model checksums.
- `POST /v1/recognize` accepts one multipart field named `file` and requires `Authorization: Bearer <token>`.
- A pipeline success streams `multipart/mixed` with a MusicXML `score` part, an optional Audiveris `project` (`.omr`) part, and an `application/json` `report` part. Each part carries `X-Noted-Artifact`; the response carries `X-Noted-OMR-Engine: audiveris+homr` and the exact component version above.
- Errors use `{"error":{"code":"...","message":"..."}}`. Stable codes include `unauthorized`, `invalid_request`, `invalid_pdf`, `input_too_large`, `too_many_pages`, `busy`, `timeout`, `cancelled`, `conversion_failed`, `output_too_large`, `invalid_output`, `unplayable_output`, `worker_unavailable`, and `worker_version_mismatch`. `unplayable_output` is a 422 response and means the fused file failed the alphaTab gate or did not match its quality report.

The versioned report is bounded to 1 MiB. Schema version 1 contains final master-bar totals; flagged, corrected, and suspect counts; per-engine outcomes; one-based per-part measure rows with source/agreement/confidence/issues; and the alphaTab playability result and tick count. A report is validated before the worker streams it.

The worker permits one request at a time, limits inputs and outputs to 25 MiB, limits PDFs to 25 pages, terminates stalled uploads after two minutes, and terminates conversion after 10 minutes. Each request uses a private directory under `OMR_TEMP_ROOT`; terminal requests and interrupted-job remnants found at startup are removed.

Configuration:

- `OMR_TOKEN_FILE` defaults to `/run/secrets/noted_omr_token`. `OMR_TOKEN` is available only as a local-development fallback.
- `OMR_LISTEN_ADDR` defaults to `:8788`.
- `OMR_TEMP_ROOT` defaults to `/tmp/noted-omr`.

The production worker is to run on `bahamut` through Synology Container Manager, not as a service on the Raspberry Pi Crystal Swarm. Crystal runs the API/UI and submits authorized jobs over private TCP; the NAS performs Audiveris, homr, repair, fusion, and alphaTab validation after the production gates are accepted.

The NAS container should be capped at two CPUs and 4 GiB memory, run with `no-new-privileges`, have outbound networking denied, and allow private TCP `8788` only from the Crystal node addresses. It receives no PostgreSQL, Google OAuth, session, or NFS credentials. CPU, memory, and a 1 GiB scratch-storage ceiling belong to the NAS container runtime; the HTTP worker independently enforces concurrency, byte, page, time, and a 512 MiB post-conversion job-footprint limit. HOME, XDG, Java, Python/ONNX thread counts, and temporary storage are isolated inside each cleaned job directory. The container root filesystem and application/dependency paths may be read-only, but the bounded `/tmp` scratch mount must permit execution because Audiveris/JavaCPP extracts native libraries there. Engine failures are recorded in the report and can fall back to the surviving engine, but cancellation, timeout, both engines failing, or a failed playability gate remain terminal.

## Build and offline model contract

Audiveris publishes an x86-64 package, so builds on ARM development hosts must target the NAS architecture explicitly:

```sh
docker build --platform linux/amd64 -f omr/Dockerfile -t noted-omr .
```

The image build installs homr and music21 in a private Python 3.11 environment, downloads homr's three model files once with CPU mode selected, bundles RapidOCR's models, and writes a SHA-256 manifest. Runtime outbound access is neither required nor allowed. The alphaTab package is installed into the image and the gate uses its core importer without a browser DOM.

## Recognizer provenance and release gate

The image installs the official `Audiveris-5.10.2-ubuntu22.04-x86_64.deb` release asset from <https://github.com/Audiveris/audiveris/releases/tag/5.10.2>. The worker invokes the package's `/opt/audiveris/bin/Audiveris` executable directly. Its pinned SHA-256 is:

`9470d15e79dd4fe45f817b8545ba9f8e57ddaebff3b3a1031f21218647602068`

Audiveris is licensed under AGPL-3.0-or-later. The package license and corresponding source are available from <https://github.com/Audiveris/audiveris/tree/5.10.2>. homr 0.7.0 is also AGPL-3.0 and is installed from its pinned Python package. music21 is BSD-3-Clause and alphaTab is MPL-2.0. The image changes only the installed Audiveris launcher's maximum Java heap from 8 GiB to 2560 MiB so it remains below the container's 4 GiB limit; the pinned Audiveris package and source are not rebuilt.

Before production release, the owner must record acceptance of the repository's OCR quality results and the AGPL review for both recognizers in this exact image, including private network interaction, notices, and corresponding-source delivery. The separate worker boundary does not itself settle license obligations.
