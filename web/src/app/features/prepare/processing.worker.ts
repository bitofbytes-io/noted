/// <reference lib="webworker" />
// Heavy score processing runs here; terminate the worker to cancel at any point.
//
// This is a classic worker (see ProcessingWorkerClient in prepare-processing.ts):
// pdf-lib and OpenCV are the UMD and Emscripten builds the app copies to /intake,
// loaded with importScripts, which module workers do not support. Only their types
// are imported here, so the Angular build bundles no library code into the worker.
import type * as PDFLibModule from 'pdf-lib';
import type { PDFDocument, PDFEmbeddedPage, PDFPage } from 'pdf-lib';
import type * as PDFJSModule from 'pdfjs-dist';
import type { ImportAsset, PageEdit } from '../../core/models';
import {
  Edges,
  MeasuredPage,
  alignToReference,
  cleanupStrength,
  inkOutsidePage,
  isPlain,
  needsGeometry,
  pageLayout,
} from './processing-algorithms';
import { analyze, openCV } from './processing-opencv';
import { photoPDF, previewRaster } from './processing-photo';

declare const self: DedicatedWorkerGlobalScope;
// The global pdf-lib's script defines. Referring to it by name, rather than through
// `self`, also stops the minifier from giving a bundled function its name, which
// importScripts would then overwrite.
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
