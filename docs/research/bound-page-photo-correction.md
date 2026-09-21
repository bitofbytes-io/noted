# Safe correction of bound-page photos

Status: Research decision for [Research safe correction of bound-page photos](https://github.com/bitofbytes-io/noted/issues/58)  
Date: 2026-09-20

## Decision

Keep correction in Noted's browser worker and keep it deterministic. The current
four-corner correction and `Lighten paper` control are the right base. Add any
curved-page work first as an opt-in prototype that estimates a smooth coordinate
map from page edges and musical staff lines, then samples the immutable original
through that map. It must not generate, inpaint, threshold, redraw, or classify
notation.

That prototype is worth testing, but it is not ready to promise as a feature.
A single perspective transform cannot flatten a curved page, and none of the
off-the-shelf options reviewed here meets Noted's web, mobile, licensing, and
musical-fidelity needs without a test on real marked-up scores. When the camera
did not record usable detail, Noted should ask for a retake. Software cannot
recover a pencil mark hidden by the binding or a note lost in a clipped shadow.

Do not make Apple VisionKit, a server-side deep model, or a third-party scanning
service the primary route. VisionKit requires a native iOS app. Learned document
models add large runtimes, uncertain behavior on sheet music and handwriting,
and, in one strong candidate, a non-commercial license. A first-party server
fallback remains possible later because Noted already stores the private source,
but it should only follow evidence that the browser cannot meet the physical
iPhone gate.

## Terms used here

- **Working copy** is the physical book page the pianist uses, including pencil,
  fingering, and teacher marks.
- **Sampling-only correction** computes where each output pixel reads from the
  source, then interpolates nearby source pixels. Rotation, a perspective warp,
  and a smooth curved-page warp fit this definition. Interpolation creates new
  numeric samples, but it does not infer musical content.
- **Photometric correction** changes brightness or color using a smooth estimate
  of the page lighting. It is acceptable only when it stays continuous, optional,
  reversible, and visible beside the original.
- **Content reconstruction** guesses or replaces marks. Generative output,
  inpainting, stroke cleanup, notation recognition and redraw, and destructive
  thresholding fit this definition. They are outside the destination.
- **Unrecoverable capture** is a source in which the camera never recorded the
  needed content because it is occluded, clipped, blurred, or outside the frame.
  Correction must not claim to repair it.

These boundaries matter more than whether a method uses machine learning. A
model that predicts only a coordinate map can still be a sampling-only method,
although a wrong map can badly bend notation. A model that outputs a cleaned
image crosses into content reconstruction because it can change the appearance
of marks independently of the source pixels.

## What Noted already has

The current implementation already has most of the safeguards needed here:

- It keeps the original asset immutable and lets the user compare or reset the
  result.
- It runs OpenCV.js in a worker. Corrected photos are bounded to 4 megapixels and
  2800 pixels per edge, and pages are processed one at a time.
- Four user-selected corners feed `getPerspectiveTransform` and
  `warpPerspective`. This corrects a flat page photographed at an angle.
- `Lighten paper` estimates broad illumination with dilation and Gaussian blur,
  divides the original colors by that background estimate, and blends by a user
  controlled strength. It does not binarize the finished page.
- The original JPEG stays byte-for-byte intact when no pixel correction is
  needed.

See the [approved score-intake requirements](../product/requirements.md#approved-score-intake-extension)
and the current [processing worker](../../web/public/intake/processing-worker.js).
OpenCV documents `warpPerspective` as a 3 by 3 perspective mapping and `remap`
as an arbitrary mapping from every output coordinate to a source coordinate.
That distinction explains both the current limit and the practical route to a
curved-page experiment: [`warpPerspective` and `remap`](https://docs.opencv.org/4.x/da/d54/group__imgproc__transform.html).

## Corrections by defect

### Perspective distortion

Keep the existing four-corner homography. It is predictable, inspectable, and
already uses the user's page boundary. Apple exposes the same basic evidence in
its document segmentation request: a detected document produces four corner
points and a saliency mask. That API does not document a curved-page result.
See Apple's [`VNDetectDocumentSegmentationRequest`](https://developer.apple.com/documentation/vision/vndetectdocumentsegmentationrequest).

Automatic corner suggestions may reduce work, but the user's corners must remain
authoritative. A bound page often has an ambiguous inside edge, a hand, or the
opposite page in view. Auto-detection should refuse low-confidence cases rather
than crop notation.

### Binding shadow and uneven light

Retain the current low-frequency illumination approach. Make it easier to compare
at playing size, and keep the strength control. Do not replace it with adaptive
thresholding. OpenCV defines adaptive thresholding as conversion to a binary
image, which necessarily collapses continuous differences that may distinguish
faint pencil from paper: [OpenCV threshold documentation](https://docs.opencv.org/4.x/d7/d1b/group__imgproc__misc.html#gab9ed2002f3bb1b5b6196f9e5f96a08d0).

The background-estimation scale must stay much wider than staff lines, stems,
fingering, and ordinary pencil marks. Detection may use a temporary binary or
grayscale copy, but the corrected output must come from the continuous-color
original. Add a warning when a broad band near the binding is nearly black,
nearly white, or locally blurred. The warning should recommend a retake, not
offer stronger cleanup. A broad shadow can be brightened if detail exists inside
it. A clipped or occluded region has no detail to brighten.

Do not add inpainting, erasure of specks, background replacement, local stroke
sharpening, or a learned illumination-output model. Those methods can remove
faint teacher marks or turn compression noise into plausible notation.

### Curved pages

A homography models one plane. A bound page is not one plane, so moving the four
corners can straighten the outline while staff lines remain bowed and measures
near the binding remain compressed.

The safest plausible experiment is a music-aware displacement map:

1. Downsample a copy for analysis. Detect the page boundary and long staff-line
   traces. Use the temporary copy only to estimate geometry.
2. Fit smooth staff curves and a smooth, monotonic page mesh. Constrain the mesh
   so lines do not cross and local scale does not change abruptly.
3. Convert that mesh to a backward coordinate map. Apply `cv.remap` to the
   original continuous-color image, not to the detection mask.
4. Show original and corrected views at playing size and close zoom. Keep the
   correction off by default until the user accepts it.
5. Refuse when the page has too few reliable staves, inconsistent evidence,
   severe occlusion, missing edges, or a fold that would require inventing area.

This is a prototype question, not an implementation plan. Staff lines give
stronger geometric evidence than ordinary prose, but musical content also breaks
and joins those lines. The prototype must test title pages, short systems, ossia,
multi-column music, ledger lines, handwritten marks that cross staves, and pages
where the inside ends of staves disappear into the binding.

Leptonica shows that a non-generative disparity-map approach is practical. Its
dewarp code fits long text-line centers, builds smoothed vertical and horizontal
disparity fields, and applies those fields to source pixels. Its own source also
states the limits: too few long lines prevent a model, horizontal correction
assumes roughly aligned text edges, and the implementation does not provide the
extra widening needed to fully reverse foreshortening near a binding. It is a
useful design reference, not a drop-in music solution:
[Leptonica's dewarp model](https://github.com/DanBloomberg/leptonica/blob/master/src/dewarp1.c)
and [model builder](https://github.com/DanBloomberg/leptonica/blob/master/src/dewarp2.c).

## Where processing should run

| Approach | Fit for Noted | Decision |
| --- | --- | --- |
| Browser worker with OpenCV.js | Matches the Angular app, existing preview/export path, and original comparison. It avoids third-party transfer and keeps interaction responsive by working off the main thread. The current source is still uploaded and retained by Noted, so this is not a promise that photos never leave the device. | Primary route. Prototype the coordinate-map approach here first. |
| First-party server | Removes the iPhone's computation and memory burden and could run native libraries. It adds queueing, CPU limits, temporary derived files, preview latency, and another failure boundary. Privacy stays first-party because Noted already stores the originals. | Keep as a fallback only if physical-device tests reject browser performance. |
| Apple VisionKit | Apple's document camera provides a native camera controller and returns page images by page number. Apple's WWDC demonstration describes automatic perspective correction, cropping, and balanced lighting. Apple's document segmentation API returns corners and a mask. These are native Swift or Objective-C APIs, not web APIs available to the Angular application. Apple does not document a curved-page or handwritten-mark preservation contract. | Do not build the main flow around it. Users may still scan in Files or Notes and upload the resulting PDF. |
| HTML file capture or Image Capture | The web platform can request the outward camera and can take a photo from a media track, but the standards do not supply document flattening. `capture` is a preferred facing-mode hint with implementation-specific fallback. | Keep the file-input fallback. A custom live camera may later add framing and lighting guidance, but it does not solve dewarping by itself. |
| Third-party cloud scanner | May offer stronger cleanup, but sends private book pages and handwriting to another processor and gives Noted little control over what pixels changed. | Exclude. |

Primary platform references:

- [Apple VisionKit document camera](https://developer.apple.com/documentation/visionkit/vndocumentcameraviewcontroller)
- [Apple's VisionKit document-camera demonstration](https://developer.apple.com/videos/play/wwdc2019/234/)
- [Apple's Files and Notes scanning flow](https://support.apple.com/en-us/108963)
- [W3C HTML Media Capture](https://www.w3.org/TR/html-media-capture/)
- [W3C MediaStream Image Capture](https://www.w3.org/TR/image-capture/)

## Privacy boundary

Browser processing does not mean device-only processing in Noted. The current
draft flow uploads and retains each private original before the worker fetches it
for correction. Keeping the worker in the browser avoids sending pages to a new
processor, but the source still lives in Noted's first-party storage.

Do not call a hosted scanning or model API for these pages. Book pages can include
names, teacher comments, and a user's handwriting. Camera files can also contain
location or device metadata. The HTML Media Capture recommendation specifically
warns that EXIF location data can disclose more than the user expects. Preserve
the source privately for reset, do not copy unneeded metadata into a derived PDF,
and confirm that any finished-score download remains owner-only.

## Mobile performance limits

Keep the existing 4-megapixel and 2800-pixel working limits for the experiment.
They are engineering bounds, not proof that every iPhone can finish the work.
At 4 megapixels, one RGBA image is about 16 MB. A pair of 32-bit floating-point
coordinate maps adds about 32 MB, before the input, output, canvas, decoder,
JavaScript objects, and WebAssembly heap. OpenCV.js requires explicit deletion of
each `cv.Mat` to free its Emscripten heap allocation:
[OpenCV.js memory guidance](https://docs.opencv.org/4.x/d0/d84/tutorial_js_usage.html).

The current code decodes the accepted image before it downsizes the work surface.
A 20-megapixel RGBA decode alone is about 80 MB. The curvature prototype should:

- analyze a much smaller copy;
- process one page and one preview at a time;
- release every canvas, bitmap, map, and `cv.Mat` immediately;
- prefer a coarse control mesh or tiled remap over two full-resolution float maps;
- keep cancellation and worker restart behavior;
- record peak memory and time on the user's actual iPhone, then read the result on
  the target iPad.

Desktop Chromium measurements are useful for regressions but do not pass this
gate. The prototype also needs a forced low-memory or cancellation test that
proves the immutable original and current saved score survive a failure.

## Libraries and licensing

| Candidate | What it offers | License and constraint | Decision |
| --- | --- | --- | --- |
| OpenCV and the pinned `@techstark/opencv-js` build | Perspective warps, arbitrary remapping, morphology, blur, line detection, and the worker path Noted already uses. | Apache 2.0. The package lock records Apache 2.0, matching [OpenCV's license](https://github.com/opencv/opencv/blob/4.x/LICENSE). | Continue. No new correction dependency is required for the first prototype. |
| Leptonica | Deterministic text-line disparity models and source-pixel remapping. | BSD 2-Clause: [license](https://github.com/DanBloomberg/leptonica/blob/master/leptonica-license.txt). It is native C, and its text assumptions need replacement or validation for staff lines. | Use as a reference or server experiment, not as a browser dependency or untested product solution. |
| DewarpNet | A learned 3D shape and backward-map pipeline for one-image document unwarping. | Code is MIT: [repository and license](https://github.com/cvlab-stonybrook/DewarpNet). The PyTorch models are far heavier than the current browser worker, and the published evaluation targets document benchmarks and OCR, not marked sheet music at playing size. Model-weight and training-data provenance still need review before shipping them. | Do not adopt. A server-only benchmark on private examples is optional if deterministic mapping fails. |
| DocTr | Separate learned geometric-unwarping and illumination-correction transformers. | Its repository license allows non-commercial use and prohibits commercial use without permission: [license](https://github.com/fh2019ustc/DocTr/blob/main/LICENSE.md). Its illumination network outputs corrected appearance, which also crosses Noted's content-preservation line. The paper describes pixel-wise displacement and learned shading removal: [DocTr paper](https://arxiv.org/abs/2110.12942). | Exclude. |
| Vision and VisionKit | Native document corners, masks, and camera UI on Apple platforms. | Apple-platform SDK APIs. They require a native app or wrapper and expose no documented curved-sheet fidelity control. | No change to the web architecture for this effort. |

## Required refusal and review behavior

The correction must stop or fall back to the original when any of these occur:

- Staff evidence is sparse, split into incompatible slopes, or does not cover the
  page height.
- The fitted map folds over, crosses itself, or exceeds a conservative local
  stretch limit.
- The page boundary is missing at the binding or a hand covers content.
- A broad binding region is clipped or too blurred to show the original marks.
- Corrected output cuts ink, creates blank wedges inside the selected page, or
  changes the relative order of symbols.
- Processing runs out of memory, is cancelled, or produces inconsistent preview
  and export geometry.

Do not label a result "fixed" or "enhanced." Use a literal control such as
"Flatten curved page," show that it may move existing pixels, and keep a visible
Original/Adjusted comparison. The user should be able to turn it off per page.

## Evidence needed before specification

Build a throwaway prototype against private, representative photos. The set needs
at least:

- light, moderate, and severe curvature near both left and right bindings;
- even light, recoverable shadow, and clipped shadow;
- faint printed notation, pencil fingering, teacher marks, erasures, and colored
  pencil;
- dense piano notation, short systems, title pages, and music whose staves vanish
  into the binding;
- the same pages captured with a better angle or light, to establish what a retake
  can recover that software cannot.

Human review decides fidelity. At normal iPad playing size and close zoom, every
mark in the accepted output must trace back to visible source pixels. Staff lines
should be flatter without changing notehead, accidental, dot, ledger-line, slur,
fingering, or handwriting identity. The test should record refusal cases as useful
results rather than tuning the algorithm until it always returns an image.

If that prototype passes, the product specification can commit to sampling-only
curvature correction with original comparison and a retake path. If it fails,
the honest product answer is better capture guidance plus the existing perspective
and lighting controls, not a model that makes the page look clean while changing
the working copy.
