// Pure geometry and pixel rules used by the processing worker (processing.worker.ts).
// Nothing here touches OpenCV, pdf-lib, canvases or the network, so it runs in
// both the worker and the unit tests.
import type { PageEdit } from '../../core/models';

export type Point = [number, number];

/** A page edge rectangle as [left, top, right, bottom] fractions of the page. */
export type Edges = number[];

export interface StaffSuggestion {
  confident: boolean;
  angle?: number;
  bounds?: number[];
  reason?: string;
}

export interface PageLayout {
  scale: number;
  angle: number;
  baseWidth: number;
  baseHeight: number;
  outputWidth: number;
  outputHeight: number;
  center: Point;
  /** Maps a point of the (cropped) source page to output page coordinates. */
  transform: (x: number, y: number) => Point;
}

/**
 * Pixel correction is bounded independently of the immutable source limit. A 4MP
 * RGBA surface is at most 16MB; several surfaces plus the decoder/wasm heap still
 * coexist. Plain JPEG embedding deliberately keeps full resolution.
 */
export const PHOTO_WORK_PIXELS = 4_000_000;
export const PHOTO_WORK_EDGE = 2800;
/** Photos above this many pixels are refused. */
export const MAX_PHOTO_PIXELS = 20_000_000;

export function cleanupStrength(edit: PageEdit): number {
  return edit.paperCleanupStrength ?? (edit.paperCleanup ? 1 : 0);
}

/** An unedited page: a PDF page is copied as it is. */
export function isPlain(edit: PageEdit): boolean {
  return (
    !edit.angle &&
    !edit.rotation &&
    (!edit.scale || edit.scale === 1) &&
    !edit.x &&
    !edit.y &&
    !edit.crop?.length &&
    !edit.corners?.length &&
    !edit.outputWidth &&
    !cleanupStrength(edit) &&
    !edit.fitEdges &&
    !edit.margins?.some(Boolean)
  );
}

/** Whether a page needs a new canvas; otherwise it is copied with only its rotation changed. */
export function needsGeometry(edit: PageEdit): boolean {
  return Boolean(
    edit.margins?.some(Boolean) ||
    edit.fitEdges ||
    edit.angle ||
    edit.x ||
    edit.y ||
    (edit.scale && edit.scale !== 1) ||
    edit.crop?.length ||
    edit.outputWidth,
  );
}

/**
 * The EXIF orientation (1-8) of a JPEG. EXIF is bounded to its APP1 segment.
 * Malformed metadata returns undefined, so the browser's decoded and oriented
 * pixels are used instead; it is never guessed from image dimensions. A JPEG
 * without EXIF orientation is 1; anything that is not a JPEG is undefined.
 */
export function jpegOrientation(bytes: ArrayBuffer): number | undefined {
  const v = new DataView(bytes);
  if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return undefined;
  let p = 2;
  while (p + 4 <= v.byteLength) {
    if (v.getUint8(p) !== 0xff) return undefined;
    const marker = v.getUint8(p + 1);
    if (marker === 0xda || marker === 0xd9) return 1;
    const length = v.getUint16(p + 2),
      end = p + 2 + length;
    if (length < 2 || end > v.byteLength) return undefined;
    if (
      marker === 0xe1 &&
      length >= 8 &&
      v.getUint32(p + 4) === 0x45786966 &&
      v.getUint16(p + 8) === 0
    ) {
      if (length < 16) return undefined; // signature plus the complete eight-byte TIFF header
      const t = p + 10,
        order = v.getUint16(t),
        little = order === 0x4949;
      if (!little && order !== 0x4d4d) return undefined;
      if (v.getUint16(t + 2, little) !== 42) return undefined;
      const ifd = t + v.getUint32(t + 4, little);
      if (ifd < t || ifd + 2 > end) return undefined;
      const count = v.getUint16(ifd, little);
      if (count > 1024 || ifd + 2 + count * 12 > end) return undefined;
      for (let n = 0; n < count; n++) {
        const q = ifd + 2 + n * 12;
        if (v.getUint16(q, little) !== 0x112) continue;
        if (v.getUint16(q + 2, little) !== 3 || v.getUint32(q + 4, little) !== 1) return undefined;
        const orientation = v.getUint16(q + 8, little);
        return orientation >= 1 && orientation <= 8 ? orientation : undefined;
      }
      return 1;
    }
    p = end;
  }
  return undefined;
}

/** The PDF matrix that draws a w×h JPEG upright for an EXIF orientation, before scaling. */
export function orientationMatrix(orientation: number, w: number, h: number): number[] {
  const matrices: Record<number, number[]> = {
    1: [1, 0, 0, 1, 0, 0],
    2: [-1, 0, 0, 1, w, 0],
    3: [-1, 0, 0, -1, w, h],
    4: [1, 0, 0, -1, 0, h],
    5: [0, -1, -1, 0, h, w],
    6: [0, -1, 1, 0, 0, w],
    7: [0, 1, 1, 0, 0, 0],
    8: [0, 1, -1, 0, h, 0],
  };
  return matrices[orientation];
}

/** The working canvas size for a photo, within the pixel and edge limits. */
export function photoWorkSize(
  width: number,
  height: number,
  maxPixels = PHOTO_WORK_PIXELS,
  maxEdge = PHOTO_WORK_EDGE,
): [number, number] {
  const ratio = Math.min(
    1,
    Math.sqrt(maxPixels / (width * height)),
    maxEdge / width,
    maxEdge / height,
  );
  return [Math.max(1, Math.floor(width * ratio)), Math.max(1, Math.floor(height * ratio))];
}

/**
 * The page size a perspective quad is straightened to when its edges are fitted:
 * the mean lengths of opposite sides, within the working limits.
 */
export function fittedQuadSize(
  corners: number[][],
  width: number,
  height: number,
  maxPixels = PHOTO_WORK_PIXELS,
  maxEdge = PHOTO_WORK_EDGE,
): [number, number] {
  const points = corners.map(([x, y]) => [x * (width - 1), y * (height - 1)]),
    distance = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const targetWidth = Math.max(
    2,
    Math.round((distance(points[0], points[1]) + distance(points[3], points[2])) / 2),
  );
  const targetHeight = Math.max(
    2,
    Math.round((distance(points[0], points[3]) + distance(points[1], points[2])) / 2),
  );
  return photoWorkSize(targetWidth, targetHeight, maxPixels, maxEdge);
}

/**
 * Lightens paper towards white against an estimated background, in place. Only
 * broad illumination is corrected; marks are never thresholded or erased.
 * `pixels` and `background` are RGBA with the same dimensions.
 */
export function lightenPixels(
  pixels: Uint8ClampedArray,
  background: ArrayLike<number>,
  strength: number,
): void {
  for (let n = 0; n < pixels.length; n += 4)
    for (let c = 0; c < 3; c++) {
      const original = pixels[n + c],
        corrected = Math.min(255, (original * 255) / Math.max(80, background[n + c]));
      pixels[n + c] = Math.round(original + (corrected - original) * strength);
    }
}

/**
 * Places a width×height source region on the output page: rotation and straighten
 * angle, scale, position and margins. Coordinates are PDF points, origin bottom left.
 */
export function pageLayout(width: number, height: number, edit: PageEdit): PageLayout {
  const scale = edit.fitEdges ? 1 : edit.scale || 1,
    angle = (edit.angle || 0) + (edit.rotation || 0),
    r = (angle * Math.PI) / 180;
  const quarter = (edit.rotation || 0) % 180 !== 0;
  const baseWidth = edit.fitEdges
    ? Math.abs(width * Math.cos(r)) + Math.abs(height * Math.sin(r))
    : edit.outputWidth || (quarter ? height : width);
  const baseHeight = edit.fitEdges
    ? Math.abs(width * Math.sin(r)) + Math.abs(height * Math.cos(r))
    : edit.outputHeight || (quarter ? width : height);
  const [mt, mr, mb, ml] = edit.margins || [0, 0, 0, 0],
    outputWidth = baseWidth + ml + mr,
    outputHeight = baseHeight + mt + mb;
  const cx = width / 2,
    cy = height / 2,
    dx = (edit.fitEdges ? 0 : edit.x || 0) * baseWidth,
    dy = -(edit.fitEdges ? 0 : edit.y || 0) * baseHeight;
  const transform = (x: number, y: number): Point => [
    ml + baseWidth / 2 + dx + scale * ((x - cx) * Math.cos(r) - (y - cy) * Math.sin(r)),
    mb + baseHeight / 2 + dy + scale * ((x - cx) * Math.sin(r) + (y - cy) * Math.cos(r)),
  ];
  return {
    scale,
    angle,
    baseWidth,
    baseHeight,
    outputWidth,
    outputHeight,
    center: transform(cx, cy),
    transform,
  };
}

/**
 * Whether any ink in a rendered page would land outside the output page. `data` is
 * the RGBA render (canvasWidth×canvasHeight) of a pageWidth×pageHeight PDF page.
 * Ink outside an explicit crop rectangle is ignored: the crop removes it on purpose.
 */
export function inkOutsidePage(
  data: ArrayLike<number>,
  canvasWidth: number,
  canvasHeight: number,
  pageWidth: number,
  pageHeight: number,
  edges: Edges,
  transform: (x: number, y: number) => Point,
  outputWidth: number,
  outputHeight: number,
): boolean {
  for (let y = 0; y < canvasHeight; y++)
    for (let x = 0; x < canvasWidth; x++) {
      const n = (y * canvasWidth + x) * 4;
      if (data[n + 3] < 128 || Math.min(data[n], data[n + 1], data[n + 2]) > 200) continue;
      const u = (x + 0.5) / canvasWidth,
        v = (y + 0.5) / canvasHeight;
      if (u < edges[0] || u > edges[2] || v < edges[1] || v > edges[3]) continue;
      const [px, py] = transform((u - edges[0]) * pageWidth, (edges[3] - v) * pageHeight);
      if (px < -0.75 || py < -0.75 || px > outputWidth + 0.75 || py > outputHeight + 0.75)
        return true;
    }
  return false;
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

export interface MeasuredPage {
  angle: number;
  bounds: number[];
  width: number;
  height: number;
}

/**
 * Scales and positions `edit` so its measured staff bounds land on the reference
 * page's, in place. Throws when that needs a scale outside (0, 3].
 */
export function alignToReference(
  edit: PageEdit,
  measured: MeasuredPage,
  reference: MeasuredPage,
): void {
  const scale =
    ((reference.bounds[2] - reference.bounds[0]) * reference.width) /
    ((measured.bounds[2] - measured.bounds[0]) * measured.width);
  const oldScale = edit.scale || 1;
  const centerX = (measured.bounds[0] - 0.5 - (edit.x || 0)) * measured.width;
  const centerY = (measured.bounds[1] - 0.5 - (edit.y || 0)) * measured.height;
  edit.scale = oldScale * scale;
  if (edit.scale > 3 || edit.scale <= 0)
    throw Error(
      'Matching requires a scale outside the supported range. Adjust this page manually.',
    );
  edit.outputWidth = reference.width;
  edit.outputHeight = reference.height;
  edit.x = reference.bounds[0] - 0.5 - (centerX * scale) / reference.width;
  edit.y = reference.bounds[1] - 0.5 - (centerY * scale) / reference.height;
}
