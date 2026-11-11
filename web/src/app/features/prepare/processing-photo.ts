// Turns a photographed page into a PDF page, and draws the preview of one. This runs
// in the processing worker; pdf-lib and OpenCV are the globals its importScripts
// calls define, so only their types are imported here.
import type * as PDFLibModule from 'pdf-lib';
import type { PDFDocument } from 'pdf-lib';
import type { PageEdit } from '../../core/models';
import {
  MAX_PHOTO_PIXELS,
  PHOTO_WORK_EDGE,
  PHOTO_WORK_PIXELS,
  cleanupStrength,
  fittedQuadSize,
  jpegOrientation,
  lightenPixels,
  orientationMatrix,
  pageLayout,
  photoWorkSize,
} from './processing-algorithms';
import { Mat, OpenCV, openCV } from './processing-opencv';

declare const cv: OpenCV;
declare const PDFLib: typeof PDFLibModule;

async function jpegPDF(bytes: ArrayBuffer, orientation: number): Promise<PDFDocument> {
  const doc = await PDFLib.PDFDocument.create(),
    img = await doc.embedJpg(bytes),
    w = img.width,
    h = img.height;
  if (w * h > MAX_PHOTO_PIXELS) throw Error('Photo exceeds 20 megapixels.');
  const swapped = orientation >= 5,
    dw = swapped ? h : w,
    dh = swapped ? w : h,
    s = 600 / dw;
  const [a, b, c, d, e, f] = orientationMatrix(orientation, w, h).map((n) => n * s);
  const page = doc.addPage([dw * s, dh * s]);
  page.pushOperators(
    PDFLib.pushGraphicsState(),
    PDFLib.concatTransformationMatrix(a, b, c, d, e, f),
  );
  page.drawImage(img, { x: 0, y: 0, width: w, height: h });
  page.pushOperators(PDFLib.popGraphicsState());
  await doc.flush();
  return doc;
}

async function lightenPaper(canvas: OffscreenCanvas, strength: number): Promise<void> {
  await openCV();
  const width = canvas.width,
    height = canvas.height,
    ratio = Math.min(1, 720 / width, 960 / height);
  const smallCanvas = new OffscreenCanvas(
    Math.max(1, Math.round(width * ratio)),
    Math.max(1, Math.round(height * ratio)),
  );
  smallCanvas.getContext('2d')!.drawImage(canvas, 0, 0, smallCanvas.width, smallCanvas.height);
  const src = cv.matFromImageData(
    smallCanvas.getContext('2d')!.getImageData(0, 0, smallCanvas.width, smallCanvas.height),
  );
  const dilated = new cv.Mat(),
    blurred = new cv.Mat(),
    background = new cv.Mat(),
    kernel = cv.Mat.ones(31, 31, cv.CV_8U);
  try {
    // Estimate only broad paper illumination. Never threshold or erase marks.
    cv.dilate(src, dilated, kernel);
    cv.GaussianBlur(dilated, blurred, new cv.Size(0, 0), 9, 9, cv.BORDER_REPLICATE);
    cv.resize(blurred, background, new cv.Size(width, height), 0, 0, cv.INTER_CUBIC);
    const context = canvas.getContext('2d')!,
      pixels = context.getImageData(0, 0, width, height);
    lightenPixels(pixels.data, background.data, strength);
    context.putImageData(pixels, 0, 0);
  } finally {
    [src, dilated, blurred, background, kernel].forEach((m) => m.delete());
    smallCanvas.width = smallCanvas.height = 1;
  }
}

interface CorrectedPhoto {
  canvas: OffscreenCanvas;
  width: number;
  height: number;
  encodeJPEG: boolean;
}

async function correctPhoto(
  bitmap: ImageBitmap,
  edit: PageEdit,
  maxPixels = PHOTO_WORK_PIXELS,
  maxEdge = PHOTO_WORK_EDGE,
): Promise<CorrectedPhoto> {
  const strength = cleanupStrength(edit);
  let [width, height] = photoWorkSize(bitmap.width, bitmap.height, maxPixels, maxEdge);
  const canvas = new OffscreenCanvas(width, height),
    context = canvas.getContext('2d')!;
  try {
    if (strength || edit.fitEdges) {
      context.fillStyle = 'white';
      context.fillRect(0, 0, width, height);
    }
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, width, height);
  } finally {
    bitmap.close();
  }
  if (strength) await lightenPaper(canvas, strength);
  if (edit.corners?.length) {
    await openCV();
    let src: Mat | null = cv.matFromImageData(context.getImageData(0, 0, width, height));
    const dst = new cv.Mat();
    let targetWidth = width,
      targetHeight = height;
    if (edit.fitEdges)
      [targetWidth, targetHeight] = fittedQuadSize(edit.corners, width, height, maxPixels, maxEdge);
    const a = cv.matFromArray(
        4,
        1,
        cv.CV_32FC2,
        edit.corners.flatMap(([x, y]) => [x * (width - 1), y * (height - 1)]),
      ),
      b = cv.matFromArray(4, 1, cv.CV_32FC2, [
        0,
        0,
        targetWidth - 1,
        0,
        targetWidth - 1,
        targetHeight - 1,
        0,
        targetHeight - 1,
      ]),
      matrix = cv.getPerspectiveTransform(a, b);
    try {
      cv.warpPerspective(
        src,
        dst,
        matrix,
        new cv.Size(targetWidth, targetHeight),
        cv.INTER_CUBIC,
        cv.BORDER_CONSTANT,
        new cv.Scalar(255, 255, 255, 255),
      );
      src.delete();
      src = null;
      // Copy synchronously from the live wasm view, without a second RGBA clone.
      const pixels = new Uint8ClampedArray(
        dst.data.buffer,
        dst.data.byteOffset,
        dst.data.byteLength,
      );
      canvas.width = canvas.height = 1;
      canvas.width = width = targetWidth;
      canvas.height = height = targetHeight;
      context.putImageData(new ImageData(pixels, width, height), 0, 0);
    } finally {
      [src, dst, a, b, matrix].forEach((m) => m?.delete());
    }
  }
  return {
    canvas,
    width,
    height,
    encodeJPEG: strength > 0 || Boolean(edit.fitEdges && edit.corners?.length),
  };
}

/** One photographed page as a one-page PDF, with its edge, paper and orientation edits. */
export async function photoPDF(bytes: ArrayBuffer, edit: PageEdit): Promise<PDFDocument> {
  const orientation = jpegOrientation(bytes),
    strength = cleanupStrength(edit);
  if (orientation && !edit.corners?.length && !strength) return jpegPDF(bytes, orientation);
  const bitmap = await createImageBitmap(new Blob([bytes]));
  if (bitmap.width * bitmap.height > MAX_PHOTO_PIXELS) {
    bitmap.close();
    throw Error('Photo exceeds 20 megapixels.');
  }
  const corrected = await correctPhoto(bitmap, edit),
    { canvas, width, height } = corrected;
  const blob = await canvas.convertToBlob({
    type: corrected.encodeJPEG ? 'image/jpeg' : 'image/png',
    quality: 0.96,
  });
  canvas.width = canvas.height = 1;
  const doc = await PDFLib.PDFDocument.create(),
    img = corrected.encodeJPEG
      ? await doc.embedJpg(await blob.arrayBuffer())
      : await doc.embedPng(await blob.arrayBuffer());
  const w = 600,
    h = (600 * height) / width;
  doc.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
  await doc.flush();
  return doc;
}

/** A JPEG preview of an edited photo page at the size the Pages step shows it. */
export async function previewRaster(
  raster: Blob,
  edit: PageEdit,
  maxEdge = 1050,
): Promise<{ blob: Blob; width: number; height: number }> {
  const bitmap = await createImageBitmap(raster),
    corrected = await correctPhoto(bitmap, edit, maxEdge * maxEdge, maxEdge);
  const source = corrected.canvas,
    mediaWidth = 600,
    mediaHeight = (600 * corrected.height) / corrected.width;
  try {
    const edges = edit.crop || [0, 0, 1, 1],
      width = (edges[2] - edges[0]) * mediaWidth,
      height = (edges[3] - edges[1]) * mediaHeight;
    if (width <= 0 || height <= 0) throw Error('Page edges are invalid.');
    const layout = pageLayout(width, height, edit),
      ratio = maxEdge / Math.max(layout.outputWidth, layout.outputHeight);
    const output = new OffscreenCanvas(
        Math.max(1, Math.round(layout.outputWidth * ratio)),
        Math.max(1, Math.round(layout.outputHeight * ratio)),
      ),
      context = output.getContext('2d')!;
    context.fillStyle = 'white';
    context.fillRect(0, 0, output.width, output.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.translate(layout.center[0] * ratio, (layout.outputHeight - layout.center[1]) * ratio);
    context.rotate((-layout.angle * Math.PI) / 180);
    context.scale(layout.scale, layout.scale);
    context.drawImage(
      source,
      edges[0] * source.width,
      edges[1] * source.height,
      (edges[2] - edges[0]) * source.width,
      (edges[3] - edges[1]) * source.height,
      (-width * ratio) / 2,
      (-height * ratio) / 2,
      width * ratio,
      height * ratio,
    );
    const blob = await output.convertToBlob({ type: 'image/jpeg', quality: 0.92 }),
      result = { blob, width: output.width, height: output.height };
    output.width = output.height = 1;
    return result;
  } finally {
    source.width = source.height = 1;
  }
}
