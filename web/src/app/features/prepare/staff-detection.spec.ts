import { describe, expect, it } from 'vitest';
import { analyzeImage, analyzeStaff, grayscale } from './staff-detection';

const width = 100,
  height = 60;

/** A white page with dark full-width rows between top and bottom. */
const staffPage = (top: number, bottom: number) => {
  const gray = new Uint8Array(width * height).fill(255);
  for (let y = top; y <= bottom; y += 4) gray.fill(0, y * width + 10, y * width + 90);
  return gray;
};

/** A small RGBA page image: white, with `ink` pixels painted black. */
function pageImage(ink: (x: number, y: number) => boolean) {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (ink(x, y)) data.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3);
  return { data, width, height };
}

/** Five staff lines, four rows apart, from x = 10 to 89, tilted by `slope` rows per column. */
const staffInk =
  (top: number, slope = 0) =>
  (x: number, y: number) =>
    x >= 10 && x < 90 && [0, 1, 2, 3, 4].some((n) => y === Math.round(top + n * 4 + x * slope));

describe('staff detection', () => {
  describe('grayscale', () => {
    it('weights red, green and blue like OpenCV and ignores alpha', () => {
      const data = new Uint8ClampedArray([
        255, 0, 0, 0, 0, 255, 0, 255, 0, 0, 255, 9, 255, 255, 255, 255,
      ]);
      expect(Array.from(grayscale({ data, width: 4, height: 1 }))).toEqual([76, 150, 29, 255]);
    });
  });

  describe('analyzeStaff', () => {
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

  describe('analyzeImage', () => {
    const levelLines = () => Array(12).fill(0);

    it('hands the grey page to the line finder and bounds a level staff', () => {
      const image = pageImage(staffInk(20));
      let seen: [number, number, number] | undefined;
      const result = analyzeImage(image, (gray, w, h) => {
        seen = [gray.length, w, h];
        expect(gray[20 * width + 50]).toBe(0);
        expect(gray[21 * width + 50]).toBe(255);
        return levelLines();
      });
      expect(seen).toEqual([width * height, width, height]);
      expect(result).toEqual({ confident: true, angle: 0, bounds: [0.1, 20 / 60, 0.89, 36 / 60] });
    });

    it('leaves out sparse text above and below the staff', () => {
      const staff = staffInk(20),
        title = (x: number, y: number) => y === 4 && x >= 40 && x < 50,
        footer = (x: number, y: number) => y === 55 && x >= 40 && x < 50;
      const result = analyzeImage(
        pageImage((x, y) => staff(x, y) || title(x, y) || footer(x, y)),
        levelLines,
      );
      expect(result.bounds).toEqual([0.1, 20 / 60, 0.89, 36 / 60]);
    });

    it('reports the tilt of a skewed staff and measures it in straightened rows', () => {
      const slope = Math.tan((2 * Math.PI) / 180),
        result = analyzeImage(pageImage(staffInk(10, slope)), () => Array(12).fill(2));
      expect(result.confident).toBe(true);
      expect(result.angle).toBe(2);
      // Every tilted line is still found whole, so the bounds span the page tilt too.
      expect(result.bounds![0]).toBe(0.1);
      expect(result.bounds![2]).toBe(0.89);
      expect(result.bounds![1]).toBeLessThanOrEqual(10 / 60 + 0.02);
      expect(result.bounds![3]).toBeGreaterThanOrEqual((26 + 79 * slope) / 60 - 0.02);
    });

    it('does not guess when the finder sees no consistent lines', () => {
      expect(analyzeImage(pageImage(staffInk(20)), () => [])).toMatchObject({
        confident: false,
        reason: 'No consistent staff lines found. Adjust this page manually.',
      });
    });

    it('does not guess on a blank page', () => {
      expect(
        analyzeImage(
          pageImage(() => false),
          levelLines,
        ),
      ).toMatchObject({
        confident: false,
        reason: 'Staff boundaries were unclear. Adjust this page manually.',
      });
    });
  });
});
