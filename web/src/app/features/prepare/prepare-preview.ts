import { signal } from '@angular/core';
import { errorMessage } from '../../core/api.service';
import { ImportAsset, PageEdit } from '../../core/models';
import { measureAsync } from '../../core/performance';
import {
  PreparedPageCache,
  ProcessingResponse,
  ProcessingWorkerClient,
  isProcessingStopped,
  preparedPhotoKey,
} from './prepare-processing';
import { PageRenderer } from './prepare-rendering';
import type { PrepareStore } from './prepare.store';

/**
 * The selected page's preview and the worker behind it: it renders the preview,
 * prepares photo pages in the background while the user is idle, and keeps those
 * prepared pages until a save or an edit makes them stale.
 */
export class PreparePreview {
  /** The preview image URL; empty until a page has rendered. */
  readonly url = signal('');
  readonly compare = signal(false);
  readonly edgeAspect = signal(0.75);
  /** Draws thumbnails and previews; it reads the draft and selection, never changes them. */
  readonly renderer: PageRenderer;
  readonly thumbs;
  lastEditOrSelectionAt = performance.now();
  private previewTimer?: ReturnType<typeof setTimeout>;
  private backgroundTimer?: ReturnType<typeof setTimeout>;
  private previewRevision = 0;
  private objectURL = '';
  private foregroundWorker = false;
  // A classic worker: it loads pdf-lib and OpenCV from /intake with importScripts.
  private readonly workerClient = new ProcessingWorkerClient(
    () => new Worker(new URL('./processing.worker', import.meta.url), { type: 'classic' }),
  );
  private readonly preparedPages = new PreparedPageCache();
  private preparedKeysByPage = new Map<string, string>();

  constructor(private readonly store: PrepareStore) {
    this.renderer = new PageRenderer({
      draft: store.draft,
      step: store.step,
      selected: store.selected,
      error: store.error,
    });
    this.thumbs = this.renderer.thumbs;
  }

  /** True while the foreground worker run (final assembly) can be cancelled. */
  get foreground(): boolean {
    return this.foregroundWorker;
  }

  destroy(): void {
    this.invalidate();
    clearTimeout(this.previewTimer);
    clearTimeout(this.backgroundTimer);
    this.renderer.destroy();
    this.workerClient.destroy();
    this.preparedPages.clear();
    this.revokeURL();
  }

  /** Stops the running worker request; the caller reports the cancellation. */
  cancelWorker(): void {
    this.workerClient.cancel();
    this.foregroundWorker = false;
  }

  takePrepared(key: string): ArrayBuffer | undefined {
    return this.preparedPages.take(key);
  }

  invalidate(): void {
    ++this.previewRevision;
    clearTimeout(this.previewTimer);
    clearTimeout(this.backgroundTimer);
    this.renderer.cancelPdfPreview();
    if (this.workerClient.activeRequest && (!this.store.busy() || this.store.transfer.uploading)) {
      this.workerClient.supersede();
      this.foregroundWorker = false;
      this.store.progress.set('');
      this.store.transfer.syncCancellable();
    }
  }

  /** An edit invalidates the preview now and renders the new one after a short pause. */
  schedule(): void {
    this.lastEditOrSelectionAt = performance.now();
    this.invalidate();
    this.reconcileKeys();
    clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => void this.render(), 250);
  }

  setCompare(value: boolean): void {
    if (this.store.busy()) return;
    this.compare.set(value);
    void this.render();
  }

  async runWorker(
    payload: Record<string, unknown>,
    foreground = false,
    transfer: Transferable[] = [],
  ): Promise<ProcessingResponse> {
    this.foregroundWorker = foreground;
    this.store.transfer.syncCancellable();
    try {
      return await this.workerClient.run(payload, {
        transfer,
        onProgress: foreground ? (progress) => this.store.progress.set(progress) : undefined,
      });
    } finally {
      if (foreground) {
        this.foregroundWorker = false;
        this.store.transfer.syncCancellable();
      }
    }
  }

  async render(): Promise<void> {
    const store = this.store;
    clearTimeout(this.previewTimer);
    if (store.busy() && !store.transfer.uploading) return;
    this.invalidate();
    const revision = this.previewRevision,
      page = store.page ? structuredClone(store.page) : undefined;
    if (!page) {
      this.url.set('');
      return;
    }
    try {
      const plain =
        this.compare() ||
        store.edges.handles() ||
        (!page.angle &&
          !page.rotation &&
          !page.scale &&
          !page.x &&
          !page.y &&
          !page.crop &&
          !page.corners &&
          !page.outputWidth &&
          !page.paperCleanup &&
          !page.paperCleanupStrength &&
          !page.fitEdges &&
          !page.margins?.some(Boolean));
      const source = store.source;
      if (source?.mime.startsWith('image/')) {
        const raster = await this.renderer.selectedDisplayRaster(page, source);
        if (revision !== this.previewRevision || store.destroyed) return;
        if (plain) {
          this.revokeURL();
          this.edgeAspect.set(raster.width / raster.height);
          this.url.set(raster.url);
          this.scheduleBackgroundPrepare(page, source, revision);
        } else if (this.supportsRasterPreview(page)) {
          const response = await measureAsync('noted.intake.preview', () =>
            this.runWorker({ kind: 'preview', raster: raster.blob, edit: page, maxEdge: 1050 }),
          );
          if (revision !== this.previewRevision || store.destroyed || !response.blob) return;
          this.revokeURL();
          this.objectURL = URL.createObjectURL(response.blob);
          this.edgeAspect.set((response.width || 1) / (response.height || 1));
          this.url.set(this.objectURL);
          this.scheduleBackgroundPrepare(page, source, revision);
        } else {
          await this.renderAuthoritative(page, revision);
          if (revision === this.previewRevision && !store.destroyed)
            this.scheduleBackgroundPrepare(page, source, revision);
        }
        return;
      }
      let canvas: HTMLCanvasElement;
      if (plain) {
        canvas = await this.renderer.sourceCanvas(page, 1050);
      } else {
        await this.renderAuthoritative(page, revision);
        return;
      }
      if (revision === this.previewRevision && !store.destroyed) {
        this.edgeAspect.set(canvas.width / canvas.height);
        this.revokeURL();
        this.url.set(canvas.toDataURL('image/png'));
      }
      canvas.width = canvas.height = 1;
    } catch (e) {
      if (revision === this.previewRevision && !isProcessingStopped(e))
        store.error.set(errorMessage(e));
    }
  }

  /** Drops prepared pages that no page in the draft references any more. */
  reconcileKeys(): void {
    const current = new Map<string, string>();
    for (const page of this.store.draft()?.manifest.pages ?? []) {
      const key = this.currentPreparedKey(page);
      if (!key) continue;
      current.set(page.id, key);
    }
    const referenced = new Set(current.values());
    for (const key of this.preparedKeysByPage.values())
      if (!referenced.has(key)) this.preparedPages.delete(key);
    this.preparedKeysByPage = current;
  }

  private supportsRasterPreview(page: PageEdit): boolean {
    const crop = page.crop;
    const corners = page.corners;
    if (crop?.length && corners?.length) return false;
    if (crop && (crop.length !== 4 || crop.some((value) => !Number.isFinite(value)))) return false;
    if (
      corners &&
      (corners.length !== 4 ||
        corners.some(
          (point) => point.length !== 2 || point.some((value) => !Number.isFinite(value)),
        ))
    )
      return false;
    return ![page.outputWidth, page.outputHeight].some(
      (value) => value !== undefined && (!Number.isFinite(value) || value <= 0),
    );
  }

  private async renderAuthoritative(page: PageEdit, revision: number): Promise<void> {
    const d = this.store.draft()!;
    const response = await measureAsync('noted.intake.preview', () =>
      this.runWorker({
        kind: 'build',
        draftId: d.id,
        sources: d.sources,
        manifest: { version: 1, pages: [page] },
      }),
    );
    if (revision !== this.previewRevision || this.store.destroyed || !response.bytes) return;
    await this.renderer.renderPdfPreview(response.bytes, (canvas) => {
      if (revision !== this.previewRevision || this.store.destroyed) return;
      this.edgeAspect.set(canvas.width / canvas.height);
      this.revokeURL();
      this.url.set(canvas.toDataURL('image/png'));
    });
  }

  private scheduleBackgroundPrepare(page: PageEdit, source: ImportAsset, revision: number): void {
    clearTimeout(this.backgroundTimer);
    const key = preparedPhotoKey(source, page);
    if (this.preparedPages.has(key)) return;
    const remainingIdleDelay = Math.max(0, 750 - (performance.now() - this.lastEditOrSelectionAt));
    this.backgroundTimer = setTimeout(() => {
      void this.prepareInBackground(page, source, key, revision);
    }, remainingIdleDelay);
  }

  private async prepareInBackground(
    page: PageEdit,
    source: ImportAsset,
    key: string,
    revision: number,
  ): Promise<void> {
    const store = this.store;
    if (
      store.destroyed ||
      store.busy() ||
      this.previewRevision !== revision ||
      store.page?.id !== page.id ||
      store.source?.checksum !== source.checksum ||
      !store.page ||
      this.currentPreparedKey(store.page) !== key
    )
      return;
    try {
      const d = store.draft()!;
      const response = await measureAsync('noted.intake.background-prepare', () =>
        this.runWorker({
          kind: 'build',
          draftId: d.id,
          sources: d.sources,
          manifest: { version: 1, pages: [page] },
        }),
      );
      if (
        response.bytes &&
        !store.destroyed &&
        this.previewRevision === revision &&
        store.page?.id === page.id &&
        this.currentPreparedKey(store.page) === key
      )
        this.preparedPages.set(key, response.bytes);
    } catch (error) {
      // Background preparation is opportunistic. Save will process a cache miss.
      if (!isProcessingStopped(error)) console.warn('Background page preparation failed.', error);
    }
  }

  private currentPreparedKey(page: PageEdit): string | undefined {
    const d = this.store.draft();
    const source = d?.sources.find((item) => item.id === page.sourceId);
    return source?.mime.startsWith('image/') ? preparedPhotoKey(source, page) : undefined;
  }

  private revokeURL(): void {
    if (!this.objectURL) return;
    URL.revokeObjectURL(this.objectURL);
    this.objectURL = '';
  }
}
