# Send to Noted: template file and no draft matching

Status: Implemented on feat/send-to-noted-template; review pending.
Date: 2026-10-01
Builds on: [`send-to-noted-shortcut-plan.md`](send-to-noted-shortcut-plan.md)

## Outcome and context

Two corrections after the first real use on the iPad.

1. **The shared iCloud link contains the token.** A Shortcut's iCloud link is
   a snapshot of its actions, including the Text action holding the user's
   token. Publishing that link, or storing it in the stack as
   `SHORTCUT_INSTALL_URL`, hands the token to anyone who installs it. The link
   must not exist. Instead, Noted serves a **signed Shortcut template file**
   with the placeholder token; the person installing it is asked for their
   own token on import. No iCloud link and no secret in it. Replacing the
   template is a normal UI commit and deploy; nothing in the swarm stack
   changes.
2. **Attaching to a waiting draft is a flow nobody uses.** Starting in Noted
   means using the in-app IMSLP search, which already stores the link and
   prefills; the download then comes in through *Add downloaded PDF* on the
   same panel. Send to Noted is for the other direction: already on IMSLP in
   Safari. So the Shortcut always creates a new draft. The matching logic,
   its retry, and the "attach to the chosen work" wording go.

What stays: the per-user token and its Account dialog lifecycle, the
bearer-only import route, ReverseLookup prefill of title/composer for IMSLP
downloads, the Shortcut's own on-device download when Safari shares a link.

## 1. Shortcut template served by Noted

### Facts

- Since iOS 15, a `.shortcut` file imports only when signed. `shortcuts sign
  --mode anyone --input X.shortcut --output X-signed.shortcut` on macOS
  signs it for any installer. Opening a signed file from Safari or Files
  opens Shortcuts' Add Shortcut screen, which runs the import questions.
- Import questions prompt for values on install; the template holds
  `paste-your-token-here` and the default Noted address.
- The template contains no secret: it is safe to commit and to serve to
  anyone who can load the UI.

### Changes

- `web/public/send-to-noted.shortcut` (signed, committed, binary). Served as
  `/send-to-noted.shortcut` with `Content-Type:
  application/x-shortcut` (`nginx` MIME entry in the UI container config, or
  whatever the UI image uses) and `Content-Disposition: attachment;
  filename="Send to Noted.shortcut"`.
- Remove `SHORTCUT_INSTALL_URL` from config, `README.md`, `.env.example`,
  the API's `createShortcutToken` response (`installUrl` goes), and from
  `home_swarm/noted-stack.yml` (separate PR there).
- Account dialog, created state, step 1 becomes **Get the Shortcut** linking
  to `/send-to-noted.shortcut` (download attribute, opens in Shortcuts).
  Steps 2–3 unchanged. The "link will be added here" placeholder branch is
  deleted.
- Active state gains a quiet **Get the Shortcut again** link for a second
  device, with the note "You'll need your token; if you don't have it, tap
  Replace."
- The template is produced from the maintainer's own Shortcut by: duplicate
  it in Shortcuts, set the token Text to `paste-your-token-here`, let it sync
  to the Mac, export it there (File → Export, or `shortcuts` CLI where it
  offers export), sign with `--mode anyone`, and commit. Documented in
  `send-to-noted-shortcut.md` with a checklist; the implementer cannot do
  this step, so the dialog must handle a 404 on the file gracefully (the link
  is still shown; nothing breaks) until the file is committed.
- Safety: the recipe says plainly never to share the personal copy by iCloud
  link, because the link carries the token.

### Import questions in the template

1. **Your Noted token** (required; the Text action with the placeholder).
2. **Noted address** (default `https://noted.bitofbytes.io`).
3. **Open Noted after sending** (default `Yes`).

## 2. Always a new draft

### Backend (`internal/app/shortcut.go`, `imports.go`)

- Delete `waitingDraft`, the two-attempt attach loop, and the empty-title
  prefill-on-attach added in `de3111ad`. `ShortcutImport` becomes: validate
  bytes → optional ReverseLookup → `createImport` with work prefill → attach
  → result.
- Response: drop `matched`. Keep `draftId`, `draftPath`, `title`,
  `composer`, `filename`, `headline`, `message`. `message` is always
  "New draft created." Log line becomes `shortcut import accepted user=…`
  with no `matched` field.
- Tests: remove the matched cases and the prefill-on-attach case; keep the
  decision tree for IMSLP-name → prefilled draft, non-IMSLP → filename title,
  failed lookup → filename title.

### Frontend

- Prepare, IMSLP panel waiting text returns to "Waiting for your PDF. Drop it
  here, or use Add downloaded PDF." (no Send to Noted mention: it would start
  a different draft, which is confusing on this screen).
- Nothing else in Prepare changes; a draft opened from the Shortcut's link
  still lands on Pages.

### Docs

- `send-to-noted-shortcut-plan.md`: add an "Amended 2026-10-01" note at the
  top pointing here; strike the matching and iCloud-link paragraphs.
- `send-to-noted-shortcut.md`: template install steps replace the iCloud
  publishing section; remove "Added to the waiting draft" from the
  notification table; add the signing checklist.
- `requirements.md`, `AGENTS.md`: one-line updates ("Send to Noted creates a
  new draft from a shared PDF").
- Mockup `send-to-noted.html`: step 1 copy and the server decision tree lose
  the matching branch.

## Tests

- Go: `ShortcutImport` never queries `import_drafts` for a match (fake pool
  or integration assertion that an existing open draft for the same work is
  left untouched and a second draft is created); response has no `matched`.
- Angular: created state renders the **Get the Shortcut** link to
  `/send-to-noted.shortcut`; active state renders **Get the Shortcut again**;
  no `installUrl` handling remains.
- UI container: `curl -I /send-to-noted.shortcut` returns 200 with the right
  content type once the file is committed; before that, the dialog test only
  checks the href.

## Out of scope

Editable settings in the app (no longer needed once the link is a static
file), server-side download of the PDF (still in the browser/Shortcut),
multiple tokens.

## Decisions to confirm

1. Template served from the UI as a static signed file, no iCloud link, no
   `SHORTCUT_INSTALL_URL`.
2. Matching removed entirely rather than kept behind a toggle.
3. The Prepare panel no longer mentions Send to Noted.
4. "Get the Shortcut again" stays in the active state for a second device.

## Implementation notes (for review)

- **Content type.** The template is served as `application/octet-stream`,
  not `application/x-shortcut`: `.shortcut` has no registered MIME type and
  iOS goes by the extension. The `location = /send-to-noted.shortcut` block
  in `Docker/ui/nginx.conf` repeats `X-Content-Type-Options` and
  `Referrer-Policy`, because an `add_header` in a location replaces the
  server-level ones. `make test-ui-container-mime` checks the type, the
  `Content-Disposition`, both security headers and the bytes.
- **The template was committed before the code**, so the dialog needs no
  404 handling; its spec checks only the `href` and `download` attribute.
- **Draft limit.** With no waiting draft to fill, an import at 20 open drafts
  is always refused (429), IMSLP download or not.
- `home_swarm/noted-stack.yml` still needs `SHORTCUT_INSTALL_URL` removed
  (separate PR there). The API ignores the variable now, so the order of the
  two deploys does not matter.
