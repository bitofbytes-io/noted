# IMSLP membership and import API

Status: Wayfinder research finding

Checked: 2026-09-22

Question: Does any current IMSLP paid membership tier provide an official API
or supported third-party integration for score-file or edition search,
previews, or direct PDF downloads? If not, which member benefits change the
browser handoff that Noted should expect?

## Answer

No current published IMSLP membership offers a supported third-party import
API. IMSLP's individual standard and special subscriptions change the
human-facing download experience: members have no download wait and can access
new uploads immediately. The special subscription also adds optional composer
sponsorship recognition. IMSLP's institutional IP subscription removes ads and
the website download wait for users in the subscribed range. None of these
membership descriptions offers API credentials, OAuth access, score-file or
edition search, preview access, or programmatic PDF download.

This is a conclusion from the complete benefits IMSLP currently publishes for
its paid plans, read together with its current API documentation. It should be
rechecked if IMSLP publishes a developer program or a file-level API later.

For Noted, membership therefore shortens the browser handoff but does not
eliminate it. A member still finds the work, chooses a score file on IMSLP,
passes any applicable rights or regional disclaimer, and downloads the file in
the browser before selecting that local PDF in Noted. A non-member follows the
same route with any applicable wait. Noted must not ask for IMSLP credentials,
automate a member session, or treat membership as permission to fetch a PDF.

## Public catalogue API is separate from membership

IMSLP documents a public catalogue API with only two resources: paginated
lists of people and of works. The documented parameters control the list type,
start offset, sort, and response format; there is no documented membership
authentication or score-file, edition, preview, or PDF-download operation.
([IMSLP API](https://imslp.org/wiki/IMSLP:API))

A live unauthenticated request to the documented work-list endpoint returned
HTTP 200. Its work records contained a display identifier, composer category,
composer, work title, internal catalogue number, MediaWiki page ID, and work
page permalink. They did not contain file entries, editor or publisher edition
data, previews, or PDF URLs.
([current work-list response](https://imslp.org/imslpscripts/API.ISCR.php?account=worklist/disclaimer=accepted/sort=id/type=2/start=0/retformat=json))

That API can support work-level discovery regardless of membership. It cannot
support a member-only direct-import path or an in-app edition/file picker.

IMSLP also retains documentation explicitly titled `OldAPI`. Its two listed
functions either look up an already-known file name to obtain an IMSLP index
and copyright-block status, or return genre tags. It does not search score
files or editions, expose previews or PDFs, or add a membership authentication
scheme. The old lookup therefore does not provide the missing import contract.
([IMSLP OldAPI](https://imslp.org/wiki/IMSLP:OldAPI))

## What paid membership changes

### Individual standard and special subscriptions

IMSLP lists these relevant benefits for both standard and special
subscriptions:

- no waiting for downloads;
- immediate access to new uploads; and
- full streaming access to IMSLP's commercial recording library.

The special plan also offers optional recognition as a sponsor of a composer.
No plan lists an API, integration entitlement, developer key, or
programmatic score access.
([subscriptions](https://imslp.org/wiki/IMSLP:Subscriptions))

IMSLP's membership Q&A reinforces the boundary: membership is not required to
download any file or use IMSLP features, and its stated membership benefit is
removal of the download wait. It also notes that Creative Commons files and
files served by the unaffiliated European and Canadian regional servers do not
have a membership wait.
([membership Q&A](https://imslp.org/wiki/IMSLP:Membership_Q%26A))

### Institutional IP subscription

The IP-range plan for schools and organizations removes website ads and the
download waiting period for users in the subscribed address range. IMSLP
explicitly describes this as a website membership and says it does not include
Naxos Music Library access. It does not list integration or API access.
([IP subscriptions](https://imslp.org/wiki/IMSLP:IP_Subscriptions))

## What membership does not remove from the handoff

IMSLP's download instructions remain browser-centered: the user selects a file
description on a work page, may receive a regional disclaimer requiring an
acknowledgement, and opens or saves the PDF through the browser. Membership's
published benefits do not say that it removes file selection or rights
acknowledgement.
([download help](https://imslp.org/wiki/Help:Downloading_and_printing_pdf_files))

The work page, not the membership, is also where the useful edition clues live.
One work page may contain different editions, scans, arrangements, movements,
or parts. IMSLP's own submission guide says different editions, manuscripts,
scans, typesets, and arrangements all belong on the same work page, and it
describes uploader-supplied thumbnails or preview samples as optional assets.
Those are human-facing page features, not a membership API.
([score-submission guide](https://imslp.org/wiki/IMSLP:Score_submission_guide))

## Product boundary for Noted

Use the following contract unless IMSLP publishes a new supported integration:

1. Noted may use the public works list for bounded, cached title/composer
   discovery and then open the canonical IMSLP work page.
2. The user chooses and downloads the score file on IMSLP. Membership may make
   that step faster, but does not change its ownership or move it into Noted.
3. Noted preserves the unfinished Add piece draft and offers a clear action to
   select the downloaded PDF when the user returns.
4. Noted may retain the canonical work URL and user-confirmed provenance. Any
   extra edition details are optional clues, not proof of an exact match.
5. Noted does not collect IMSLP credentials, reuse authenticated cookies,
   bypass waits or disclaimers, scrape file listings, construct direct CDN
   links, proxy files, or claim a membership-only API exists.

In domain terms, an **IMSLP membership** is an entitlement affecting IMSLP's
human website experience. The **public catalogue API** is an unauthenticated
work-discovery endpoint. Neither is an **import integration**, which would
require a documented file-level contract and authentication or authorization
rules for third-party software.
