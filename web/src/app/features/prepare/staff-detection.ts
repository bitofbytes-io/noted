// Staff detection on a page image: the pure half of straighten-and-crop suggestions.
// Only finding near-level line angles needs OpenCV (processing-opencv.ts), which
// passes that step in, so the rest runs in both the worker and the unit tests.

export interface StaffSuggestion {
  confident: boolean;
  angle?: number;
  bounds?: number[];
  reason?: string;
}

type Pixels = Pick<ImageData, 'data' | 'width' | 'height'>;

/** The grey levels of an RGBA image, weighted like OpenCV's RGBA2GRAY. */
export function grayscale(image: Pixels): Uint8Array {
  const { data } = image,
    gray = new Uint8Array(image.width * image.height);
  for (let i = 0; i < gray.length; i++)
    gray[i] = Math.round(0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]);
  return gray;
}

/**
 * Reads the staff angle and bounds of a page image. `findAngles` returns the angle, in
 * degrees, of each long line it finds on the grey page (a Hough transform).
 */
export function analyzeImage(
  image: Pixels,
  findAngles: (gray: Uint8Array, width: number, height: number) => number[],
): StaffSuggestion {
  const { width, height } = image,
    gray = grayscale(image);
  return analyzeStaff(findAngles(gray, width, height), gray, width, height);
}

/**
 * Suggests a straighten angle and staff bounds from near-horizontal line angles
 * (degrees, from a Hough transform) and the grey page they were found on.
 */
export function analyzeStaff(
  angles: number[],
  gray: ArrayLike<number>,
  width: number,
  height: number,
): StaffSuggestion {
  const candidates = angles.filter((angle) => Math.abs(angle) <= 10);
  if (candidates.length < 10)
    return {
      confident: false,
      reason: 'No consistent staff lines found. Adjust this page manually.',
    };
  candidates.sort((a, b) => a - b);
  const angle = candidates[Math.floor(candidates.length / 2)],
    agree = candidates.filter((other) => Math.abs(other - angle) < 0.3);
  if (agree.length < candidates.length * 0.8)
    return { confident: false, reason: 'The page has mixed angles. Adjust it manually.' };
  // Hough determines the angle, but can omit an outer staff line. Measure all
  // dense staff rows in deskewed coordinates, excluding sparse title/footer text.
  const radians = (angle * Math.PI) / 180,
    cos = Math.cos(radians),
    sin = Math.sin(radians),
    rows = new Uint32Array(height + width * 2);
  const row = (x: number, y: number) => Math.round(y * cos - x * sin) + width;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) if (gray[y * width + x] < 200) rows[row(x, y)]++;
  let left = width,
    top = height,
    right = 0,
    bottom = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (gray[y * width + x] >= 200) continue;
      const n = row(x, y);
      if (rows[n - 1] + rows[n] + rows[n + 1] < width * 0.25) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  if (right <= left || bottom <= top)
    return {
      confident: false,
      reason: 'Staff boundaries were unclear. Adjust this page manually.',
    };
  return {
    confident: true,
    angle,
    bounds: [left / width, top / height, right / width, bottom / height],
  };
}
