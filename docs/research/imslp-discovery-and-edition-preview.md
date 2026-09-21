# IMSLP discovery and edition-preview options

Status: Wayfinder research finding

Checked: 2026-09-20

Question: What official, rights-permitted IMSLP capabilities can help a Noted
user discover a work, inspect an edition candidate, and continue through
IMSLP's download flow without claiming an exact match to a commercial working
copy?

## Decision

Keep IMSLP as an **assisted discovery and browser handoff**, not a direct-import
service.

Noted can safely help a user reach the right IMSLP work page and can explain
which visible details distinguish one score file from another. IMSLP's
documented catalogue API can support work-level discovery, subject to a small
technical proof and considerate caching. It does not provide a documented
file/edition search or download API. Noted should therefore leave selection,
rights acknowledgement, any wait or bot check, previewing, and download on
IMSLP; the user then uploads the downloaded PDF to Noted.

Metadata can narrow the choice, but it cannot prove that an IMSLP score is the
same edition, printing, layout, fingering, or marked-up copy used in a lesson.
Noted should describe it as an **edition candidate** until the user visually
confirms it. “Same working copy” remains reserved for pages captured from the
user's book or for a match the user has personally verified.

## Domain distinctions

- An **IMSLP work page** represents a musical work and can contain many scores,
  parts, arrangements, movements, scans, and typesets.
- An **IMSLP score file** is one downloadable file entry. Its IMSLP file index
  identifies the file, but the file is not necessarily a complete work or a
  distinct edition.
- An **edition candidate** is a score file considered together with its work-page
  section and displayed editor, arranger, publisher, series, edition/catalogue
  number, plate number, date, page count, copyright status, and notes.
- The user's **working copy** is the physical book used in lessons, including
  its page layout and personal or teacher markings.

Calling all four of these things an “edition” would hide important differences.
For example, two score files may be scan and filtered variants of the same
edition, while one file may contain only a movement or part.

## What the official API supports

IMSLP documents two catalogue endpoints: one paginated list of people and one
paginated list of works. The documented control is the `start` offset, with
`pretty`, `json`, `php`, or `wddx` as response formats. The documentation does
not describe a score-file, edition, preview, search, or download endpoint.
([IMSLP API](https://imslp.org/wiki/IMSLP:API))

A live JSON response from the documented work-list endpoint returned 1,000
work records plus pagination metadata. Each record contained a display ID,
composer category, composer, work title, internal work catalogue number,
MediaWiki page ID, and work-page permalink. It did not contain any score-file,
edition, publisher, plate-number, preview, license, or download data.
([current work-list response](https://imslp.org/imslpscripts/API.ISCR.php?account=worklist/disclaimer=accepted/sort=id/type=2/start=0/retformat=json))

That makes the documented API suitable for a cached work finder, not an edition
picker. The `intvals.icatno` value is the musical work's internal catalogue
number; it must not be presented as a publisher's edition or plate number.

IMSLP also runs a standard MediaWiki Action API at `/api.php`. A live probe could
query a work page and retrieve its raw wikitext, including custom
`#fte:imslpfile` blocks. IMSLP does not document that custom wikitext format as
an integration contract, and the fields contain nested templates and
human-edited omissions. It is therefore an opportunistic parsing surface, not a
reliable product dependency. If it is ever prototyped, follow MediaWiki's API
etiquette: identify the client, serialize requests, cache results, use `maxlag`
for background work, and back off on errors.
([live IMSLP Action API help](https://imslp.org/api.php),
[MediaWiki API etiquette](https://www.mediawiki.org/wiki/API:Etiquette))

The live responses from both IMSLP endpoints omitted an
`Access-Control-Allow-Origin` header. A direct Angular-to-IMSLP API call should
not be assumed to work cross-origin; any experiment belongs behind Noted's
server and must remain bounded and cacheable.

## What the work page exposes

The human-facing work page is the most complete official comparison surface.
IMSLP's file-information guide says that every PDF has a user-editable
description and that the publisher-information field holds most edition
information. It also explicitly permits information to be absent or replaced
with placeholders such as “Unidentified publisher” and `n.d.`.
([file-information guide](https://imslp.org/wiki/IMSLP:Score_submission_guide/File_Information))

Depending on the entry, a work page can display:

- section headings that distinguish scores, parts, arrangements and
  transcriptions, movements, and instrumentation;
- file description, format, size, and page count;
- scanned versus typeset status, uploader, submission date, and scanner source;
- editor, arranger, copyist, or translator;
- series or volume, publisher, place, publication or reissue date, edition or
  catalogue number, and plate number;
- an item-specific copyright label and regional status;
- miscellaneous notes, including missing pages, alterations, scanning method,
  or other distinctions;
- a unique IMSLP file index shown as `#NNNNNN`.

The official submission guide names that number the “IMSLP #” and says that its
link opens the file's maintenance page. The work-page UI also offers a “File
permlink”; currently it resolves through
`https://imslp.org/wiki/Special:ReverseLookup/<file-index>` back to the relevant
work-page file anchor.
([score-submission guide](https://imslp.org/wiki/IMSLP:Score_submission_guide))

The current Bach BWV 846 page demonstrates why this is useful but not proof of
an exact match: separate files identify editors such as Carl Czerny and Albert
Schweitzer, publishers and series such as Schirmer's Library and *Klassiker der
Tonkunst*, plate numbers, page ranges, regional copyright statuses, scans,
typesets, and arrangements. Some entries omit fields, while other entries note
removed fingering or added editorial marks.
([BWV 846 work page](https://imslp.org/wiki/Prelude_and_Fugue_in_C_major,_BWV_846_(Bach,_Johann_Sebastian)))

### Identifiers worth retaining

| Value | Use in Noted | Boundary |
| --- | --- | --- |
| Canonical IMSLP work URL | Durable source link and browser handoff | Identifies the work page, not a score file |
| Work-page title and API `pageid` | Work-level cache key and reconciliation aid | Page title can move; neither proves an edition |
| IMSLP file index and `Special:ReverseLookup` link | User-confirmed identity of the selected score file | Do not crawl the special route or treat it as a download API |
| File description and section path | Distinguish complete score, movement, part, or arrangement | Human-authored and not guaranteed complete |
| Editor/arranger, publisher, series, edition/catalogue number, plate, date | Comparison clues shown to the user | Fields may be missing, uncertain, or shared across printings |
| Page count, scan/typeset status, misc. notes | Help catch obvious mismatches | Still cannot prove layout or musical equivalence |
| Item copyright label and regional status | Rights warning and provenance | Status is file-specific and country-dependent |

Do not use the PDF filename, a CDN path, or a `PMLP` filename fragment as the
product identity. IMSLP does not document those as a stable external contract,
and direct file paths bypass the intended browser flow.

## Preview and download behavior

IMSLP supports two optional, uploader-supplied visual aids:

- `Thumb Filename`, shown beside a file entry; and
- `Sample Filename`, intended to show the first measures so a user can decide
  whether to download.

The guide requires these images to be uploaded and attached separately, so
neither is guaranteed and neither is a standardized multi-page preview.
([thumbnail and preview-sample instructions](https://imslp.org/wiki/IMSLP:Score_submission_guide#How_to_add_thumbnails_and_preview_samples))

When no useful sample exists, the supported preview is the ordinary human
download flow: the user clicks the score description, passes any applicable
disclaimer or wait, and opens the PDF in the browser or a PDF reader. IMSLP's
download help specifically describes a disclaimer for files on regional EU,
US, or Canadian servers. Membership is not required to download, though some
files have a wait for non-members.
([download help](https://imslp.org/wiki/Help:Downloading_and_printing_pdf_files),
[membership Q&A](https://imslp.org/wiki/IMSLP:Membership_Q%26A))

Noted should not promise an inline IMSLP preview. It can show an optional
thumbnail/sample when IMSLP supplies one through a future supported metadata
contract; otherwise it should say “Review on IMSLP,” open the external work
page, and let the user inspect the actual PDF there.

## Automation boundary

The supported automated surface is the documented people/work catalogue API.
The following browser UI and crawler-policy evidence indicates that the file
flow is intended to remain human-mediated:

- Work-page download links go through `Special:ImagefromIndex/<file-index>` and
  are marked `nofollow` in the page HTML.
- Current direct requests to file and special routes encountered JavaScript and
  human-verification pages.
- IMSLP's current `robots.txt` instructs general crawlers not to access
  `/wiki/Special:`, `/wiki/File:`, `/images/`, or `/imglnks/`, and specifies a
  two-second crawl delay for allowed paths.
  ([IMSLP robots policy](https://imslp.org/robots.txt))

Accordingly, Noted must not construct CDN URLs, scrape file pages, bypass waits
or disclaimers, solve bot checks, proxy PDF downloads, or use
`Special:ImagefromIndex` as a backend API. A deeper file integration requires a
new IMSLP-supported contract or explicit permission, not a more elaborate
scraper.

## Rights and reuse boundary

IMSLP says each listed item is either public domain or released under a license,
but copyright status varies by country and IMSLP does not guarantee a file's
status in the user's jurisdiction. Licensed items carry their own terms; a
public-domain composition does not make every arrangement, edition, preface,
fingering, or editorial contribution public domain.
([general disclaimer](https://imslp.org/wiki/IMSLP:General_disclaimer),
[public-domain guidance](https://imslp.org/wiki/Public_domain),
[licensing policy](https://imslp.org/wiki/IMSLP:Licensing_Policy_and_Guidelines))

The wiki page text is separately offered under CC BY-SA 4.0 in IMSLP's page
footer. That page-level license must not be confused with the score file's
item-specific status. If Noted copies and republishes IMSLP descriptions rather
than merely linking and recording user-supplied provenance, attribution and
share-alike implications need a separate review.

For this effort, the conservative product rule is:

1. Keep the IMSLP work URL and, if the user confirms it, the file permlink/index.
2. Record the displayed rights label, regional marker, and retrieval date as
   provenance, not as Noted's legal determination.
3. Keep the resulting PDF private to the owning user.
4. Do not redistribute, mirror, or proxy the file.
5. Tell the user to follow the item license and the law where they are located.

## Recommended Noted flow

1. **Discover a work.** Offer “Search IMSLP” as an external browser action. A
   later bounded prototype may add cached work-title/composer suggestions from
   the documented work-list API.
2. **Review candidates on IMSLP.** Explain the comparison clues: original score
   versus arrangement, complete score versus movement/part, editor or arranger,
   publisher/series, plate or edition number, date, page count, and notes.
3. **Use honest match labels.** Present “Same file previously imported” only
   when the IMSLP file index matches. Present “Edition details appear to match”
   only after the user confirms the clues. Otherwise say “Another or unknown
   edition of this work.” Never auto-label an IMSLP result “same working copy.”
4. **Download on IMSLP.** Open the official work page in a new browser context
   and leave the complete download flow there.
5. **Upload into the existing draft.** The user selects the downloaded PDF.
   Noted validates it and uses its normal preparation/review tools.
6. **Retain provenance.** Store the work URL, optional user-confirmed file
   permlink/index, selected comparison clues, displayed rights label and region,
   retrieval date, and the user's match confirmation. All fields remain
   editable because IMSLP metadata can be incomplete.
7. **Fail open to assisted upload.** If the API is unavailable, metadata cannot
   be parsed, no preview exists, or the edition is unclear, do not block intake:
   return to “Open IMSLP, download, then upload PDF.”

This route improves discovery without changing Noted's current rights or trust
boundary. It also supports the user's actual goal: IMSLP is useful for exploring
new pieces, while capture from the physical working copy is the dependable path
when lesson layout and markings matter.

## Preconditions for any deeper integration

Before planning an in-app edition list or preview, obtain one of the following:

- IMSLP documentation for a supported file/edition metadata API and its reuse
  terms; or
- explicit IMSLP permission for the proposed access pattern.

Then prototype against varied work pages and prove graceful handling of missing
publisher data, multiple files in one entry, arrangements, movement-only files,
regional restrictions, optional samples, renamed pages, unavailable services,
and changed template markup. Until then, the assisted browser handoff is the
decision-complete safe baseline.
