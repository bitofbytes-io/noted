import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { PDFDocument, StandardFonts, PDFName, PDFRawStream } from "pdf-lib";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import {
  processPDF as applyPDF,
  suggestGeometry,
  inkBounds,
  perspective,
  cv,
} from "./processor.mjs";
import { render, pixels, canvasFrom, textContent } from "./render.mjs";
import { inkGrid as imageInkGrid, gridDifference } from "./measurements.mjs";
const inkGrid = (canvas) => imageInkGrid(pixels(canvas));
import { detailScore } from "./fixtures.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url));
const out = path.join(root, ".local/score-intake-proof");
await fs.mkdir(out, { recursive: true });
const results = [],
  pairs = [],
  pdfs = [];
const hash = (b) => createHash("sha256").update(b).digest("hex");
const operations = [];
async function processPDF(sources, manifest) {
  const bytes = await applyPDF(sources, manifest);
  operations.push({
    outputSha256: hash(bytes),
    sourceSha256: sources.map(hash),
    manifest,
  });
  return bytes;
}
const identity = (n) => ({
  version: 1,
  pages: Array.from({ length: n }, (_, page) => ({ source: 0, page })),
});
async function save(name, bytes) {
  const dest = path.join(out, name);
  await fs.writeFile(dest, bytes);
  if (name.endsWith(".pdf")) pdfs.push(name);
  return bytes;
}
function check(name, pass, details) {
  results.push({ name, pass, ...details });
  if (!pass) console.error("FAIL", name, details);
}
async function bounds(bytes, page = 0) {
  const c = (await render(bytes, 2))[page],
    b = inkBounds(pixels(c));
  return { b: b?.map((v) => v / 2), c };
}
const clean = await save("clean-detail-score.pdf", await detailScore());

const cleanBounds = (await bounds(clean)).b;
const cleanStaff = suggestGeometry(
  pixels((await render(clean, 2))[0]),
).staffBounds.map((v) => v / 2);
// Threshold ink bounds padded by one point prevent subpixel crop errors.
function pdfBounds(b, height) {
  return [b[0] - 1, height - b[3] - 1, b[2] + 1, height - b[1] + 1];
}
const truth = [];
for (const angle of [-5, -3, -1, 1, 3, 5]) {
  const a = (angle * Math.PI) / 180,
    s = 1,
    x = 70 + 300 - 300 * Math.cos(a) + 400 * Math.sin(a),
    y = 70 + 400 - 300 * Math.sin(a) - 400 * Math.cos(a);
  const flawed = await save(
    `crooked-${angle}.pdf`,
    await processPDF([clean], {
      version: 1,
      pages: [
        {
          source: 0,
          page: 0,
          angle,
          x,
          y,
          width: 740,
          height: 940,
          inkBounds: pdfBounds(cleanBounds, 800),
        },
      ],
    }),
  );
  truth.push({ file: `crooked-${angle}.pdf`, angle, x, y });
  const c = (await render(flawed, 2))[0],
    suggestion = suggestGeometry(pixels(c));
  check(`straighten ${angle}: suggestion`, suggestion.confident, {
    suggestion,
  });
  if (!suggestion.confident) continue;
  // Pixel y increases downward, so the image slope is the PDF correction angle.
  const corrected = await save(
    `corrected-${angle}.pdf`,
    await processPDF([flawed], {
      version: 1,
      pages: [{ source: 0, page: 0, angle: suggestion.angle }],
    }),
  );
  const after = (await render(corrected, 2))[0],
    measured = suggestGeometry(pixels(after));
  check(
    `straighten ${angle}: rendered residual`,
    measured.confident && Math.abs(measured.angle) <= 0.25,
    { residualDegrees: measured.angle },
  );
  pairs.push({
    title: `Scanner tilt ${angle} degrees`,
    before: `crooked-${angle}.pdf`,
    after: `corrected-${angle}.pdf`,
  });
}
// Independent rendered-ink measurements drive alignment; fixture settings stay in truth only.
const alignedPages = [];
for (const [index, settings] of [
  { x: 18, y: 12, scale: 0.92 },
  { x: -22, y: -8, scale: 1.05 },
  { x: 5, y: 17, scale: 0.98 },
].entries()) {
  const flawed = await save(
    `offset-${index + 1}.pdf`,
    await processPDF([clean], {
      version: 1,
      pages: [
        {
          source: 0,
          page: 0,
          width: 650,
          height: 850,
          ...settings,
          inkBounds: pdfBounds(cleanBounds, 800),
        },
      ],
    }),
  );
  truth.push({ file: `offset-${index + 1}.pdf`, ...settings });
  const b = (await bounds(flawed)).b;
  const staff = suggestGeometry(
    pixels((await render(flawed, 2))[0]),
  ).staffBounds.map((v) => v / 2);
  const scale = (cleanStaff[2] - cleanStaff[0]) / (staff[2] - staff[0]);
  const x = cleanStaff[0] - staff[0] * scale,
    y = 800 - cleanStaff[1] - (850 - staff[1]) * scale;
  const corrected = await save(
    `aligned-${index + 1}.pdf`,
    await processPDF([flawed], {
      version: 1,
      pages: [
        {
          source: 0,
          page: 0,
          x,
          y,
          scale,
          width: 600,
          height: 800,
          inkBounds: pdfBounds(b, 850),
        },
      ],
    }),
  );
  const actual = (await bounds(corrected)).b;
  const positionError = Math.max(
    Math.abs(actual[0] - cleanBounds[0]) / 600,
    Math.abs(actual[1] - cleanBounds[1]) / 800,
  );
  const scaleError = Math.abs(
    (actual[2] - actual[0]) / (cleanBounds[2] - cleanBounds[0]) - 1,
  );
  check(`alignment ${index + 1}`, positionError <= 0.01 && scaleError <= 0.01, {
    positionErrorPercent: positionError * 100,
    scaleErrorPercent: scaleError * 100,
  });
  alignedPages.push(corrected);
  pairs.push({
    title: `Scanner margins and scale ${index + 1}`,
    before: `offset-${index + 1}.pdf`,
    after: `aligned-${index + 1}.pdf`,
  });
}
const organizedManifest = {
  version: 1,
  pages: [
    { source: 0, page: 2 },
    { source: 0, page: 0 },
    { source: 1, page: 0 },
  ],
};
const replacement = await processPDF([clean], {
  version: 1,
  pages: [{ source: 0, page: 1, angle: 1 }],
});
const organized = await save(
  "organized-score.pdf",
  await processPDF([clean, replacement], organizedManifest),
);
const organizationText = await textContent(organized);
const IDs = [
  ...organizationText.matchAll(/NOTED DETAIL STUDY \/ PAGE (\d)/g),
].map((m) => Number(m[1]));
check(
  "extract reorder and replace page IDs",
  JSON.stringify(IDs) === JSON.stringify([3, 1, 2]),
  { expected: [3, 1, 2], actual: IDs },
);
await save("page-manifest.json", JSON.stringify(organizedManifest, null, 2));
check(
  "no-edit checksum",
  hash(await processPDF([clean], identity(3))) === hash(clean),
  { sha256: hash(clean) },
);
check(
  "reset checksum",
  hash(await processPDF([clean], identity(3))) === hash(clean),
);
const repeatManifest = {
  version: 1,
  pages: [{ source: 0, page: 0, angle: 1 }],
};
const repeatedA = await processPDF([clean], repeatManifest),
  repeatedB = await processPDF([clean], repeatManifest);
check(
  "repeated save appearance",
  hash((await render(repeatedA))[0].toBuffer("image/png")) ===
    hash((await render(repeatedB))[0].toBuffer("image/png")),
);
// Synthetic camera capture. The reverse homography is supplied as manual corners, never automatic.
const photoClean = (await render(clean, 2))[0],
  photoPixels = pixels(photoClean);
const corners = [
  [65, 85],
  [1135, 35],
  [1170, 1535],
  [30, 1560],
];
const src = cv.matFromImageData(photoPixels),
  warped = new cv.Mat();
const p1 = cv.matFromArray(
    4,
    1,
    cv.CV_32FC2,
    [0, 0, 1199, 0, 1199, 1599, 0, 1599],
  ),
  p2 = cv.matFromArray(4, 1, cv.CV_32FC2, corners.flat()),
  matrix = cv.getPerspectiveTransform(p1, p2);
cv.warpPerspective(
  src,
  warped,
  matrix,
  new cv.Size(1200, 1600),
  cv.INTER_CUBIC,
  cv.BORDER_CONSTANT,
  new cv.Scalar(255, 255, 255, 255),
);
const distorted = {
  data: new Uint8ClampedArray(warped.data),
  width: 1200,
  height: 1600,
};
for (let y = 0; y < 1600; y++)
  for (let x = 0; x < 1200; x++) {
    const i = (y * 1200 + x) * 4,
      factor = 0.92 + (0.08 * x) / 1200;
    for (let k = 0; k < 3; k++) distorted.data[i + k] *= factor;
  }
[src, warped, p1, p2, matrix].forEach((m) => m.delete());
const restored = perspective(distorted, corners, 1200, 1600);
async function imagePDF(image) {
  const d = await PDFDocument.create(),
    e = await d.embedPng(canvasFrom(image).toBuffer("image/png"));
  d.addPage([600, 800]).drawImage(e, { x: 0, y: 0, width: 600, height: 800 });
  return d.save({ useObjectStreams: false });
}
await save("phone-photo-flawed.pdf", await imagePDF(distorted));
const photoCorrected = await save(
  "phone-photo-corrected.pdf",
  await imagePDF(restored),
);
truth.push({
  file: "phone-photo-flawed.pdf",
  manualCorners: corners,
  shadow: "linear 92-100% intensity",
});
pairs.push({
  title: "Phone perspective — MANUAL corners, mild shadow retained",
  before: "phone-photo-flawed.pdf",
  after: "phone-photo-corrected.pdf",
});
const residual = suggestGeometry(pixels((await render(photoCorrected, 2))[0]));
check(
  "manual phone perspective residual",
  residual.confident && Math.abs(residual.angle) <= 0.25,
  { residualDegrees: residual.angle, automaticCorners: false },
);
// A PDF CCITT stream must contain one Group4 strip, not concatenated TIFF strips.
const python = process.env.PYTHON ?? "python3";
execFileSync(python, [
  fileURLToPath(new URL("./generate-ccitt.py", import.meta.url)),
  out,
]);
const validCCITT = await save(
  "valid-ccitt-original.pdf",
  await fs.readFile(path.join(out, "valid-ccitt-original.pdf")),
);
await save(
  "valid-ccitt-transformed.pdf",
  await processPDF([validCCITT], {
    version: 1,
    pages: [{ source: 0, page: 0, angle: 2 }],
  }),
);
const referenceDoc = await PDFDocument.create(),
  referenceImage = await referenceDoc.embedPng(
    await fs.readFile(path.join(out, "valid-ccitt-reference.png")),
  );
referenceDoc
  .addPage([612, 792])
  .drawImage(referenceImage, { x: 36, y: 36, width: 540, height: 720 });
await save("valid-ccitt-reference.pdf", await referenceDoc.save());
for (const name of ["noted-exercise", "noted-ccitt-exercise"]) {
  const input = await fs.readFile(
    path.join(root, `testdata/fixtures/${name}.pdf`),
  );
  await save(`${name}-original.pdf`, input);
  const count = (await PDFDocument.load(input)).getPageCount();
  check(
    `${name} unchanged checksum`,
    hash(await processPDF([input], identity(count))) === hash(input),
  );
  await save(
    `${name}-transformed.pdf`,
    await processPDF([input], {
      version: 1,
      pages: [{ source: 0, page: 0, angle: 2 }],
    }),
  );
  pairs.push(
    name === "noted-ccitt-exercise"
      ? {
          title: "Valid single-strip CCITT, 2 degree content transform",
          before: "valid-ccitt-original.pdf",
          after: "valid-ccitt-transformed.pdf",
        }
      : {
          title: `Existing ${name} fixture, 2 degree content transform`,
          before: `${name}-original.pdf`,
          after: `${name}-transformed.pdf`,
        },
  );
}
// Optional source acquired by coordinator through IMSLP's ordinary browser flow.
const external = path.join(out, "external/imslp-02206-bach-bwv846.pdf");
try {
  const input = await fs.readFile(external),
    count = (await PDFDocument.load(input)).getPageCount();
  await save("imslp-original.pdf", input);
  check(
    "IMSLP unchanged checksum",
    hash(await processPDF([input], identity(count))) === hash(input),
    { pages: count },
  );
  for (const page of [0, 1])
    check(
      `IMSLP nonmusic page ${page + 1} abstention`,
      !suggestGeometry(pixels((await render(input, 1))[page])).confident,
    );
  const crooked = await save(
    "imslp-crooked.pdf",
    await processPDF([input], {
      version: 1,
      pages: [{ source: 0, page: 2, angle: 3 }],
    }),
  );
  const suggestion = suggestGeometry(pixels((await render(crooked, 2))[0]));
  if (suggestion.confident) {
    const corrected = await save(
      "imslp-corrected.pdf",
      await processPDF([crooked], {
        version: 1,
        pages: [{ source: 0, page: 0, angle: suggestion.angle }],
      }),
    );
    const measured = suggestGeometry(pixels((await render(corrected, 2))[0]));
    check(
      "IMSLP rendered residual",
      measured.confident && Math.abs(measured.angle) <= 0.25,
      { residualDegrees: measured.angle },
    );
    pairs.push({
      title: "IMSLP Kroll edition, synthetic 3 degree tilt",
      before: "imslp-crooked.pdf",
      after: "imslp-corrected.pdf",
    });
  } else
    check("IMSLP suggestion abstains", true, {
      suggestion,
      manualReviewRequired: true,
    });
} catch (e) {
  if (e.code !== "ENOENT") throw e;
  results.push({
    name: "Optional IMSLP sample",
    pass: null,
    reason: "No local sample; see README",
  });
}
try {
  const second = await fs.readFile(
    path.join(out, "external/imslp-01005-bach-bwv846.pdf"),
  );
  const count = (await PDFDocument.load(second)).getPageCount();
  await save("imslp-czerny-original.pdf", second);
  check(
    "IMSLP Czerny unchanged checksum",
    hash(await processPDF([second], identity(count))) === hash(second),
    { pages: count },
  );
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
await save("ground-truth.json", JSON.stringify(truth, null, 2));
// Inspect all nested PDF streams, including embedded Form XObjects.
async function resources(bytes) {
  const d = await PDFDocument.load(bytes);
  const streams = d.context
    .enumerateIndirectObjects()
    .map(([, v]) => v)
    .filter((v) => v instanceof PDFRawStream);
  return {
    images: streams.filter(
      (v) => v.dict.get(PDFName.of("Subtype"))?.toString() === "/Image",
    ).length,
    forms: streams.filter(
      (v) => v.dict.get(PDFName.of("Subtype"))?.toString() === "/Form",
    ).length,
    ccitt: streams
      .filter((v) =>
        v.dict.get(PDFName.of("Filter"))?.toString().includes("CCITTFaxDecode"),
      )
      .map((v) => hash(v.contents)),
  };
}
const originalResources = await resources(clean),
  transformedResources = await resources(
    await fs.readFile(path.join(out, "corrected-3.pdf")),
  );
check(
  "vector preservation: nested stream resources",
  originalResources.images === 0 &&
    transformedResources.images === 0 &&
    transformedResources.forms > 0,
  { original: originalResources, transformed: transformedResources },
);
const ccittBefore = await resources(
    await fs.readFile(path.join(out, "noted-ccitt-exercise-original.pdf")),
  ),
  ccittAfter = await resources(
    await fs.readFile(path.join(out, "noted-ccitt-exercise-transformed.pdf")),
  );
check(
  "Legacy CCITT compressed bytes retained (does not establish fidelity)",
  ccittBefore.ccitt.length > 0 &&
    JSON.stringify(ccittBefore.ccitt) === JSON.stringify(ccittAfter.ccitt),
  { original: ccittBefore, transformed: ccittAfter },
);
// Human review booklet: full comparisons followed by tiny-detail crops.
const review = await PDFDocument.create(),
  font = await review.embedFont(StandardFonts.Helvetica);
const html = [];
for (const [i, pair] of pairs.entries()) {
  const canvases = [];
  for (const side of ["before", "after"]) {
    const bytes = await fs.readFile(path.join(out, pair[side]));
    const c = (await render(bytes, 1.2))[0];
    const name = `comparison-${i + 1}-${side}.png`;
    await save(name, c.toBuffer("image/png"));
    canvases.push(c);
  }
  const includeInBooklet = [0, 5, 6, 9, 10, 11, 12].includes(i);
  const p = includeInBooklet ? review.addPage([1000, 730]) : null;
  p?.drawText(pair.title.replace("—", "-"), { x: 25, y: 705, size: 13, font });
  for (const [j, c] of canvases.entries()) {
    const e = await review.embedPng(c.toBuffer("image/png")),
      s = Math.min(455 / c.width, 635 / c.height);
    p?.drawImage(e, {
      x: 25 + j * 495,
      y: 35,
      width: c.width * s,
      height: c.height * s,
    });
    p?.drawText(j ? "Corrected / transformed" : "Input", {
      x: 25 + j * 495,
      y: 680,
      size: 11,
      font,
    });
  }
  html.push(
    `<section><h2>${pair.title}</h2><div class="pair"><figure><img src="comparison-${i + 1}-before.png"><figcaption><a href="${pair.before}">Input PDF</a></figcaption></figure><figure><img src="comparison-${i + 1}-after.png"><figcaption><a href="${pair.after}">Output PDF</a></figcaption></figure></div></section>`,
  );
}
const detailPage = review.addPage([1000, 740]);
detailPage.drawText(
  "Small notation detail: clean master / corrected phone photo (enlarged)",
  { x: 25, y: 705, size: 15, font },
);
for (const [j, c] of [photoClean, canvasFrom(restored)].entries()) {
  const crop = createCanvas(600, 200);
  crop.getContext("2d").drawImage(c, 130, 170, 600, 200, 0, 0, 600, 200);
  const e = await review.embedPng(crop.toBuffer("image/png"));
  detailPage.drawText(
    j === 0
      ? "Original clean master"
      : "Corrected phone photo - manual corners",
    { x: 35, y: 655 - j * 310, size: 12, font },
  );
  detailPage.drawImage(e, { x: 35, y: 365 - j * 310, width: 840, height: 280 });
  await save(`detail-${j}.png`, crop.toBuffer("image/png"));
}
await save("review.pdf", await review.save());
await save(
  "corrected-score.pdf",
  await processPDF([alignedPages[0], photoCorrected, clean], {
    version: 1,
    pages: [
      { source: 0, page: 0 },
      { source: 1, page: 0 },
      { source: 2, page: 2 },
    ],
  }),
);
// Remove stale Poppler pages so a prior output cannot satisfy this run's checks.
await fs.rm(path.join(out, "poppler"), { recursive: true, force: true });
// EVERY generated PDF page must render through both engines, including the review pack.
for (const name of pdfs) {
  const bytes = await fs.readFile(path.join(out, name)),
    canvases = await render(bytes, 0.5);
  const prefix = path.join(out, "poppler", name.replace(".pdf", ""));
  await fs.mkdir(path.dirname(prefix), { recursive: true });
  execFileSync("pdftoppm", ["-r", "36", "-png", path.join(out, name), prefix], {
    stdio: "pipe",
  });
  const files = (await fs.readdir(path.dirname(prefix))).filter(
    (f) => f.startsWith(path.basename(prefix) + "-") && f.endsWith(".png"),
  );
  check(`dual render: ${name}`, files.length === canvases.length, {
    pages: canvases.length,
  });
}
// Compare spatial ink coverage, not just page counts. These checks catch truncated
// Group4 strips and the huge black blocks in the existing malformed baseline.
async function popplerCanvas(name) {
  const image = await loadImage(
    path.join(out, "poppler", name.replace(".pdf", "") + "-1.png"),
  );
  const c = createCanvas(image.width, image.height);
  c.getContext("2d").drawImage(image, 0, 0);
  return c;
}
const referenceGrid = inkGrid(
  (
    await render(
      await fs.readFile(path.join(out, "valid-ccitt-reference.pdf")),
      0.5,
    )
  )[0],
);
for (const engine of ["PDF.js", "Poppler"]) {
  const valid =
    engine === "PDF.js"
      ? (await render(validCCITT, 0.5))[0]
      : await popplerCanvas("valid-ccitt-original.pdf");
  const diff = gridDifference(inkGrid(valid), referenceGrid);
  check(
    `valid CCITT spatial content: ${engine}`,
    diff.mean < 0.015 && diff.max < 0.06,
    { difference: diff },
  );
  const legacy =
    engine === "PDF.js"
      ? (
          await render(
            await fs.readFile(
              path.join(out, "noted-ccitt-exercise-original.pdf"),
            ),
            0.5,
          )
        )[0]
      : await popplerCanvas("noted-ccitt-exercise-original.pdf");
  const legacyDiff = gridDifference(inkGrid(legacy), referenceGrid);
  check(
    `known malformed legacy CCITT detected: ${engine}`,
    legacyDiff.mean > 0.015 || legacyDiff.max > 0.06,
    {
      knownBaselineDefect: true,
      difference: legacyDiff,
      fidelityPassed: false,
    },
  );
}
// Independent column sampling on the first staff detects a residual photo slope
// without invoking the Hough algorithm used to propose correction.
const photoOutput = pixels((await render(photoCorrected, 2))[0]);
const staffColumnRows = [210, 510, 710, 1010].map((x) => {
  const rows = [];
  for (let y = 215; y < 290; y++) {
    let darkness = 0;
    for (let dx = -2; dx <= 2; dx++)
      darkness += photoOutput.data[(y * photoOutput.width + x + dx) * 4];
    if (darkness / 5 < 180) rows.push(y);
  }
  return rows;
});
const photoColumnDrift = Math.max(
  ...staffColumnRows.map((rows) =>
    Math.max(...rows.map((y, i) => Math.abs(y - staffColumnRows[0][i]))),
  ),
);
check(
  "photo independent staff column drift",
  staffColumnRows.every((rows) => rows.length === 10) && photoColumnDrift <= 2,
  {
    columns: [210, 510, 710, 1010],
    rows: staffColumnRows,
    maxDriftPixels: photoColumnDrift,
    maxAngleDegrees: (Math.atan2(photoColumnDrift, 800) * 180) / Math.PI,
  },
);
const validBefore = await resources(validCCITT),
  validAfter = await resources(
    await fs.readFile(path.join(out, "valid-ccitt-transformed.pdf")),
  );
check(
  "valid CCITT stream bytes retained",
  validBefore.ccitt.length === 1 &&
    JSON.stringify(validBefore.ccitt) === JSON.stringify(validAfter.ccitt),
);
for (const name of [
  "valid-ccitt-original.pdf",
  "valid-ccitt-transformed.pdf",
]) {
  const pdfjsGrid = inkGrid(
      (await render(await fs.readFile(path.join(out, name)), 0.5))[0],
    ),
    popplerGrid = inkGrid(await popplerCanvas(name)),
    diff = gridDifference(pdfjsGrid, popplerGrid);
  check(
    `valid CCITT cross-engine agreement: ${name}`,
    diff.mean < 0.015 && diff.max < 0.06,
    { difference: diff },
  );
}
const outputManifests = [];
for (const name of pdfs) {
  const digest = hash(await fs.readFile(path.join(out, name))),
    operation = operations.findLast((v) => v.outputSha256 === digest);
  outputManifests.push({
    file: name,
    sha256: digest,
    ...(operation ?? {
      kind: name.includes("phone")
        ? "manual photo perspective / image embedding"
        : name === "review.pdf"
          ? "review layout from comparison image artifacts"
          : "source fixture or unchanged external source",
    }),
  });
}
await save(
  "correction-manifests.json",
  JSON.stringify(
    {
      operations,
      outputs: outputManifests,
      photo: {
        manualCorners: corners,
        outputSize: [1200, 1600],
        input: "phone-photo-flawed.pdf",
        output: "phone-photo-corrected.pdf",
      },
    },
    null,
    2,
  ),
);
const report = {
  createdAt: new Date().toISOString(),
  results,
  limitations: [
    "Existing repository CCITT fixture is malformed: its generator concatenates independent TIFF strips; both engines lose content differently. Baseline retained for defect detection, not accepted as fidelity evidence. Valid single-strip proof fixture now has spatial content and cross-engine checks.",
    "Editing pre-rotated pages, nonzero media-box origins or crop boxes different from media boxes is rejected explicitly; unchanged PDF pass-through still preserves these bytes.",

    "Manual iPad and iPhone review pending; no application integration authorized before approval.",
    "Automatic alignment is proven only on controlled same-layout synthetic pages; differing real book layouts need manual review.",
    "Perspective correction uses manually selected known corners; automatic page boundary capture is unproven.",
    "Synthetic shadow retained to protect fine marks; blur/glare recovery is excluded.",
    "No actual iPhone capture or browser worker memory gate completed; Node tool proof only.",
    "IMSLP sample used normal browser disclaimer and waiting flow; direct backend download not proven.",
  ],
  peakRSSMiB: process.resourceUsage().maxRSS / 1024,
  elapsedSeconds: process.uptime(),
};
await save("report.json", JSON.stringify(report, null, 2));
await save(
  "index.html",
  `<!doctype html><meta charset="utf-8"><title>Noted score intake proof</title><style>body{background:#f5f2e9;color:#202820;font:18px Georgia;margin:2rem auto;max-width:1100px}a{color:#234e3b}.pair{display:flex;gap:1rem}figure{width:48%;margin:0}img{max-width:100%}section{border-top:1px solid #bbb;margin-top:3rem}li{margin:.5rem}</style><h1>Score intake: tool-only proof</h1><p>Review at playing size on iPad. No app code changed. <a href="review.pdf">Comparison booklet</a> · <a href="corrected-score.pdf">Corrected sample score</a> · <a href="report.json">Full measurements</a></p><h2>Checks</h2><ul>${results.map((r) => `<li>${r.pass === true ? "PASS" : r.pass === false ? "FAIL" : "PENDING"}: ${r.name}</li>`).join("")}</ul><h2>Limits and pending checks</h2><ul>${report.limitations.map((l) => `<li>${l}</li>`).join("")}</ul>${html.join("")}<h2>Small details: original and photo correction</h2><img src="detail-0.png"><img src="detail-1.png">`,
);
console.log(
  JSON.stringify(
    {
      out,
      checks: results.length,
      failed: results.filter((r) => r.pass === false),
      elapsedSeconds: report.elapsedSeconds,
      peakRSSMiB: report.peakRSSMiB,
    },
    null,
    2,
  ),
);
if (results.some((r) => r.pass === false)) process.exitCode = 1;
