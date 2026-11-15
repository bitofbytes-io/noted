// OpenCV.js as the processing worker uses it. The library itself is the Emscripten
// build the app copies to /intake and loads with importScripts, so only its types
// are declared here and the Angular build bundles none of it.
import { StaffSuggestion, analyzeImage } from './staff-detection';

// The subset of OpenCV.js this worker calls; `cv` is the global its script defines.
export interface Mat {
  rows: number;
  data: Uint8Array<ArrayBuffer>;
  data32S: Int32Array;
  delete(): void;
}
export interface OpenCV {
  Mat: {
    new (): Mat;
    new (rows: number, cols: number, type: number): Mat;
    ones(rows: number, cols: number, type: number): Mat;
  };
  Size: new (width: number, height: number) => unknown;
  Scalar: new (...values: number[]) => unknown;
  CV_8U: number;
  CV_8UC1: number;
  CV_32FC2: number;
  COLOR_RGBA2GRAY: number;
  BORDER_REPLICATE: number;
  BORDER_CONSTANT: number;
  INTER_CUBIC: number;
  matFromImageData(image: ImageData): Mat;
  matFromArray(rows: number, cols: number, type: number, values: number[]): Mat;
  cvtColor(src: Mat, dst: Mat, code: number): void;
  Canny(src: Mat, dst: Mat, low: number, high: number): void;
  HoughLinesP(
    src: Mat,
    lines: Mat,
    rho: number,
    theta: number,
    threshold: number,
    minLength: number,
    maxGap: number,
  ): void;
  dilate(src: Mat, dst: Mat, kernel: Mat): void;
  GaussianBlur(
    src: Mat,
    dst: Mat,
    size: unknown,
    sigmaX: number,
    sigmaY: number,
    border: number,
  ): void;
  resize(src: Mat, dst: Mat, size: unknown, fx: number, fy: number, interpolation: number): void;
  getPerspectiveTransform(src: Mat, dst: Mat): Mat;
  warpPerspective(
    src: Mat,
    dst: Mat,
    matrix: Mat,
    size: unknown,
    interpolation: number,
    border: number,
    value: unknown,
  ): void;
  onRuntimeInitialized?: () => void;
}

// The global the script defines. Referring to it by name, rather than through `self`,
// also stops the minifier from giving a bundled function the name `cv`, which
// importScripts would then overwrite.
declare const cv: OpenCV;

// The worker scope's importScripts, typed without the webworker lib: this module is
// also compiled with the app's DOM lib.
const scope = globalThis as unknown as { importScripts(...urls: string[]): void };

let cvReady: Promise<void> | undefined;
/** Loads OpenCV once and resolves when its runtime is ready. */
export function openCV(): Promise<void> {
  if (!cvReady)
    cvReady = new Promise((resolve, reject) => {
      try {
        scope.importScripts('/intake/opencv.js');
        if (cv.Mat) resolve();
        else cv.onRuntimeInitialized = () => resolve();
      } catch (error) {
        reject(error);
      }
    });
  return cvReady;
}

/** The angle, in degrees, of each long line Hough finds on a grey page. */
function lineAngles(grayPixels: Uint8Array, width: number, height: number): number[] {
  const gray = new cv.Mat(height, width, cv.CV_8UC1),
    edges = new cv.Mat(),
    lines = new cv.Mat();
  try {
    gray.data.set(grayPixels);
    cv.Canny(gray, edges, 60, 160);
    cv.HoughLinesP(edges, lines, 1, Math.PI / 3600, 80, width * 0.3, 12);
    const angles: number[] = [];
    for (let i = 0; i < lines.rows; i++) {
      const [x1, y1, x2, y2] = lines.data32S.slice(i * 4, i * 4 + 4);
      angles.push((Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI);
    }
    return angles;
  } finally {
    [gray, edges, lines].forEach((m) => m.delete());
  }
}

/** Reads the staff angle and bounds of a page image; call after `openCV` resolves. */
export function analyze(image: ImageData): StaffSuggestion {
  return analyzeImage(image, lineAngles);
}
