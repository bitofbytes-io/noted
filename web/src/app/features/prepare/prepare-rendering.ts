import { Signal, WritableSignal, signal } from '@angular/core';
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist';
import { errorMessage } from '../../core/api.service';
import { ImportAsset, ImportDraft, PageEdit } from '../../core/models';
import { measureAsync } from '../../core/performance';
import { ProcessingStoppedError, isProcessingStopped } from './prepare-processing';
GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';

export type PrepareStep = 'source' | 'pages' | 'details';

/** The Prepare state the renderer reads; it never changes the draft. */
export interface PageRendererView {
  readonly draft: Signal<ImportDraft | null>;
  readonly step: Signal<PrepareStep>;
  readonly selected: Signal<number>;
  readonly error: WritableSignal<string>;
}

interface DisplayRaster {
  key: string;
  blob: Blob;
  url: string;
  width: number;
  height: number;
}

interface ThumbnailRequest {
  revision: number;
  key: string;
  ids: Set<string>;
  pages: PageEdit[];
}

/**
 * Draws Prepare's page images: source pages from PDFs and photos, the selected
 * photo's display raster, prepared-page previews, and the thumbnail rail. It owns
 * the object URLs and PDF.js documents it creates and releases them on destroy.
 */
export class PageRenderer {
  /** Thumbnail object URLs by page id, for the pages near the viewport. */
  readonly thumbs = signal<Record<string, string>>({});
  private destroyed = false;
  private previewTask?: ReturnType<typeof getDocument>;
  private thumbnailRevision = 0;
  private thumbnailRequest?: ThumbnailRequest;
  private thumbnailPump?: Promise<void>;
  private pdfTasks = new Map<string, { task: ReturnType<typeof getDocument>; users: number }>();
  private displayRaster?: DisplayRaster;
  private displayRasterLoad?: {
    key: string;
    promise: Promise<DisplayRaster>;
    controller: AbortController;
  };

  constructor(private readonly view: PageRendererView) {}

  private get page(): PageEdit | undefined {
    return this.view.draft()?.manifest.pages[this.view.selected()];
  }

  private get source() {
    return this.view.draft()?.sources.find((a) => a.id === this.page?.sourceId);
  }

  destroy() {
    this.destroyed = true;
    this.cancelPdfPreview();
    this.thumbnailRevision++;
    this.thumbnailRequest = undefined;
    for (const entry of this.pdfTasks.values()) void entry.task.destroy();
    this.pdfTasks.clear();
    this.releaseDisplayRaster();
    this.revokeThumbnails();
  }

  async sourceCanvas(page: PageEdit, width = 1000): Promise<HTMLCanvasElement> {
    const d = this.view.draft()!,
      asset = d.sources.find((a) => a.id === page.sourceId)!;
    const url = `/api/imports/${d.id}/sources/${asset.id}`,
      canvas = document.createElement('canvas');
    if (asset.mime === 'application/pdf') {
      let entry = this.pdfTasks.get(asset.id);
      if (!entry) entry = { task: getDocument({ url, wasmUrl: '/pdfjs/wasm/' }), users: 0 };
      this.pdfTasks.delete(asset.id);
      this.pdfTasks.set(asset.id, entry);
      entry.users++;
      const task = entry.task;
      try {
        const pdf = await task.promise,
          p = await pdf.getPage(page.page + 1),
          base = p.getViewport({ scale: 1 }),
          viewport = p.getViewport({ scale: Math.min(width / base.width, 2) });
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await p.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise;
      } catch (error) {
        this.pdfTasks.delete(asset.id);
        await task.destroy();
        throw error;
      } finally {
        entry.users--;
        for (const [id, cached] of this.pdfTasks) {
          if (this.pdfTasks.size <= 3) break;
          if (cached.users) continue;
          this.pdfTasks.delete(id);
          void cached.task.destroy();
        }
      }
    } else {
      const response = await fetch(url);
      if (!response.ok) throw Error('Photo could not be loaded.');
      const bitmap = await createImageBitmap(await response.blob());
      const scale = Math.min(1, width / bitmap.width);
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
    }
    return canvas;
  }

  /**
   * Renders the first page of prepared PDF bytes at preview size. `show` receives
   * the canvas while it is still drawn; it is cleared afterwards.
   */
  async renderPdfPreview(
    bytes: ArrayBuffer,
    show: (canvas: HTMLCanvasElement) => void,
  ): Promise<void> {
    const task = getDocument({
      data: new Uint8Array(bytes),
      wasmUrl: '/pdfjs/wasm/',
    });
    this.previewTask = task;
    let canvas: HTMLCanvasElement | undefined;
    try {
      const pdf = await task.promise,
        p = await pdf.getPage(1),
        base = p.getViewport({ scale: 1 }),
        v = p.getViewport({ scale: Math.min(2, 1050 / base.width) });
      canvas = document.createElement('canvas');
      canvas.width = Math.ceil(v.width);
      canvas.height = Math.ceil(v.height);
      await p.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport: v }).promise;
      show(canvas);
    } finally {
      if (this.previewTask === task) this.previewTask = undefined;
      await task.destroy();
      if (canvas) canvas.width = canvas.height = 1;
    }
  }

  /** Stops a prepared-page preview that is still loading or drawing. */
  cancelPdfPreview(): void {
    if (!this.previewTask) return;
    void this.previewTask.destroy().catch(() => {});
    this.previewTask = undefined;
  }

  /** The selected photo, decoded once at display size and kept until another page shows. */
  async selectedDisplayRaster(page: PageEdit, source: ImportAsset): Promise<DisplayRaster> {
    const key = `${source.checksum}:${page.page}`;
    if (this.displayRaster?.key === key) return this.displayRaster;
    if (this.displayRasterLoad?.key === key) return this.displayRasterLoad.promise;
    this.releaseDisplayRaster();
    const controller = new AbortController();
    const promise = measureAsync('noted.intake.source-decode', async () => {
      const d = this.view.draft()!;
      const response = await fetch(`/api/imports/${d.id}/sources/${source.id}`, {
        signal: controller.signal,
      });
      if (!response.ok) throw Error('Photo could not be loaded.');
      const bitmap = await createImageBitmap(await response.blob());
      const scale = Math.min(1, 1050 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      try {
        const context = canvas.getContext('2d')!;
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      } finally {
        bitmap.close();
      }
      const blob = await this.canvasBlob(canvas);
      const result = {
        key,
        blob,
        url: URL.createObjectURL(blob),
        width: canvas.width,
        height: canvas.height,
      };
      canvas.width = canvas.height = 1;
      return result;
    });
    this.displayRasterLoad = { key, promise, controller };
    try {
      const raster = await promise;
      if (this.destroyed || this.source !== source || this.page?.page !== page.page) {
        URL.revokeObjectURL(raster.url);
        throw new ProcessingStoppedError('superseded');
      }
      this.displayRaster = raster;
      return raster;
    } finally {
      if (this.displayRasterLoad?.promise === promise) this.displayRasterLoad = undefined;
    }
  }

  /** Releases the held display raster when the page about to show uses another one. */
  keepDisplayRasterFor(key: string): void {
    if (this.displayRaster && key !== this.displayRaster.key) this.releaseDisplayRaster();
  }

  releaseDisplayRaster(): void {
    this.displayRasterLoad?.controller.abort();
    this.displayRasterLoad = undefined;
    if (!this.displayRaster) return;
    URL.revokeObjectURL(this.displayRaster.url);
    this.displayRaster = undefined;
  }

  /** Forgets one page's thumbnail so the rail draws it again. */
  dropThumbnail(id: string): void {
    this.thumbs.update((t) => {
      const next = { ...t };
      if (next[id]) URL.revokeObjectURL(next[id]);
      delete next[id];
      return next;
    });
  }

  async renderThumbnails(container?: HTMLElement) {
    if (this.destroyed) return;
    const d = this.view.draft();
    if (!d) return;
    const visibleIDs = this.thumbnailIDs(d, container);
    const selectedPage = d.manifest.pages[this.view.selected()];
    const visiblePages = d.manifest.pages.filter((page) => visibleIDs.has(page.id));
    const visible = selectedPage
      ? [selectedPage, ...visiblePages.filter((page) => page.id !== selectedPage.id)]
      : visiblePages;
    this.thumbs.update((current) => {
      const next = { ...current };
      for (const [id, url] of Object.entries(next)) {
        if (visibleIDs.has(id)) continue;
        URL.revokeObjectURL(url);
        delete next[id];
      }
      return next;
    });
    const key = visible
      .map((page) => {
        const source = d.sources.find((item) => item.id === page.sourceId);
        return `${page.id}:${source?.checksum ?? page.sourceId}:${page.page}`;
      })
      .join('|');
    if (this.thumbnailRequest?.key !== key) {
      this.thumbnailRequest = {
        revision: ++this.thumbnailRevision,
        key,
        ids: visibleIDs,
        pages: visible.map((page) => structuredClone(page)),
      };
    }
    if (!this.thumbnailPump) {
      const pump = this.pumpThumbnails();
      this.thumbnailPump = pump;
      void pump.finally(() => {
        if (this.thumbnailPump === pump) this.thumbnailPump = undefined;
      });
    }
    await this.thumbnailPump;
  }

  private async pumpThumbnails(): Promise<void> {
    let attemptedRevision = -1;
    let attempted = new Set<string>();
    while (!this.destroyed) {
      const request = this.thumbnailRequest;
      if (!request) return;
      if (request.revision !== attemptedRevision) {
        attemptedRevision = request.revision;
        attempted = new Set<string>();
      }
      const page = request.pages.find(
        (candidate) => !this.thumbs()[candidate.id] && !attempted.has(candidate.id),
      );
      if (!page) {
        if (this.thumbnailRequest === request) return;
        continue;
      }
      attempted.add(page.id);
      let canvas: HTMLCanvasElement | undefined;
      try {
        canvas = await this.thumbnailCanvas(page);
        const latest = this.thumbnailRequest;
        if (this.destroyed || latest?.revision !== request.revision || !latest.ids.has(page.id))
          continue;
        const blob = await this.canvasBlob(canvas, 'image/jpeg', 0.8);
        const current = this.thumbnailRequest;
        if (this.destroyed || current?.revision !== request.revision || !current.ids.has(page.id))
          continue;
        const url = URL.createObjectURL(blob);
        this.thumbs.update((thumbs) => ({ ...thumbs, [page.id]: url }));
      } catch (e) {
        if (
          !this.destroyed &&
          !isProcessingStopped(e) &&
          !(e instanceof DOMException && e.name === 'AbortError') &&
          this.thumbnailRequest?.revision === request.revision
        )
          this.view.error.set(errorMessage(e));
      } finally {
        if (canvas) canvas.width = canvas.height = 1;
      }
    }
  }

  private thumbnailIDs(d: ImportDraft, container?: HTMLElement): Set<string> {
    const ids = new Set<string>();
    const step = this.view.step();
    if (step === 'source') return ids;
    const selected = d.manifest.pages[this.view.selected()];
    if (selected) ids.add(selected.id);
    if (step === 'details') {
      for (const page of d.manifest.pages.slice(0, 3)) ids.add(page.id);
      return ids;
    }
    if (container) {
      const root = container.getBoundingClientRect();
      if (root.width > 0 && root.height > 0) {
        for (const element of container.querySelectorAll<HTMLElement>('[data-thumbnail-id]')) {
          const bounds = element.getBoundingClientRect();
          if (
            bounds.right >= root.left - 140 &&
            bounds.left <= root.right + 140 &&
            bounds.bottom >= root.top - 140 &&
            bounds.top <= root.bottom + 140
          )
            ids.add(element.dataset['thumbnailId']!);
        }
        return ids;
      }
    }
    const first = Math.max(0, this.view.selected() - 3);
    for (const page of d.manifest.pages.slice(first, first + 7)) ids.add(page.id);
    return ids;
  }

  private async canvasBlob(
    canvas: HTMLCanvasElement,
    type = 'image/png',
    quality?: number,
  ): Promise<Blob> {
    return new Promise((resolve, reject) =>
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(Error('Page image could not be created.'))),
        type,
        quality,
      ),
    );
  }

  private async thumbnailCanvas(page: PageEdit): Promise<HTMLCanvasElement> {
    const source = this.view.draft()?.sources.find((item) => item.id === page.sourceId);
    if (!source?.mime.startsWith('image/') || this.page?.id !== page.id)
      return this.sourceCanvas(page, 140);
    const raster = await this.selectedDisplayRaster(page, source);
    const bitmap = await createImageBitmap(raster.blob);
    const scale = Math.min(1, 140 / bitmap.width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    try {
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    } finally {
      bitmap.close();
    }
    return canvas;
  }

  private revokeThumbnails(): void {
    for (const url of Object.values(this.thumbs())) URL.revokeObjectURL(url);
    this.thumbs.set({});
  }
}
