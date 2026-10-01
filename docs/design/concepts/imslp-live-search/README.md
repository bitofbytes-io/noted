# IMSLP live search concept

Status: Draft for review, 2026-10-01. No application implementation.

`imslp-flow.html` shows the IMSLP connection inside the Source step after the
local work catalogue is removed: search as you type against IMSLP's own API,
one tap to store the work link, prefill title and composer and open the work
on IMSLP, the draft waiting for the downloaded PDF, and the slow/limited/empty
states. Frame 1 is interactive to demonstrate debounce, cancellation, caching
and the two failure statuses. Open the file in a browser; it has no build step.

Work titles, composers and filenames are real IMSLP values used as examples.
The plan it illustrates is `docs/product/imslp-live-search-plan.md`.
