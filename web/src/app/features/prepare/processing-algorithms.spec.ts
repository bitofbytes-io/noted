import { describe, expect, it } from 'vitest';
import { PageEdit } from '../../core/models';
import {
  alignToReference,
  analyzeStaff,
  cleanupStrength,
  fittedQuadSize,
  inkOutsidePage,
  isPlain,
  jpegOrientation,
  lightenPixels,
  needsGeometry,
  orientationMatrix,
  pageLayout,
  photoWorkSize,
} from './processing-algorithms';

const page = (edit: Partial<PageEdit> = {}): PageEdit => ({
  id: 'page',
  sourceId: 'source',
  page: 0,
  ...edit,
});

/** A JPEG: SOI, an optional APP1 segment, then SOS. */
function jpeg(app1?: number[]): ArrayBuffer {
  const bytes = [0xff, 0xd8];
  if (app1) bytes.push(0xff, 0xe1, (app1.length + 2) >> 8, (app1.length + 2) & 0xff, ...app1);
  bytes.push(0xff, 0xda, 0x00, 0x02);
  return new Uint8Array(bytes).buffer;
}

/** An EXIF APP1 payload with one orientation entry. */
function exif(orientation: number, little = false, type = 3, count = 1): number[] {
  const u16 = (n: number) => (little ? [n & 0xff, n >> 8] : [n >> 8, n & 0xff]);
  const u32 = (n: number) =>
    little
      ? [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24]
      : [n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  return [
    ...[0x45, 0x78, 0x69, 0x66, 0, 0], // "Exif\0\0"
    ...(little ? [0x49, 0x49] : [0x4d, 0x4d]),
    ...u16(42),
    ...u32(8), // first IFD right after the TIFF header
    ...u16(1),
    ...u16(0x112),
    ...u16(type),
    ...u32(count),
    ...u16(orientation),
    0,
    0,
    ...u32(0),
  ];
}

describe('processing algorithms', () => {
  it('treats only an unedited page as plain and as needing no new canvas', () => {
    expect(isPlain(page())).toBe(true);
    expect(isPlain(page({ scale: 1, margins: [0, 0, 0, 0], crop: [], corners: [] }))).toBe(true);
    expect(needsGeometry(page({ scale: 1, rotation: 90 }))).toBe(false);
    for (const edit of [
      { angle: 0.5 },
      { scale: 1.2 },
      { x: 0.1 },
      { y: 0.1 },
      { crop: [0, 0, 1, 0.9] },
      { outputWidth: 600 },
      { fitEdges: true },
      { margins: [0, 4, 0, 0] },
    ]) {
      expect(isPlain(page(edit))).toBe(false);
      expect(needsGeometry(page(edit))).toBe(true);
    }
    // Rotation, corners and paper cleanup change the page without a new canvas.
    for (const edit of [
      { rotation: 90 },
      { corners: [[0, 0]] },
      { paperCleanupStrength: 0.3 },
      { paperCleanup: true },
    ]) {
      expect(isPlain(page(edit))).toBe(false);
      expect(needsGeometry(page(edit))).toBe(false);
    }
  });

  it('reads cleanup strength from the slider, falling back to the legacy switch', () => {
    expect(cleanupStrength(page())).toBe(0);
    expect(cleanupStrength(page({ paperCleanup: true }))).toBe(1);
    expect(cleanupStrength(page({ paperCleanup: true, paperCleanupStrength: 0 }))).toBe(0);
    expect(cleanupStrength(page({ paperCleanupStrength: 0.4 }))).toBe(0.4);
  });

  it('reads the EXIF orientation of a JPEG in either byte order', () => {
    expect(jpegOrientation(jpeg(exif(6)))).toBe(6);
    expect(jpegOrientation(jpeg(exif(8, true)))).toBe(8);
    expect(jpegOrientation(jpeg())).toBe(1);
    expect(jpegOrientation(jpeg(exif(1)))).toBe(1);
  });

  it('refuses malformed EXIF instead of guessing an orientation', () => {
    expect(jpegOrientation(new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer)).toBeUndefined();
    expect(jpegOrientation(jpeg(exif(9)))).toBeUndefined();
    expect(jpegOrientation(jpeg(exif(6, false, 4)))).toBeUndefined();
    expect(jpegOrientation(jpeg(exif(6, false, 3, 2)))).toBeUndefined();
    const truncated = new Uint8Array(jpeg(exif(6))).slice(0, 20).buffer;
    expect(jpegOrientation(truncated)).toBeUndefined();
    const badOrder = exif(6);
    badOrder[6] = badOrder[7] = 0x41;
    expect(jpegOrientation(jpeg(badOrder))).toBeUndefined();
  });

  it('draws every EXIF orientation upright on the displayed page', () => {
    const w = 40,
      h = 30;
    for (let orientation = 1; orientation <= 8; orientation++) {
      const [a, b, c, d, e, f] = orientationMatrix(orientation, w, h);
      const corners = [
        [0, 0],
        [w, 0],
        [0, h],
        [w, h],
      ].map(([x, y]) => [a * x + c * y + e, b * x + d * y + f]);
      const xs = corners.map(([x]) => x),
        ys = corners.map(([, y]) => y);
      const swapped = orientation >= 5;
      expect([Math.min(...xs), Math.min(...ys)]).toEqual([0, 0]);
      expect([Math.max(...xs), Math.max(...ys)]).toEqual(swapped ? [h, w] : [w, h]);
    }
  });

  it('bounds the photo working canvas by pixels and edge length', () => {
    expect(photoWorkSize(1200, 1600)).toEqual([1200, 1600]);
    const [width, height] = photoWorkSize(6000, 4000);
    expect(width * height).toBeLessThanOrEqual(4_000_000);
    expect(width / height).toBeCloseTo(1.5, 2);
    expect(photoWorkSize(5000, 400)).toEqual([2800, 224]);
    expect(photoWorkSize(1050, 700, 1050 * 1050, 1050)).toEqual([1050, 700]);
    // A thin strip keeps at least one pixel across.
    expect(photoWorkSize(10_000_000, 1)[1]).toBe(1);
  });

  it('straightens a perspective quad to the mean lengths of its opposite sides', () => {
    const full = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    expect(fittedQuadSize(full, 1001, 801)).toEqual([1000, 800]);
    const trapezoid = [
      [0.1, 0],
      [0.9, 0],
      [1, 1],
      [0, 1],
    ];
    expect(fittedQuadSize(trapezoid, 1001, 801)[0]).toBe(900);
    expect(fittedQuadSize(full, 2, 2)).toEqual([2, 2]);
  });

  it('lightens paper towards white without touching alpha or dark ink', () => {
    const pixels = new Uint8ClampedArray([100, 160, 200, 77, 10, 10, 10, 255]);
    lightenPixels(pixels, [200, 200, 200, 0, 200, 200, 200, 0], 1);
    expect(Array.from(pixels)).toEqual([128, 204, 255, 77, 13, 13, 13, 255]);

    const half = new Uint8ClampedArray([100, 100, 100, 255]);
    lightenPixels(half, [200, 200, 200, 255], 0.5);
    expect(Array.from(half)).toEqual([114, 114, 114, 255]);

    // A dark background is clamped so shadows are not blown out.
    const shadow = new Uint8ClampedArray([40, 40, 40, 255]);
    lightenPixels(shadow, [20, 20, 20, 255], 1);
    expect(Array.from(shadow)).toEqual([128, 128, 128, 255]);

    const untouched = new Uint8ClampedArray([100, 150, 200, 255]);
    lightenPixels(untouched, [10, 10, 10, 10], 0);
    expect(Array.from(untouched)).toEqual([100, 150, 200, 255]);
  });

  describe('pageLayout', () => {
    it('keeps an unadjusted page in place', () => {
      const layout = pageLayout(600, 800, page());
      expect([layout.outputWidth, layout.outputHeight, layout.scale, layout.angle]).toEqual([
        600, 800, 1, 0,
      ]);
      expect(layout.transform(0, 0)).toEqual([0, 0]);
      expect(layout.transform(600, 800)).toEqual([600, 800]);
      expect(layout.center).toEqual([300, 400]);
    });

    it('turns the page for a quarter rotation and adds margins outside it', () => {
      const layout = pageLayout(600, 800, page({ rotation: 90, margins: [10, 20, 30, 40] }));
      expect([layout.baseWidth, layout.baseHeight]).toEqual([800, 600]);
      expect([layout.outputWidth, layout.outputHeight]).toEqual([860, 640]);
      const [x, y] = layout.transform(0, 0);
      expect(x).toBeCloseTo(40 + 800);
      expect(y).toBeCloseTo(30);
    });

    it('fits the rotated bounds and ignores the fixed canvas when fitting edges', () => {
      const layout = pageLayout(
        600,
        800,
        page({ fitEdges: true, angle: 90, scale: 2, x: 0.3, y: 0.3, outputWidth: 10 }),
      );
      expect(layout.scale).toBe(1);
      expect(layout.outputWidth).toBeCloseTo(800);
      expect(layout.outputHeight).toBeCloseTo(600);
      expect(layout.center[0]).toBeCloseTo(400);
      expect(layout.center[1]).toBeCloseTo(300);
    });

    it('scales and moves the page on a fixed canvas', () => {
      const layout = pageLayout(
        600,
        800,
        page({ scale: 0.5, x: 0.1, y: 0.25, outputWidth: 1000, outputHeight: 1000 }),
      );
      expect([layout.outputWidth, layout.outputHeight]).toEqual([1000, 1000]);
      expect(layout.center).toEqual([600, 250]);
      expect(layout.transform(600, 800)).toEqual([750, 450]);
    });
  });

  describe('inkOutsidePage', () => {
    /** A 4×4 white render with one black pixel at (x, y). */
    const render = (x: number, y: number) => {
      const data = new Uint8ClampedArray(4 * 4 * 4).fill(255);
      data.set([0, 0, 0, 255], (y * 4 + x) * 4);
      return data;
    };
    const identity = (x: number, y: number): [number, number] => [x, y];
    const doubled = (x: number, y: number): [number, number] => [x * 2, y * 2];

    it('passes ink that stays on the output page', () => {
      expect(inkOutsidePage(render(3, 0), 4, 4, 100, 100, [0, 0, 1, 1], identity, 100, 100)).toBe(
        false,
      );
      // Faint or transparent pixels are not ink.
      const faint = new Uint8ClampedArray(64).fill(255);
      faint.set([210, 210, 210, 255], 0);
      faint.set([0, 0, 0, 100], 4);
      expect(inkOutsidePage(faint, 4, 4, 100, 100, [0, 0, 1, 1], doubled, 100, 100)).toBe(false);
    });

    it('catches ink the adjustment would push off the page', () => {
      expect(inkOutsidePage(render(3, 0), 4, 4, 100, 100, [0, 0, 1, 1], doubled, 100, 100)).toBe(
        true,
      );
      // Ink near the origin stays on the page at double size.
      expect(inkOutsidePage(render(0, 3), 4, 4, 100, 100, [0, 0, 1, 1], doubled, 100, 100)).toBe(
        false,
      );
    });

    it('ignores ink outside an explicit crop', () => {
      expect(inkOutsidePage(render(3, 0), 4, 4, 100, 100, [0, 0, 0.5, 1], identity, 50, 100)).toBe(
        false,
      );
    });
  });

  describe('analyzeStaff', () => {
    const width = 100,
      height = 60;
    /** A white page with dark full-width rows between top and bottom. */
    const staffPage = (top: number, bottom: number) => {
      const gray = new Uint8Array(width * height).fill(255);
      for (let y = top; y <= bottom; y += 4) gray.fill(0, y * width + 10, y * width + 90);
      return gray;
    };

    it('needs enough near-level lines that agree on one angle', () => {
      const gray = staffPage(20, 40);
      expect(analyzeStaff([0, 0.1, 45, -30], gray, width, height)).toMatchObject({
        confident: false,
        reason: 'No consistent staff lines found. Adjust this page manually.',
      });
      const mixed = [...Array(6).fill(0), ...Array(6).fill(2)];
      expect(analyzeStaff(mixed, gray, width, height)).toMatchObject({
        confident: false,
        reason: 'The page has mixed angles. Adjust it manually.',
      });
    });

    it('takes the median angle and the dense staff rows as bounds', () => {
      const angles = [0.1, 0, 0.2, 0, 0.1, 0, 0.1, 0.2, 0.1, 0, 15];
      expect(analyzeStaff(angles, staffPage(20, 40), width, height)).toEqual({
        confident: true,
        angle: 0.1,
        bounds: [0.1, 20 / 60, 0.89, 40 / 60],
      });
    });

    it('reports unclear boundaries on a blank page', () => {
      expect(
        analyzeStaff(Array(10).fill(0), new Uint8Array(width * height).fill(255), width, height),
      ).toMatchObject({
        confident: false,
        reason: 'Staff boundaries were unclear. Adjust this page manually.',
      });
    });
  });

  it('aligns a page to the reference staff bounds within the supported scale', () => {
    const reference = { angle: 0, bounds: [0.1, 0.1, 0.9, 0.9], width: 600, height: 800 };
    const edit = page({ scale: 1, x: 0, y: 0 });
    alignToReference(
      edit,
      { angle: 0, bounds: [0.2, 0.2, 0.6, 0.6], width: 600, height: 800 },
      reference,
    );
    expect(edit.scale).toBeCloseTo(2);
    expect([edit.outputWidth, edit.outputHeight]).toEqual([600, 800]);
    expect(edit.x).toBeCloseTo(0.2);
    expect(edit.y).toBeCloseTo(0.2);

    expect(() =>
      alignToReference(
        page(),
        { angle: 0, bounds: [0.45, 0.45, 0.5, 0.5], width: 600, height: 800 },
        reference,
      ),
    ).toThrow('Matching requires a scale outside the supported range.');
  });
});
