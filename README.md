# Noted

Noted is a personal piano library and practice desk. It keeps works, editions, PDF/MusicXML assets, measure-aware synthesized playback, and explicit practice history together in an Angular, Go, and PostgreSQL application.

Local development uses one clearly identified learner. Every learner-owned query is still scoped by user ID, and the API refuses to run development authentication outside development/test configuration. Production uses Google OAuth, an explicit email allowlist, opaque database-backed sessions, external secret files, and the API/UI container workflow. Crystal Swarm, Traefik, NAS PostgreSQL/NFS, and NAS-worker operations are maintained in the companion `home_swarm` repository.

## Run locally

Prerequisites:

- Go 1.25 or newer
- Node.js 22 and npm 10
- Docker with Compose v2
- Current desktop Chrome for the real-browser playback check

From a clean checkout:

```sh
make setup
make local
```

`make setup` creates the gitignored asset directories, copies `.env.example` to `.env` when needed, and installs pinned dependencies. `make local` starts PostgreSQL, applies migrations, inserts the rights-safe sample only on the first initialization, then runs the API and Angular development server together. Open <http://localhost:4200>. Stop the foreground command with Ctrl-C; PostgreSQL remains available so local data persists. Use `make db-down` when you want to stop it.

PDF-to-MusicXML conversion is an optional, heavyweight service. The lightweight local command path remains an Audiveris-only compatibility path. To enable it, install the pinned Audiveris release once before starting the app:

```sh
make omr-build
AUDIVERIS_COMMAND=scripts/run-audiveris-docker.sh make local
```

On Apple-silicon Macs this installs the native release under ignored `.local/tools`; elsewhere it builds the isolated Audiveris container. This path does not run homr, fusion, or the worker's alphaTab gate and does not produce a dual-engine quality report. The production-oriented private HTTP worker image contains the full pinned Audiveris + homr + music21 + alphaTab pipeline and is built separately with `make docker-build-omr`. The normal `make local` path deliberately downloads none of those heavyweight dependencies.

For separate terminals instead:

```sh
make db-up
make migrate
make seed
make revalidate-musicxml
make api-run
make web-start
```

The API is at <http://localhost:8080>; readiness is at <http://localhost:8080/api/ready>. The UI development server proxies `/api` to the API. Re-running `make seed` ensures the development learner exists; the sample is deliberately not recreated after it has been deleted. Run `make revalidate-musicxml` after introducing the playback-validation migration or whenever stored MusicXML needs to be checked again; the production image provides the same operation as `/app/noted-revalidate-musicxml`.

## Configuration and local data

Copy-safe defaults live in `.env.example`. Important values are:

- `DATABASE_URL`: local PostgreSQL connection string (Compose exposes port 5434).
- `ASSET_ROOT`: filesystem storage root, default `.local/noted-assets`.
- `MAX_UPLOAD_BYTES`: maximum accepted PDF or MusicXML size, default 25 MiB.
- `AUTH_MODE=development` and `DEV_USER_EMAIL`: local identity only.
- `AUTH_MODE=google`: production Google OAuth using `AUTH_GOOGLE_CLIENT_ID`,
  `AUTH_GOOGLE_CLIENT_SECRET`, `AUTH_GOOGLE_REDIRECT_URL`, and
  `AUTH_GOOGLE_ALLOWED_EMAILS`; secret values also support the documented `_FILE` form.
- `SESSION_TTL`: opaque database-backed production session lifetime, default `12h`.
- `ALLOWED_ORIGINS`: allowed browser origins for the API.
- `AUDIVERIS_COMMAND`: optional Audiveris-only local conversion runner. It is empty by default so recognition is inactive in the standard local runtime. Set it to `scripts/run-audiveris-docker.sh` after `make omr-build`.
- `OMR_BASE_URL`: private base URL for the full HTTP OMR worker. Configure it together with exactly one of `OMR_TOKEN` or `OMR_TOKEN_FILE`; it is mutually exclusive with `AUDIVERIS_COMMAND`. Never expose the worker through Traefik or to the browser.

Local catalog data, practice history, asset metadata, and recognition jobs live in the persistent
PostgreSQL Docker volume. Uploaded and generated score binaries live under `.local/noted-assets`.
Neither is in memory. Backups must include a PostgreSQL dump and the asset directory together. A
full local reset requires removing both the Compose volume and `.local/noted-assets` while the app
is stopped.

`.env`, PostgreSQL volume data, browser state, generated output, and `.local/` assets are ignored. The committed PDF and MusicXML under `testdata/fixtures/` and the synthetic clean/noisy/dense/multi-page OMR corpus under `testdata/omr/` are original project fixtures dedicated to CC0-1.0; see [testdata/README.md](testdata/README.md).

## Verify

```sh
make test       # PostgreSQL-backed Go tests plus Angular unit tests
make lint       # gofmt, go vet, Prettier check, and TypeScript check
make build      # Go and production Angular builds
make test-e2e   # isolated core flows in desktop Chrome and iPad-sized WebKit
make test-ui-container-mime # built-image worker MIME check for PDF.js and alphaTab
python3 -m unittest discover -s scripts/omr-eval/tests -v # OMR metric/harness tests
```

`make test-e2e` creates a dedicated temporary PostgreSQL database and asset root, then removes
both when Playwright exits. It never writes to the regular development learner data. Migration
apply/rollback/reapply coverage is included in `make test` and can be run alone with
`make test-migrations`. To repeat the browser suite visibly, run
`./scripts/with-test-database.sh headed-e2e ./scripts/run-playwright-headed.sh`.

Playwright installs its browser engines separately. If this machine has not run the E2E suite before, install the required WebKit engine once with `cd web && npx playwright install webkit`; desktop coverage uses the installed Chrome channel.

The [verification record](docs/implementation/verification.md) maps requirements to implementation/tests and records the exact final checks. The [browser score ADR](docs/decisions/0001-browser-score-rendering-and-playback.md) explains the PDF.js/alphaTab decision and browser constraints.

The OMR harness writes ignored JSON/Markdown results beneath `.local/omr-eval/`. A reference self-check (`python3 scripts/omr-eval/evaluate.py --include-reference-baseline`) validates the harness and alphaTab check only. The [recorded four-fixture benchmark](docs/implementation/omr-benchmark.md) compares Audiveris-only, homr-only, repaired, and fused outputs and finds an overall playability/event improvement with a documented dense-polyphony fidelity tradeoff. The [production-readiness record](docs/implementation/omr-production-readiness.md) captures the accepted NAS-native, cancellation, private-network, licensing, and production-application evidence for the private deployment.

## Build and deploy the production OMR worker

The full OMR worker runs on the AMD64 `bahamut` NAS, not on the Raspberry Pi
Crystal servers. Crystal runs the API/UI and submits jobs over the private
network. The worker contract, resource boundaries, and licensing requirements
are documented in [omr/README.md](omr/README.md).

The accepted production baseline is:

- release tag: `00656dc`;
- manifest digest: `sha256:c8bce4a5410abaea8551043acab782f0d4f4150fe5af790d152474eb3b143905`;
- image/config ID: `sha256:5de0a6634f55a935bb37e98409cf444b0b36bfdea2881d2cb4673c861ab817fb`;
- NAS image name: `127.0.0.1:9000/noted-omr:00656dc`; and
- production Compose file: `/volume1/docker/noted/compose.yaml` on `bahamut`.

### Rebuild and publish

Build the production-shaped image locally for AMD64 validation from the release
commit:

```sh
git checkout <release-commit>
make docker-build-omr
```

The Make target derives the seven-character Git SHA for the image tag and sets
the OCI version, revision, and source labels. An explicit tag may be used for a
non-release validation build:

```sh
IMAGE_TAG=<test-tag> VERSION=<test-tag> REVISION="$(git rev-parse HEAD)" \
  make docker-build-omr
```

Do not deploy a developer-machine build directly. Merge the reviewed
runtime-changing commit to `main`, or manually dispatch the GitHub Actions
workflow named **Publish OMR worker**. That workflow builds `linux/amd64`, tags
the image with the seven-character release SHA, and publishes it to
`registry.tail209cfc.ts.net/noted-omr`. Record the published manifest digest,
not only the mutable tag. From a machine logged in to the private registry:

```sh
docker buildx imagetools inspect \
  registry.tail209cfc.ts.net/noted-omr:<release-tag>
```

### Deploy on the NAS

Before deployment, preserve the currently accepted `tag@digest` as the rollback
value. In `/volume1/docker/noted/compose.yaml`, set the image for both
`noted-omr` and the secretless `omr-ingress` relay to the same immutable
artifact:

```yaml
image: 127.0.0.1:9000/noted-omr:<release-tag>@sha256:<manifest-digest>
```

Keep the existing runtime restrictions: UID 10001, read-only root filesystem,
dropped capabilities, `no-new-privileges`, 4 GiB/no-swap worker memory, 1 GiB
executable scratch tmpfs, two-CPU affinity, the internal no-egress worker
network, and the 128 MiB secretless host-network relay. The worker alone receives
`/run/secrets/noted_omr_token`. Keep the DSM firewall allow for TCP 8788 from
`192.168.10.0/24` above the explicit deny for every other source; do not publish
the worker through Traefik.

Apply the project through Synology Container Manager, or from an authorized NAS
shell with Synology's Docker binary:

```sh
cd /volume1/docker/noted
/usr/local/bin/docker compose pull noted-omr omr-ingress
/usr/local/bin/docker compose up -d --no-deps --force-recreate \
  noted-omr omr-ingress
```

Verify the deployment before removing the previous image:

```sh
/usr/local/bin/docker compose -f /volume1/docker/noted/compose.yaml ps
/usr/local/bin/docker inspect \
  --format '{{.Name}} image={{.Image}} health={{if .State.Health}}{{.State.Health.Status}}{{end}}' \
  noted-omr-noted-omr-1 noted-omr-omr-ingress-1
curl -fsS http://127.0.0.1:8788/readyz
```

Both containers must be up, the worker must become healthy, `/readyz` must
confirm the pinned engines and model checksums, and the resolved worker image ID
must match the published artifact. Then submit a rights-safe representative PDF
through the production Noted UI/API from Crystal. Confirm that the job succeeds,
the returned MusicXML loads in alphaTab, the source PDF is preserved, the result
is labeled `Unverified OCR`, a quality report is present, cancellation leaves no
job directory, and a non-Crystal client still cannot reach TCP 8788. Correctness
and the playability gate take priority over conversion time.

### Roll back and clean up images

To roll back, restore the prior `tag@digest` for both services, pull it, recreate
the two containers with the commands above, and repeat all readiness and
production conversion checks. Do not replace a digest pin with a tag-only image.

Synology may display a digest-pinned running image as `<none>` even though the
bytes are correct. Give those exact bytes their release name instead of
rebuilding them:

```sh
active_id=$(/usr/local/bin/docker inspect \
  --format '{{.Image}}' noted-omr-noted-omr-1)
test "$active_id" = 'sha256:<accepted-image-config-id>'
/usr/local/bin/docker image tag "$active_id" \
  127.0.0.1:9000/noted-omr:<release-tag>
```

Remove an old image only after `docker ps -a` proves that no container uses it,
`docker image inspect` proves that its ID differs from the active accepted ID,
and the replacement has passed the checks above. Remove only the explicit old
references with `docker image rm`; do not use Container Manager's broad
**Remove Unused Images** action or an unscoped Docker prune on the production
NAS. The worker and ingress relay intentionally share one image and its layers.

## Capabilities

- Home dashboard, Library search/filtering, work/edition/asset edit/replace/archive/delete management, Metronome, Practice, and Settings.
- Authenticated PDF/MusicXML upload, download, and streaming through opaque filesystem keys with content validation, checksums, provenance, and cleanup.
- Immersive PDF.js reading and alphaTab MusicXML playback with score zoom, a beat cursor, both-staff note highlighting, synthesized playback, BPM control, validated measure ranges, and looping.
- Explicit PDF-to-MusicXML conversion through a private worker pinned to Audiveris 5.10.2, homr 0.7.0, music21 10.3.0, and alphaTab 1.8.4. Shared preprocessing, per-engine repair, measure-level fusion/fallback, strict quality reports, and the final playability gate keep results separate and `Unverified OCR`; `unplayable_output` fails the job without importing a broken derived asset.
- A Web Audio-clock metronome with one-to-four-beat meters, three synthesized click profiles, and a shared scheduler for audio, beat dots, accent, and pendulum.
- A durable one-at-a-time practice timer with confirmed discard recovery, complete manual entries/corrections, deletion, and Monday-first summaries.
- Responsive cobalt/white interface exercised at a 1024×1366 portrait viewport.
- Production Google OAuth, database-backed sessions, `_FILE` secrets, API/UI containers, and commit-tagged deployment workflows for the Crystal Swarm.

An interactive notation-correction editor is not included; the worker does perform conservative automatic repair and always leaves the result unverified. Annotations, lessons, sharing, offline support, and performance assessment are also deferred. Production infrastructure provisioning and operations live in `home_swarm`; the exact AMD64 OMR digest is accepted for the recorded private `bahamut` topology after representative-score, NAS-resource, cancellation, Crystal-only network, and owner-license gates. Public or commercial distribution requires a fresh review under [ADR 0002](docs/decisions/0002-audiveris-ocr-pipeline.md).

## Design and architecture

- [Product requirements](docs/product/poc-requirements.md)
- [System design](docs/architecture/system-design.md)
- [Data model](docs/architecture/data-model.md)
- [API contract](docs/architecture/api-contract.md)
- [Visual direction](docs/design/visual-direction.md)
- [Implementation handoff](docs/implementation/handoff.md)
- [OMR benchmark record](docs/implementation/omr-benchmark.md)
- [OMR production-readiness record](docs/implementation/omr-production-readiness.md)
- [OMR worker contract](omr/README.md)
- [Dual-engine OMR decision](docs/decisions/0002-audiveris-ocr-pipeline.md)
- [Production deployment architecture](docs/architecture/deployment.md)
