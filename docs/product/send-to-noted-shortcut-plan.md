# Send to Noted: iOS Shortcut intake

Status: Approved 2026-10-01 (one token per user, Account dialog off the masthead). Implementation starting.
Date: 2026-10-01
Mockup: [`../design/concepts/send-to-noted/send-to-noted.html`](../design/concepts/send-to-noted/send-to-noted.html)
Builds on: [`imslp-live-search-plan.md`](imslp-live-search-plan.md)

## Outcome and context

After the live-search work, the IMSLP flow is: search in Noted → tap the work
(link stored, title/composer prefilled, IMSLP opens in a new tab) → choose the
edition and download on IMSLP → come back to Noted → **Add downloaded PDF** →
Files → Downloads → pick the file. The last three steps are the remaining
friction, and on the iPad they are the slowest part.

This plan removes them. From Safari's PDF viewer (or Files), the user taps
Share → **Send to Noted**. An iOS Shortcut posts the PDF to Noted with a
per-user bearer token. Noted attaches it to the draft that is already waiting
for that work, or creates a new prefilled draft when nothing is waiting. The
user gets a notification naming the piece and can open the draft directly.

Boundaries that do not change: Noted never downloads from IMSLP; the file
comes from the user's browser. One PDF per piece. Drafts expire after seven
idle days. Everything the token can do is limited to creating or filling a
draft for its own user.

## Verified facts

- IMSLP downloads are named `IMSLP<file number>-<rest>.pdf`
  (e.g. `IMSLP01240-Debussy_-_Suite_bergamasque_-_3_Clair_de_lune.pdf`).
- `https://imslp.org/wiki/Special:ReverseLookup/<number>` answers
  `302 Location: //imslp.org/wiki/<Work_title_(Last,_First)>#IMSLP<number>`
  (checked 2026-10-01 with `02733` → `Quasi_valse,_Op.47_(Scriabin,_Aleksandr)`).
  Leading zeros are accepted.
- Noted already has the token pattern this needs: `user_sessions.token_hash`
  (SHA-256, 32 bytes), `randomToken()` and `tokenHash()` in
  `internal/auth/service.go`, and `authenticatedUser` in
  `internal/httpapi/auth_handlers.go` that puts `app.User` on the context.
- There is no profile or settings page. Account UI is the masthead in
  `web/src/app/features/library/library.component.html` (display name, Sign
  out) backed by `GET/DELETE /api/session`.
- iOS Shortcuts support **import questions**: a shared Shortcut can ask for a
  value (the token) when installed and store it in the user's copy.
- Shortcuts' *Get Contents of URL* can POST multipart form data with a file
  from the Share sheet and custom headers, and read JSON from the response.

## User flow

See the mockup for each frame.

### Setting up (once per user)

1. In the library masthead the display name becomes a quiet button that opens
   an **Account** dialog (square, `--paper-raised`, `--line-strong` border, like
   the details dialog). It shows name, email, **Sign out**, and a **Send to
   Noted** section.
2. With no token: one secondary button, **Set up on this iPad**.
3. Tapping it creates the token. The dialog now shows, once:
   - the token in a monospace box with a **Copy** button;
   - an **Install the Shortcut** link (the published iCloud link, from config);
   - three steps: Install → when Shortcuts asks, paste the token → Done.
   - "You won't see this token again. If you lose it, tap Replace."
4. Closing the dialog discards the plaintext. Reopening shows the active state:
   "Set up on 1 Oct 2026 · last used today", with **Replace** and **Turn off**.

### Sharing a score

1. On IMSLP in Safari the download opens in the PDF viewer. Share → **Send to
   Noted**. (Also from Files, for any PDF.)
2. The Shortcut posts the file. Noted answers within the upload time with
   `{draftId, draftPath, title, composer, matched}`.
3. The Shortcut shows a notification: "Clair de lune — Debussy, Claude. Added to
   the waiting draft." or "… New draft created." A Shortcut toggle
   (`Open Noted after sending`, default on) then opens
   `https://<noted host>/prepare/<draftId>` in Safari, which resumes the draft on
   the Source step with the PDF attached and **Continue** enabled.
4. Failure notifications are specific: "This shortcut was turned off. Set it
   up again in Noted." (401), "Only PDF files can be sent." (415), "File is
   larger than Noted allows." (413), "Noted isn't reachable." (network).

## Backend

### Schema: migration `000008_shortcut_tokens`

```sql
CREATE TABLE shortcut_tokens (
    user_id      UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    token_hash   BYTEA NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ
);
```

One row per user enforces one token per user. Replace = delete + insert in one
transaction. Turn off = delete. `down` drops the table.

### Token endpoints (session cookie auth, under `authenticatedUser`)

| Route | Behaviour |
| --- | --- |
| `GET /api/account/shortcut-token` | `{active: bool, createdAt, lastUsedAt}`; never the token. |
| `POST /api/account/shortcut-token` | Creates or replaces. Returns `{token, createdAt, installUrl}` once. `installUrl` comes from config `SHORTCUT_INSTALL_URL` (empty allowed; the UI then hides the link and says the Shortcut link will follow). |
| `DELETE /api/account/shortcut-token` | Removes it. 204. |

Token: `randomToken()` (32 bytes, base64url, 43 chars). Store `tokenHash`.
Compare with `subtle.ConstantTimeCompare` on the hash bytes.

### Bearer middleware (one route only)

`shortcutUser`: reads `Authorization: Bearer <token>`, hashes, looks up
`shortcut_tokens` joined to `users`, puts `app.User` on the context with the
same `userContextKey{}` so `currentUser(r)` works, updates `last_used_at`
(fire-and-forget, best effort), and answers 401 `{"error":"shortcut token is
not valid"}` otherwise. No cookie fallback: this middleware is mounted only on
`POST /api/shortcut/import`. The route must not be inside the
`authenticatedUser` group. Development auth mode still requires the token (no
auto user) so the behaviour is identical in both modes.

### `POST /api/shortcut/import`

Multipart with one `file` part. Same `MaxBytesReader`, size and PDF checks as
`importUpload` (`internal/httpapi/import_handlers.go`); reuse
`hardLimitReader`. Then:

1. `number := regexp ^IMSLP0*(\d{1,8})-` on the filename. If absent → step 4
   with no work.
2. Resolve: `GET https://imslp.org/wiki/Special:ReverseLookup/<number>` with
   `CheckRedirect` refusing to follow, 5 s timeout, the live-search
   User-Agent. A 302 whose `Location` is a `/wiki/` path becomes
   `https://imslp.org/wiki/<path>` with the `#IMSLP…` fragment removed, then
   `canonicalIMSLPWorkURL`. Anything else → no work (never an error for the
   user). Cache number→URL for 24 h (LRU 500) and share the outbound limiter
   and breaker from `imslpSearcher` (extend it with `resolveFile(number)`;
   keep the search path untouched).
3. Match: the user's newest draft `WHERE user_id=$1 AND NOT finalized AND
   piece_id IS NULL AND metadata->>'sourceUrl' = $2` that has **no sources
   yet**. Attach the PDF through `UploadImportSource` with that draft's
   current revision. `matched: true`.
4. Otherwise create a draft (`CreateImport{SourceURL: workURL}`), prefill
   `Metadata.Title`/`Composer` from the `(Last, First)` parse and set
   `IMSLPAutoFill.Title/Composer` to the same values (server-side equivalent of
   the client's `prefillIMSLPField`; add a small `imslpWorkName(title)` helper
   in `internal/app`, shared with `parseIMSLPSearch`). No work → title from the
   filename stem (same rule the Prepare screen uses for filename prefill), no
   provenance. Then upload. `matched: false`.
5. Respond 201 `{draftId, draftPath: "/prepare/<id>", title, composer,
   matched, filename}`.

Errors: 401 token; 413 size; 415 not a PDF (`application/pdf` or `.pdf`,
same check as the drop target); 429 if the user has 20 active drafts
(`ErrImportLimit`); 503 if the asset store fails. JSON `{"error": "..."}`
for all, because the Shortcut shows the message.

Rate limit: 10 shortcut imports per user per minute (token bucket like the
search one). Log one info line per accepted import with user id and whether
it matched; never the filename.

### Removal / cleanup interplay

`RunImportCleanup` already expires drafts; nothing new. Deleting a user
cascades the token.

## Frontend

`library.component.{ts,html,scss,spec.ts}`, `core/api.service.ts`,
`core/models.ts`.

- Masthead: display name becomes `<button class="btn-quiet account-button">`
  with `aria-haspopup="dialog"`; opens `<dialog #account class="account">`.
  Keep **Sign out** inside the dialog (remove it from the masthead) so the
  masthead has one account control. Dev mode shows the Dev chip and no Sign
  out, as today.
- Dialog states: `none` → `created` (plaintext visible, Copy, Install link,
  steps) → `active` (dates, Replace, Turn off). Replace asks inline "Replace
  the token? The current Shortcut stops working." with a confirm button (no
  `confirm()`). Turn off likewise.
- Copy uses `navigator.clipboard.writeText` with a fallback that selects the
  text. The token box uses tabular monospace, wraps, 43 chars.
- `last used` renders "today", "yesterday", or a date; "never" when null.
- Model: `ShortcutToken {active, createdAt, lastUsedAt}` and
  `ShortcutTokenCreated {token, createdAt, installUrl}`.
- Prepare screen: when a draft opened at `/prepare/<id>` already has a source
  and the IMSLP panel state exists, nothing new is required; `imslpAdded` is a
  per-visit signal, so the panel shows the chosen work with **Continue**
  enabled. Verify that `step` resolves to `source` when pages exist but the
  user arrives by link (today `step.set(d.manifest.pages.length ? 'pages' :
  'source')` sends them to Pages, which is acceptable and arguably better:
  confirm and keep).

## The Shortcut

Documented in `docs/product/send-to-noted-shortcut.md` (new, user-facing,
written by the implementer) with the exact action list so it can be rebuilt:

1. *Receive* **PDFs** *from* **Share Sheet** (and Quick Actions off).
2. Import question **Noted token** (text) → stored in a *Text* action.
3. *Text*: `https://noted.bitofbytes.io` (base URL; second import question
   with this default so a local instance can be used).
4. *Repeat with each* item in Shortcut Input:
   *Get Contents of URL*: POST `<base>/api/shortcut/import`, Headers
   `Authorization: Bearer <token>`, Request Body **Form**, field `file` =
   Repeat Item.
   *Get Dictionary Value* `title`, `composer`, `matched`, `draftPath`, `error`.
   *If* `error` has any value → *Show Notification* "Noted: <error>".
   *Otherwise* → *Show Notification* "<title> — <composer>. <Added to the
   waiting draft | New draft created>." and, if the **Open Noted after
   sending** toggle (a third import question, default Yes) → *Open URLs*
   `<base><draftPath>`.
5. Publish via iCloud link; put the link in `SHORTCUT_INSTALL_URL`.

The implementer cannot build or publish the Shortcut; it writes the recipe
and the API so Daniel can assemble it on the iPad in a few minutes. The
Account dialog works without the install link.

## Tests

Go:

- Token lifecycle: create → get shows active, never the token → replace
  changes the hash and invalidates the old bearer → delete → 401.
- Bearer middleware: missing header, malformed, unknown, revoked → 401;
  valid → `currentUser` is the owner; `last_used_at` updated.
- Route isolation: the bearer token cannot call `GET /api/imports/` (401).
- ReverseLookup resolver against `httptest.Server`: 302 to a work path →
  canonical URL; 302 elsewhere, 200, 404, timeout → no work; cache hit sends
  nothing; shares the breaker (open breaker → no work, no request).
- Import endpoint: IMSLP filename with waiting draft → attached, `matched`;
  with no waiting draft → new prefilled draft with provenance; draft with a
  source already → not matched, new draft; non-IMSLP filename → draft titled
  from the stem; non-PDF → 415; oversize → 413; 20 active drafts → 429.
- Integration: migration 000008 up/down; the full import against the real
  asset store path.

Angular (`library.component.spec.ts`):

- Masthead button opens the dialog; three states render the right controls.
- Create shows the token once and the install link when present; closing
  and reopening shows the active state without the token.
- Replace and Turn off need the inline confirm; API calls and resulting
  state.
- Copy calls the clipboard and falls back on rejection.

## Docs to update

- `requirements.md`: add the Shortcut intake to the assisted-IMSLP paragraph
  and list the bearer-token scope under Safety.
- `AGENTS.md`: boundaries line gains "Send to Noted shortcut intake (per-user
  bearer token, one route)".
- `README.md`: `SHORTCUT_INSTALL_URL` in the configuration table.
- `imslp-live-search-plan.md`: point the follow-up paragraph here.

## Out of scope

Multiple tokens per user, token names/devices, Web Share Target (unsupported
on iOS Safari), server-side IMSLP download, Android.

## Decisions (confirmed 2026-10-01)

1. One token per user; Replace rather than Add.
2. The Account dialog hangs off the masthead display name; Sign out moves
   inside it.
3. Any PDF is accepted, not only IMSLP downloads.
4. The Shortcut opens the draft after sending by default (toggle at install).
5. Matching requires an exact work-link match on a draft with no PDF yet.
