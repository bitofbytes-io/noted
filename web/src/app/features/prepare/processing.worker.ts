/// <reference lib="webworker" />
// Heavy score processing runs here; terminate the worker to cancel at any point.
//
// This is a classic worker (see ProcessingWorkerClient in prepare.component.ts):
// pdf-lib and OpenCV are the UMD and Emscripten builds the app copies to /intake,
// loaded with importScripts, which module workers do not support. Only their types
// are imported here, so the Angular build bundles no library code into the worker.
import type * as PDFLibModule from 'pdf-lib';
import type { PDFDocument, PDFEmbeddedPage, PDFPage } from 'pdf-lib';
import type * as PDFJSModule from 'pdfjs-dist';
import type { ImportAsset, PageEdit } from '../../core/models';
import {
  Edges,
  MAX_PHOTO_PIXELS,
  MeasuredPage,
  PHOTO_WORK_EDGE,
  PHOTO_WORK_PIXELS,
  StaffSuggestion,
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

// The subset of OpenCV.js this worker calls; `cv` is the global its script defines.
interface Mat {
  rows: number;
  data: Uint8Array<ArrayBuffer>;
  data32S: Int32Array;
  delete(): void;
}
interface OpenCV {
  Mat: { new (): Mat; ones(rows: number, cols: number, type: number): Mat };
  Size: new (width: number, height: number) => unknown;
  Scalar: new (...values: number[]) => unknown;
  CV_8U: number;
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

declare const self: DedicatedWorkerGlobalScope;
// The globals the two scripts define. Referring to them by name, rather than through
// `self`, also stops the minifier from giving a bundled function the name `cv`,
// which importScripts would then overwrite.
declare const cv: OpenCV;
declare const PDFLib: typeof PDFLibModule;

interface PreparedPage {
  key: string;
  bytes: ArrayBuffer;
}

interface Manifest {
  version: 1;
  pages: PageEdit[];
}

type ProcessingRequest = { requestId?: string } & (
  | {
      kind: 'match';
      draftId: string;
      sources: ImportAsset[];
      reference: PageEdit;
      targets: PageEdit[];
    }
  | { kind: 'analyze'; image: ImageData }
  | { kind: 'preview'; raster: Blob; edit: PageEdit; maxEdge?: number }
  | {
      kind?: 'build';
      draftId: string;
      sources: ImportAsset[];
      manifest: Manifest;
      prepared?: PreparedPage[];
      preparedKeys?: string[];
    }
);

self.importScripts('/intake/pdf-lib.min.js');

let cvReady: Promise<void> | undefined;
function openCV(): Promise<void> {
  if (!cvReady)
    cvReady = new Promise((resolve, reject) => {
      try {
        self.importScripts('/intake/opencv.js');
        if (cv.Mat) resolve();
        else cv.onRuntimeInitialized = () => resolve();
      } catch (error) {
        reject(error);
      }
    });
  return cvReady;
}

function analyze(image: ImageData): StaffSuggestion {
  const src = cv.matFromImageData(image),
    gray = new cv.Mat(),
    edges = new cv.Mat(),
    lines = new cv.Mat();
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.Canny(gray, edges, 60, 160);
    cv.HoughLinesP(edges, lines, 1, Math.PI / 3600, 80, image.width * 0.3, 12);
    const angles: number[] = [];
    for (let i = 0; i < lines.rows; i++) {
      const [x1, y1, x2, y2] = lines.data32S.slice(i * 4, i * 4 + 4);
      angles.push((Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI);
    }
    return analyzeStaff(angles, gray.data, image.width, image.height);
  } finally {
    [src, gray, edges, lines].forEach((m) => m.delete());
  }
}

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

async function photoPDF(bytes: ArrayBuffer, edit: PageEdit): Promise<PDFDocument> {
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

async function previewRaster(
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

/** PDF.js is the app's copy under /pdfjs, loaded at run time rather than bundled. */
const PDFJS_URL = '/pdfjs/pdf.min.mjs';

class OffscreenCanvasFactory {
  create(width: number, height: number) {
    const canvas = new OffscreenCanvas(width, height);
    return { canvas, context: canvas.getContext('2d') };
  }
  reset(target: { canvas: OffscreenCanvas }, width: number, height: number) {
    target.canvas.width = width;
    target.canvas.height = height;
  }
  destroy(target: { canvas: OffscreenCanvas | null; context: unknown }) {
    target.canvas!.width = target.canvas!.height = 1;
    target.canvas = null;
    target.context = null;
  }
}

// Render the exact same PDF used by preview/export. Coordinates stay in PDF points.
async function renderPDF(
  bytes: ArrayBuffer,
  pageIndex = 0,
): Promise<{ canvas: OffscreenCanvas; width: number; height: number }> {
  const pdfjs: typeof PDFJSModule = await import(PDFJS_URL);
  pdfjs.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes.slice(0)),
    wasmUrl: '/pdfjs/wasm/',
    CanvasFactory: OffscreenCanvasFactory,
    disableFontFace: true,
  } as Parameters<typeof pdfjs.getDocument>[0]);
  try {
    const doc = await task.promise,
      page = await doc.getPage(pageIndex + 1),
      base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({
      scale: Math.min(2, 2000 / Math.max(base.width, base.height)),
    });
    const canvas = new OffscreenCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await page.render({
      canvas,
      canvasContext: canvas.getContext('2d'),
      viewport,
    } as unknown as Parameters<typeof page.render>[0]).promise;
    return { canvas, width: base.width, height: base.height };
  } finally {
    await task.destroy();
  }
}

async function checkInk(
  bytes: ArrayBuffer,
  index: number,
  edges: Edges,
  transform: (x: number, y: number) => [number, number],
  outputWidth: number,
  outputHeight: number,
): Promise<void> {
  const rendered = await renderPDF(bytes, index),
    c = rendered.canvas;
  try {
    const { data } = c.getContext('2d')!.getImageData(0, 0, c.width, c.height);
    // Explicit crop removes only pixels outside the chosen rectangle.
    if (
      inkOutsidePage(
        data,
        c.width,
        c.height,
        rendered.width,
        rendered.height,
        edges,
        transform,
        outputWidth,
        outputHeight,
      )
    )
      throw Error(
        'This adjustment would cut off page content. Reduce scale or position, or explicitly crop the unwanted content first.',
      );
  } finally {
    c.width = c.height = 1;
  }
}

interface LoadedSource {
  bytes: ArrayBuffer;
  doc: PDFDocument;
}

async function build(
  draftId: string,
  sources: ImportAsset[],
  manifest: Manifest,
  prepared: PreparedPage[] = [],
  preparedKeys: string[] = [],
  requestId?: string,
): Promise<ArrayBuffer> {
  const sourceMap = new Map(sources.map((a) => [a.id, a]));
  const preparedMap = new Map(prepared.map((item) => [item.key, item.bytes]));
  async function read(id: string): Promise<ArrayBuffer> {
    const response = await fetch(`/api/imports/${draftId}/sources/${id}`, {
      credentials: 'same-origin',
    });
    if (!response.ok) throw Error('Source could not be loaded. Reload the draft.');
    return response.arrayBuffer();
  }
  if (!manifest.pages.length) throw Error('Choose at least one page.');
  const first = sourceMap.get(manifest.pages[0].sourceId)!;
  if (
    !prepared.length &&
    first.mime === 'application/pdf' &&
    manifest.pages.length === first.pageCount &&
    manifest.pages.every((p, i) => p.sourceId === first.id && p.page === i && isPlain(p))
  ) {
    return read(first.id);
  }
  const out = await PDFLib.PDFDocument.create(),
    pdfSources = new Map<string, LoadedSource>(),
    remaining = new Map<string, number>();
  for (const p of manifest.pages) remaining.set(p.sourceId, (remaining.get(p.sourceId) || 0) + 1);
  for (let i = 0; i < manifest.pages.length; i++) {
    const edit = manifest.pages[i],
      asset = sourceMap.get(edit.sourceId);
    if (!asset) throw Error('Unknown source.');
    if (cleanupStrength(edit) && asset.mime === 'application/pdf')
      throw Error('Lighten paper is available for photos only.');
    self.postMessage({
      requestId,
      progress: `Preparing page ${i + 1} of ${manifest.pages.length}`,
    });
    const preparedBytes = preparedMap.get(preparedKeys[i]);
    if (preparedBytes) {
      const preparedDoc = await PDFLib.PDFDocument.load(preparedBytes, { updateMetadata: false });
      if (preparedDoc.getPageCount() !== 1)
        throw Error('A prepared page is invalid. Reopen the draft and try again.');
      remaining.set(asset.id, remaining.get(asset.id)! - 1);
      const [copy] = await out.copyPages(preparedDoc, [0]);
      out.addPage(copy);
      continue;
    }
    const isPDF = asset.mime === 'application/pdf';
    let source = pdfSources.get(asset.id);
    if (!source) {
      const bytes = await read(asset.id);
      source = {
        bytes,
        doc: isPDF
          ? await PDFLib.PDFDocument.load(bytes, { updateMetadata: false })
          : await photoPDF(bytes, edit),
      };
      if (isPDF) pdfSources.set(asset.id, source);
    }
    const { doc } = source,
      original: PDFPage = doc.getPage(isPDF ? edit.page : 0);
    remaining.set(asset.id, remaining.get(asset.id)! - 1);
    if (!remaining.get(asset.id)) pdfSources.delete(asset.id); // release after this page

    if (!needsGeometry(edit)) {
      const [copy] = await out.copyPages(doc, [isPDF ? edit.page : 0]);
      copy.setRotation(PDFLib.degrees((copy.getRotation().angle + (edit.rotation || 0)) % 360));
      out.addPage(copy);
      continue;
    }
    const media = original.getMediaBox(),
      crop = original.getCropBox();
    if (
      original.getRotation().angle % 360 ||
      media.x ||
      media.y ||
      (['x', 'y', 'width', 'height'] as const).some((k) => crop[k] !== media[k])
    )
      throw Error(
        'This PDF already has a page rotation or crop. Reorder, extract and quarter-turn rotation are supported; fine adjustments need a normalized source PDF.',
      );
    const edges = edit.crop || [0, 0, 1, 1],
      w = media.width,
      h = media.height;
    const embed: PDFEmbeddedPage = await out.embedPage(original, {
      left: edges[0] * w,
      bottom: (1 - edges[3]) * h,
      right: edges[2] * w,
      top: (1 - edges[1]) * h,
    });
    const width = embed.width,
      height = embed.height,
      layout = pageLayout(width, height, edit);
    if (!edit.fitEdges)
      await checkInk(
        isPDF ? source.bytes : ((await doc.save()).buffer as ArrayBuffer),
        isPDF ? edit.page : 0,
        edges,
        layout.transform,
        layout.outputWidth,
        layout.outputHeight,
      );
    const origin = layout.transform(0, 0);
    out.addPage([layout.outputWidth, layout.outputHeight]).drawPage(embed, {
      x: origin[0],
      y: origin[1],
      xScale: layout.scale,
      yScale: layout.scale,
      rotate: PDFLib.degrees(layout.angle),
    });
  }
  return (await out.save()).buffer as ArrayBuffer;
}

async function measure(
  draftId: string,
  sources: ImportAsset[],
  edit: PageEdit,
): Promise<MeasuredPage> {
  const rendered = await renderPDF(await build(draftId, sources, { version: 1, pages: [edit] }));
  try {
    await openCV();
    const c = rendered.canvas,
      result = analyze(c.getContext('2d')!.getImageData(0, 0, c.width, c.height));
    if (!result.confident) throw Error(result.reason);
    return {
      angle: result.angle!,
      bounds: result.bounds!,
      width: rendered.width,
      height: rendered.height,
    };
  } finally {
    rendered.canvas.width = rendered.canvas.height = 1;
  }
}

async function matchPages(
  draftId: string,
  sources: ImportAsset[],
  referenceEdit: PageEdit,
  targets: PageEdit[],
): Promise<PageEdit[]> {
  const reference = await measure(draftId, sources, referenceEdit),
    pages: PageEdit[] = [];
  for (const target of targets) {
    const edit = { ...target };
    // Correct residual skew in the adjusted page before measuring physical alignment.
    let m = await measure(draftId, sources, edit);
    edit.angle = (edit.angle || 0) + m.angle - reference.angle;
    m = await measure(draftId, sources, edit);
    alignToReference(edit, m, reference);
    await build(draftId, sources, { version: 1, pages: [edit] }); // Same clipping guard as export.
    pages.push(edit);
  }
  return pages;
}

self.onmessage = async ({ data }: MessageEvent<ProcessingRequest>) => {
  const requestId = data.requestId;
  try {
    if (data.kind === 'match') {
      self.postMessage({
        requestId,
        result: await matchPages(data.draftId, data.sources, data.reference, data.targets),
      });
      return;
    }
    if (data.kind === 'analyze') {
      await openCV();
      self.postMessage({ requestId, result: analyze(data.image) });
      return;
    }
    if (data.kind === 'preview') {
      const result = await previewRaster(data.raster, data.edit, data.maxEdge);
      self.postMessage({ requestId, ...result });
      return;
    }
    const bytes = await build(
      data.draftId,
      data.sources,
      data.manifest,
      data.prepared,
      data.preparedKeys,
      requestId,
    );
    self.postMessage({ requestId, bytes }, [bytes]);
  } catch (error) {
    self.postMessage({ requestId, error: error instanceof Error ? error.message : String(error) });
  }
};
