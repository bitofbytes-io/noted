# Alternatives after the curved-page remap prototype

Status: Research for [Noted score intake](https://github.com/bitofbytes-io/noted/issues/56)

Date: 2026-09-22

## Recommendation

Do not ship the prototype's vertical-only staff-guided remap as the answer to
strongly curved book pages. Its result on the user's difficult sample is a
negative human verdict, even after the guides were aligned. The next useful
test is **better capture of the same physical page**, not another adjustment
to that remap. The physical book remains the reference for the exact edition
and pencil/teacher markings. Keep the original capture and let the human accept
or retake each page; do not block saving automatically.

Try a small, controlled comparison before designing more Noted UI:

1. Use one difficult page as the test. Keep its existing phone photo as the
   baseline. Support both sides of the open book so the page rests in a
   comfortable position; do not press or force the spine flat. Use a stable
   overhead phone position, frame one entire page including the gutter, and
   light the page evenly from both sides without flash glare. A simple support
   and two lights are a trial setup, not a purchase recommendation. The
   [Library of Congress advises a cradle or foam supports and warns against
   flattening pressure](https://www.loc.gov/preservation/care/scan.html); the
   [Met's book-imaging setup uses a V-shaped cradle and even lighting from two
   lamps](https://www.metmuseum.org/perspectives/making-reality-virtual).
2. Capture that page again with the existing Noted flow. Compare source and
   prepared page at **one full page per view** on the 13-inch iPad. The human
   checks notes, accidentals, staff continuity, fingering, dynamics, and the
   inside margin at actual playing size. Readability takes precedence over
   perfect preservation of faint pencil, but missing musical content fails.
3. Only if the new capture still fails, trial one dedicated book-scanning
   workflow on that same page and compare its export with the untouched photo.
   Do not infer that a vendor's “flatten” claim preserves notation or marks;
   that is the point of this test.

## Options and limits

| Option | What it could change | Tradeoff / test boundary |
| --- | --- | --- |
| Supported overhead phone capture | Reduces the curl, binding shadow, and perspective error **before** pixels are recorded. The exact printed edition and any visible handwriting remain in frame. | Requires repositioning the book and light. A support must not strain the binding. Overhead photography with a copy stand and a book scanner are both established bound-material methods at the [Smithsonian Institution Archives](https://siarchives.si.edu/blog/intern%E2%80%99s-guide-how-digitize-field-book). |
| A proper overhead book scanner or accessible library digitization station | Can hold a book on a cradle and image it from above. | Useful only if a station is accessible and produces a visibly better page; avoid buying equipment before the phone A/B. The [Met explains why its V-cradle is gentler than a flatbed for fragile bindings](https://www.metmuseum.org/perspectives/making-reality-virtual). A flatbed may be reasonable for a book that opens easily, but never force a tight binding flat ([Library of Congress](https://www.loc.gov/preservation/care/scan.html)). |
| Dedicated scan app | May offer a stronger curved-page algorithm without building it in Noted. [Adobe Scan for iOS documents per-page Straighten in Book/Document mode](https://www.adobe.com/devnet-docs/adobescan/ios/en/scan.html); [vFlat advertises automatic flattening of curved book pages](https://www.vflat.com/en). | These are *feature claims*, not evidence on marked music. Export and compare every symbol at full-page size. Adobe says its iOS scan PDFs are [saved to Adobe cloud storage](https://www.adobe.com/devnet-docs/adobescan/ios/en/scan.html), a material privacy difference from a first-party Noted capture. Do not use private marked pages in a third-party app without a deliberate privacy decision. |
| Another algorithm inside Noted | A genuine 2D displacement field / 3D-page geometry estimate could correct both horizontal compression and vertical bowing. Published methods such as [UVDoc](https://arxiv.org/abs/2302.02887) predict an unwarping grid, rather than only four page corners. | A research prototype, not a near-term feature promise. Benchmarks use documents, not an exact-fidelity score/handwriting test. A wrong map may reshape noteheads or spacing; a coordinate map cannot reveal notation that the camera did not capture. The existing [ScanTailor Advanced](https://github.com/4lex4/scantailor-advanced/blob/master/README.md) manual mesh is another local baseline, but its own README says its automatic border-based dewarping works best on low-curved scans. |
| Two views of the same page | A second angle may expose notation hidden in one gutter view. | This would add alignment/compositing and a new human comparison step. Defer unless a supported, single capture still loses needed content. Do not reconstruct missing notes automatically. |

## Product boundary

For this user, the most likely gain is an optional, short **capture hint** when
a physical page is difficult: support the book, fill the frame with one page,
light evenly, inspect the inside margin, and recapture if symbols are obscured.
Noted already has capture, four-corner crop/perspective correction, per-page
preparation, original retention, and manual review; this is not a request to
rebuild those features. Only add UI after the same-page comparison shows a
specific missing affordance. If a careful capture is still unreadable at
full-page size, prefer a different physical capture method over stronger
cleaning that invents or erases marks.

The recommended acceptance gate is a human decision on the **actual iPad page
view**, not a geometry score. A result may be imperfect and still save. The
comparison should retain the source and make before/after visible for each
page, especially when adjustments are applied.
