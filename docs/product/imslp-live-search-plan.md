# IMSLP live search and hand-off

Status: Implemented on feat/imslp-live-search; review pending.
Date: 2026-10-01
Mockup: [`../design/concepts/imslp-live-search/imslp-flow.html`](../design/concepts/imslp-live-search/imslp-flow.html)

## Outcome and context

Replace the local IMSLP work catalogue (a weekly crawl of ~250k works into
PostgreSQL) with live queries against IMSLP's own search API, and make
selecting a work take the user straight to that work's IMSLP page in a new
tab. Remove the catalogue tables, the background refresh job and its UI
states.

Why now: the crawler is failing in production. One refresh is roughly 250
sequential requests over 25 minutes; any single non-200 page (IMSLP's PHP
endpoint intermittently returns 502) aborts the whole run, discards the
partial generation, and retries from page 0 after a backoff of up to an
hour. Until a run completes, `active_generation` stays NULL and the search
box shows "unavailable". The logs fill with "IMSLP catalogue refresh failed".
Fixing the crawler (resume, per-page retry) keeps ~700 lines of code, a
background job and 250k rows for a substring match that is worse than the
search IMSLP already runs.

The intake boundary in `requirements.md` is unchanged: Noted stores an HTTPS
work link and lets the user choose and download the edition on IMSLP. There is
no edition list in Noted and no backend download proxy.

## Verified IMSLP facts (probed 2026-10-01)

All free, anonymous, no key. IMSLP is a stock MediaWiki, so `api.php` exists
even though only the worklist endpoint is documented on `IMSLP:API`.

| Endpoint | Result |
| --- | --- |
| `api.php?action=query&generator=search&gsrsearch=Debussy Clair de lune&gsrnamespace=0&gsrlimit=8&redirects=1&prop=info&inprop=url` | 200 in ~0.15 s. Redirects collapsed, `fullurl` returned as protocol-relative `//imslp.org/wiki/...`. Handles composer-first queries. IMSLP runs MediaWiki 1.18.1: `formatversion=2` is ignored, `query.pages` is an object keyed by page id **sorted by title**, with no `index`. The apparent "first hit" was alphabetical, not rank. |
| `list=search&srsearch=...` alongside `generator=search` | One HTTP request; `query.search` gives IMSLP's rank order, `query.redirects` maps ranked redirect titles onto the collapsed pages. Used for ranking. |
| `srwhat`/`gsrwhat` = `text` vs `title` | Both match whole words only (`satie gymnop` → nothing). `text` ranks exact titles low (`Debussy Clair de lune` puts the work 4th); `title` ranks well but misses nicknames not in the title (`beethoven* moonlight*` → 0, `bach* well* tempered*` → 0). |
| Prefix wildcard `*` in `title` mode | `satie* gymnop*` → 3 Gymnopédies first; `rachmaninoff* prelude* op.23*` → 10 Preludes, Op.23; `Debussy* Clair* de lune*` → Clair de lune (Debussy) in the top 2; `chopin* noct*` → Nocturnes. Prefixes under four characters match nothing with `*` (`deb*`, `noc*` → 0) but match as whole words without it (`chopin no*` → 5). |
| `api.php?action=opensearch&search=Debussy Clair` | 200 but empty. Prefix-only on title; fails composer-first queries. **Not used.** |
| `api.php?action=query&list=search&srsearch=...` | Works, but returns redirect pages as separate rows (`Clair de Lune (Debussy, Claude)` and `Clair de lune - piano (...)`). `generator=search` + `redirects=1` is cleaner. |
| Response headers | `cache-control: public, max-age=1200`. No CORS header, so the browser cannot call it directly; the Go API proxies. |
| `imslpscripts/API.ISCR.php?account=worklist...` | 200 in ~4 s, 314 KB per page. The crawler's endpoint. No longer needed. |
| `/images/.../file.pdf`, `Special:ImagefromIndex/<n>` | 302 to a JavaScript browser check, then disclaimer, then the 15 s wait (members skip it). Downloads stay in the user's browser. |
| `Special:ReverseLookup/<n>` | 302 to the work page for an IMSLP file number (e.g. `02733` → `Quasi_valse,_Op.47_(Scriabin,_Aleksandr)`). Used in the Shortcut follow-up. |

Work page titles follow `Work title (Last, First)`. The existing client parse
in `applyIMSLP()` (`prepare.component.ts`) already splits this into title and
composer; the server adopts the same rule.

## User flow

See the mockup for each frame. In summary:

1. **Source step → Find a score on IMSLP.** A single search field. Results
   appear as the user types (debounced). Each row shows work title and
   composer.
2. **Select a work.** One tap does three things in the same gesture: stores
   the work link on the draft, prefills title and composer with IMSLP
   provenance (existing `IMSLPAutoFill` rules; manually edited fields keep
   their value), and opens the work page in a new tab. The user chooses the
   edition and downloads on IMSLP, where the disclaimer and wait belong.
3. **Back in Noted.** The draft is still on the Source step with the chosen
   work shown and the work link kept. The user adds the downloaded PDF with
   the existing **Add downloaded PDF** button or by dropping the file onto the
   panel (new drop target). The paste-a-link field stays as a fallback.

Statuses the user can see: idle hint (type two characters), searching, results,
no matches, "IMSLP is slow right now" (upstream 5xx/timeout or breaker open),
"You're searching quickly" (per-user limit). None of them block the manual link
field or the upload button.

## Backend

### Endpoint

`GET /api/imslp/works?q=<2..100 chars>` (same path, same `IMSLPSearch`
shape, authenticated user). New status values: `ready | unavailable |
throttled`. `loading` disappears.

Server fetches

```
https://imslp.org/api.php?action=query&format=json&formatversion=2
  &list=search&srsearch=<terms>&srnamespace=0&srlimit=10&srwhat=title&srprop=
  &generator=search&gsrsearch=<terms>&gsrnamespace=0&gsrlimit=10&gsrwhat=title
  &redirects=1&prop=info&inprop=url
```

where `<terms>` is the query with prefix wildcards, and a zero-work title
result is retried once with `srwhat=text&gsrwhat=text` (as implemented; see
Implementation notes; the reviewed plan used `gsrwhat=text` only).

and maps each page to `{title, composer, url}`:

- `url`: `fullurl` with `https:` prefixed when protocol-relative; must pass
  the existing `validIMSLPWorkURL` (https, `imslp.org`, `/wiki/`, no query).
  Reuse `canonicalIMSLPWorkURL` for `?`/`#` in titles.
- `title`/`composer`: split on the trailing `(Last, First)` group. Pages with
  no such group are dropped (they are not work pages).
- Preserve IMSLP's rank order (`index` field with `formatversion=2`).

HTTP client: 5 s timeout, `CheckRedirect` refusing redirects (a 302 means we
hit the browser check, treat as unavailable), `io.LimitReader` 1 MiB,
descriptive `User-Agent` as today.

### Rate limiting, caching, backoff (server)

Keep it in-process; a single API replica is the deployment model and the
advisory lock goes away with the crawler. All numbers are config with defaults.

| Control | Default | Behaviour |
| --- | --- | --- |
| Per-user limiter | token bucket, 2 req/s, burst 4 | Exceeded → HTTP 429 with `Retry-After: 1`; client shows `throttled`. Keyed by user id, entries expire after 10 min idle. |
| Outbound limiter to IMSLP | 5 req/s, 4 concurrent | Shared across users. Waiting longer than 2 s → `unavailable` without calling IMSLP. |
| Query cache | LRU 500 entries, TTL 20 min | Key is the normalised query (trim, collapse whitespace, lower-case). TTL matches IMSLP's `max-age=1200`. Negative results cached 5 min. |
| Single-flight | per normalised query | Concurrent identical queries share one upstream call. |
| Circuit breaker | opens after 3 consecutive upstream failures (5xx, timeout, 302, bad JSON); half-open after 60 s | While open, return `unavailable` immediately. Log one line on open and one on close, not per request. |
| Upstream 429 | honour `Retry-After` up to 60 s | Open the breaker for that duration. |

No per-request logging at info level. A single `slog.Warn` when the breaker
opens is the only recurring log line, which fixes the current log noise.

### Removal

- Delete `RunIMSLPCatalog`, `refreshIMSLPCatalog`, `fetchIMSLPPage`,
  `runIMSLPCatalog`, `imslpRetryDelay`, `waitIMSLPCatalog`, the lock constant
  and the two catalogue error values from `internal/app/imslp.go`. Keep
  `IMSLPWork`, `IMSLPSearch`, `validIMSLPWorkURL`, `canonicalIMSLPWorkURL`.
- Remove `go service.RunIMSLPCatalog(ctx)` from `cmd/api/main.go:45`.
- Delete catalogue tests in `internal/app/imslp_test.go` (retry schedule,
  snapshot integration test); replace with tests below.
- New migration `000007_drop_imslp_catalog`: `up` drops
  `imslp_catalog_works` and `imslp_catalog_state`; `down` recreates them with
  the exact DDL from `000006` (production has already applied 000006, so it is
  not edited).
- `SearchIMSLP` no longer takes `s.pool`; the service holds an `imslpSearcher`
  with the client, cache, limiter and breaker, injected so tests can point it
  at `httptest.Server`.

## Frontend

`web/src/app/features/prepare/prepare.component.{ts,html,spec.ts}` and
`core/api.service.ts`.

- Replace the submit-only form with search-as-you-type: `(input)` → debounce
  **350 ms** → search. Enter searches immediately and cancels the pending
  timer. Minimum 2 characters; below that, clear results and show the idle
  hint without a request.
- Skip the request when the trimmed query equals the last query sent.
- Keep the request counter so stale responses are ignored; also abort the
  in-flight `HttpClient` call via `takeUntil`/unsubscribe when a newer query
  starts.
- Small in-memory cache for the session (Map, 20 entries) so backspacing to a
  previous query is instant and sends nothing.
- `selectIMSLPWork(work)`: existing prefill/link behaviour, then
  `window.open(work.url, '_blank', 'noopener,noreferrer')` inside the click
  handler (user gesture, so no popup blocking), then `persist()`. Rename the
  button to **Open on IMSLP**; show a one-line note that edition choice and
  download happen there.
- The selected work stays visible above the results ("Chosen work: …") with
  a quiet **Change** action that returns focus to the search field.
- Status copy: `throttled` → "You're searching quickly. Results will catch
  up in a moment." (the same query is retried after 1 s). `unavailable` →
  "IMSLP is slow right now. Paste a work link or add a downloaded PDF, or press
  Enter to try again." (the same query is retried once, quietly, after 30 s if
  it is unchanged and the panel is still open). Neither hides the link field or
  upload button. Leaving the panel or the Source step cancels pending retries.
- Drop target: the IMSLP panel accepts a dropped PDF (`dragover`/`drop`) and
  routes it through the same path as the file input. Desktop only in
  practice; harmless on touch.
- Remove the `loading` status branch and the "Searching cached works…" copy.
- Honour `prefers-reduced-motion`; results replace in place, no animation.

`models.ts`: `IMSLPSearch.status` becomes `'ready' | 'unavailable' | 'throttled'`.

## Getting the downloaded PDF back into Noted

The wait, disclaimer and download are IMSLP's and stay in the browser. Noted
gets the file three ways:

1. **Add downloaded PDF** (exists). On iPad this opens Files; Safari downloads
   land in Downloads. On desktop it is the normal file picker.
2. **Drop onto the draft** (this plan). Desktop: drag from the Downloads
   shelf onto the IMSLP panel.
3. **Send to Noted shortcut** (follow-up, now implemented: see
   [`send-to-noted-shortcut-plan.md`](send-to-noted-shortcut-plan.md) and the
   recipe in [`send-to-noted-shortcut.md`](send-to-noted-shortcut.md)). iOS Shortcut
   receives the PDF from the Share sheet (Safari's PDF viewer or Files) and
   POSTs it with a per-user bearer token to a new endpoint that creates a new
   draft, prefilled from the work named by the IMSLP file number in the
   filename (`IMSLP02733-...pdf` → `Special:ReverseLookup/02733`). It never
   fills an existing draft (amended 2026-10-01, see
   [`send-to-noted-simplifications-plan.md`](send-to-noted-simplifications-plan.md)). Needs: per-user token issue/revoke UI (Noted is
   multi-user, so learnd's single shared token does not transfer), a
   token-scoped import endpoint, the ReverseLookup resolver with the same
   limiter/breaker as search. The Source step's "Waiting for your PDF" state
   does not mention it, since it would start a different draft.

Members of IMSLP skip the 15 s wait; that is a user choice, not a Noted
feature.

## Tests

Go (`internal/app`):

- Parse `generator=search` JSON into works: title/composer split, redirect
  collapse, protocol-relative URL, dropped non-work page, `?` in title.
- Upstream 5xx / timeout / 302 / malformed → `unavailable`; three in a row open
  the breaker; next call returns `unavailable` without hitting the fake server;
  after 60 s (fake clock) one probe call goes through.
- Upstream 429 with `Retry-After` honoured.
- Cache hit sends no second request; TTL expiry sends one.
- Per-user limiter returns the sentinel that the handler maps to 429.
- Single-flight: two concurrent identical queries → one upstream request.

Go (`internal/httpapi`): existing `TestIMSLPWorkSearchRequiresValidQueryAndReturnsWork`
plus a 429 mapping test. Fake backend updated.

Angular (`prepare.component.spec.ts`, `fakeAsync`):

- Typing below two characters sends nothing.
- Typing "Pre", "Prel", "Prelu" within 350 ms sends one request for "Prelu".
- Enter sends immediately.
- Stale response after a newer query is ignored.
- Selecting a work prefills, stores the link, calls `window.open` with the
  work URL, and persists; manually edited title is kept (existing test).
- `throttled` and `unavailable` statuses show their copy and keep the link
  field and upload button enabled.

Migration verification: apply `000007` up and down against a local database
with 000006 applied; `make test`, `make lint`, `make build`; the integration
suite.

## Docs to update

- `docs/product/requirements.md`: the assisted IMSLP paragraph gains "work
  search queries IMSLP directly; no local catalogue".
- `docs/product/score-intake-improvements-plan.md`: note the catalogue was
  removed and link here.
- `AGENTS.md` boundaries line already says "assisted IMSLP links"; add
  "live IMSLP work search" and keep "direct IMSLP download automation"
  deferred.
- `README.md` if it lists the background jobs.

## Out of scope

Edition lists in Noted, server-side PDF download, the Shortcut endpoint and
token UI (follow-up issue), any change to the Pages or Details steps.

## Decisions to confirm in review

1. Selecting a work opens the IMSLP tab immediately (recommended) rather than
   requiring a second **Open on IMSLP** tap. The button stays for re-opening.
2. Ten results, no "show more". IMSLP ranks well enough that the right work is
   in the first few for title-plus-composer queries.
3. The drop target is added now (small) rather than with the Shortcut work.
4. Defaults above for debounce (350 ms), per-user limit (2/s burst 4), cache
   TTL (20 min) and breaker (3 failures, 60 s).
5. After the downloaded PDF uploads, the draft stays on the Source step with
   **Continue** now enabled (today's behaviour). No auto-advance to Pages.

Review outcome (2026-10-01): all five confirmed as written. Implementation may
proceed on a branch from `main`.

## Implementation notes (2026-10-01)

- IMSLP runs MediaWiki 1.18.1. It ignores `formatversion=2`: `query.pages` is
  an object keyed by page id, sorted by title, with no `index` field. The
  earlier "first hit" probe was that title order, not IMSLP's rank. The request
  therefore also asks for `list=search` with the same terms (one HTTP request,
  two searches on IMSLP's side) and ranks the generator pages by it, mapping
  ranked redirect titles through `query.redirects`. The parser still accepts
  the `formatversion=2` array shape if IMSLP upgrades.
- Search runs in title mode (`srwhat=title`, `gsrwhat=title`) on a rewritten
  query: split on whitespace, MySQL boolean operators (`" * + ~ < > ( )` and a
  leading `-`) removed, and `*` appended to every token of four or more
  characters; shorter tokens stay whole words. This replaces the planned
  `gsrwhat=text`, which only matched whole words and ranked exact titles low.
- When title mode finds no works, one further request runs in text mode with
  the same terms, and the final result is cached under the same key. Both
  requests pass the outbound limiter and the breaker, so an empty title result
  costs two upstream requests.
- Known limitation: nicknames that are not in the page title ("Moonlight",
  "Well-Tempered") depend on the text fallback, whose ranking is weaker.
- Known limitation: works whose composer field is a single name, such as
  "Greensleeves (Anonymous)", are dropped by the "(Last, First)" rule.
- A downloaded file's IMSLP number cannot be matched to a work without a
  ReverseLookup call, and browsers hide file names until drop. The drop target
  shows "Release to add" while dragging; after the drop it shows the filename and
  an informational line comparing the filename with the chosen composer.
