import test from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, degrees } from "pdf-lib";
import {
  processPDF,
  validateManifest,
  suggestGeometry,
  perspective,
  inkBounds,
} from "./processor.mjs";
import { detailScore } from "./fixtures.mjs";
import { render, pixels } from "./render.mjs";
const source = await detailScore();
test("reject invalid PDF without touching immutable input", async () => {
  const before = source.slice();
  await assert.rejects(
    processPDF([new Uint8Array([1, 2, 3])], {
      version: 1,
      pages: [{ source: 0, page: 0 }],
    }),
  );
  assert.deepEqual(source, before);
});
test("reject invalid manifests, source indexes and transforms", () => {
  for (const m of [
    null,
    { version: 2, pages: [] },
    { version: 1, pages: [] },
    { version: 1, pages: [{ source: 0, page: 3 }] },
    { version: 1, pages: [{ source: -1, page: 0 }] },
    { version: 1, pages: [{ source: 0, page: 0, angle: NaN }] },
    { version: 1, pages: [{ source: 0, page: 0, scale: 0 }] },
  ])
    assert.throws(() => validateManifest(m, [3]));
});
test("reject crop that clips content", async () => {
  await assert.rejects(
    processPDF([source], {
      version: 1,
      pages: [{ source: 0, page: 0, width: 100, height: 100 }],
    }),
    /clip/,
  );
});
test("expanded arbitrary rotation preserves page and reset bytes", async () => {
  const out = await processPDF([source], {
    version: 1,
    pages: [{ source: 0, page: 0, angle: 5 }],
  });
  const doc = await PDFDocument.load(out);
  assert.ok(doc.getPage(0).getWidth() > 600);
  const manifest = {
    version: 1,
    pages: [0, 1, 2].map((page) => ({ source: 0, page })),
  };
  assert.deepEqual(await processPDF([source], manifest), source);
});
test("blank and nonstaff image abstain", () => {
  const width = 600,
    height = 800,
    data = new Uint8ClampedArray(width * height * 4).fill(255);
  assert.equal(suggestGeometry({ width, height, data }).confident, false);
  for (let x = 20; x < 500; x++) {
    const i = (50 * width + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = 0;
  }
  assert.equal(suggestGeometry({ width, height, data }).confident, false);
});
test("independent pixel analysis detects original staff lines", async () => {
  const suggestion = suggestGeometry(pixels((await render(source, 2))[0]));
  assert.equal(suggestion.confident, true);
  assert.ok(Math.abs(suggestion.angle) < 0.25);
});
test("invalid manual perspective corners fail explicitly", () => {
  assert.throws(() =>
    perspective(
      { width: 1, height: 1, data: new Uint8ClampedArray(4) },
      [[NaN, 0]],
      10,
      10,
    ),
  );
});
test("reset after reorder returns original ordering and repeated edits do not mutate source", async () => {
  const before = source.slice();
  await processPDF([source], {
    version: 1,
    pages: [
      { source: 0, page: 2 },
      { source: 0, page: 0 },
    ],
  });
  await processPDF([source], {
    version: 1,
    pages: [{ source: 0, page: 1, angle: -3 }],
  });
  assert.deepEqual(source, before);
  assert.deepEqual(
    await processPDF([source], {
      version: 1,
      pages: [0, 1, 2].map((page) => ({ source: 0, page })),
    }),
    before,
  );
});
test("reject unsupported operations and degenerate perspective", () => {
  assert.throws(() =>
    validateManifest(
      { version: 1, pages: [{ source: 0, page: 0, crop: "ignored" }] },
      [3],
    ),
  );
  assert.throws(() =>
    perspective(
      { width: 10, height: 10, data: new Uint8ClampedArray(400) },
      [
        [0, 0],
        [1, 1],
        [2, 2],
        [3, 3],
      ],
      10,
      10,
    ),
  );
});

test("bounds retain faint antialiased staff endpoints outside dark noteheads", () => {
  const width = 100,
    height = 40,
    data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let x = 5; x < 95; x++) {
    const i = (10 * width + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = 180;
  }
  const center = (10 * width + 50) * 4;
  data[center] = data[center + 1] = data[center + 2] = 0;
  assert.deepEqual(inkBounds({ width, height, data }), [5, 10, 95, 11]);
});

test("non-noop transforms reject existing rotation and crop geometry without losing source bytes", async () => {
  for (const apply of [
    (p) => p.setRotation(degrees(90)),
    (p) => p.setCropBox(10, 20, 500, 650),
    (p) => p.setMediaBox(10, 20, 600, 800),
  ]) {
    const d = await PDFDocument.load(source);
    apply(d.getPage(0));
    const bytes = await d.save();
    await assert.rejects(
      processPDF([bytes], {
        version: 1,
        pages: [{ source: 0, page: 0, angle: 1 }],
      }),
      /Unsupported source page geometry/,
    );
    assert.deepEqual(
      await processPDF([bytes], {
        version: 1,
        pages: [0, 1, 2].map((page) => ({ source: 0, page })),
      }),
      bytes,
    );
  }
});

test("spatial coverage detects missing lower staves and black-block corruption", async () => {
  const { inkGrid, gridDifference } = await import("./measurements.mjs");
  const width = 800,
    height = 800,
    source = new Uint8ClampedArray(width * height * 4).fill(255);
  for (const start of [100, 300, 500, 650])
    for (let line = 0; line < 5; line++)
      for (let y = start + line * 7; y < start + line * 7 + 3; y++)
        for (let x = 100; x < 700; x++)
          for (let k = 0; k < 3; k++) source[(y * width + x) * 4 + k] = 0;
  const reference = inkGrid({ width, height, data: source });
  const truncated = source.slice();
  truncated.fill(255, width * 400 * 4);
  assert.ok(
    gridDifference(reference, inkGrid({ width, height, data: truncated })).max >
      0.06,
  );
  const corrupt = source.slice();
  corrupt.fill(0, width * 400 * 4);
  assert.ok(
    gridDifference(reference, inkGrid({ width, height, data: corrupt })).mean >
      0.015,
  );
  assert.deepEqual(
    gridDifference(reference, inkGrid({ width, height, data: source })),
    { mean: 0, max: 0 },
  );
});
