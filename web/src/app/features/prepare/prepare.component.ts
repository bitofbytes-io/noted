import { Component, ElementRef, OnDestroy, ViewChild, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import {
  LucideChevronDown,
  LucideChevronUp,
  LucideExternalLink,
  LucideMinus,
  LucidePlus,
} from '@lucide/angular';
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist';
import { firstValueFrom } from 'rxjs';
import { ApiService, errorMessage } from '../../core/api.service';
import { EditManifest, ImportAsset, ImportDraft, PageEdit } from '../../core/models';
import { measureAsync } from '../../core/performance';
import {
  PreparedPageCache,
  ProcessingResponse,
  ProcessingStoppedError,
  ProcessingWorkerClient,
  isProcessingStopped,
  preparedPhotoKey,
} from './prepare-processing';
GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';
interface Suggestion {
  confident: boolean;
  angle?: number;
  bounds?: number[];
  reason?: string;
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
@Component({
  selector: 'app-prepare',
  imports: [
    FormsModule,
    LucideChevronDown,
    LucideChevronUp,
    LucideExternalLink,
    LucideMinus,
    LucidePlus,
  ],
  templateUrl: './prepare.component.html',
  styleUrl: './prepare.component.scss',
})
export class PrepareComponent implements OnDestroy {
  readonly Math = Math;
  readonly steps: { id: 'source' | 'pages' | 'details'; label: string }[] = [
    { id: 'source', label: 'Source' },
    { id: 'pages', label: 'Pages' },
    { id: 'details', label: 'Details' },
  ];
  private readonly api = inject(ApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  @ViewChild('surface') surface?: ElementRef<HTMLElement>;
  @ViewChild('thumbRail') thumbRail?: ElementRef<HTMLElement>;
  readonly draft = signal<ImportDraft | null>(null);
  readonly step = signal<'source' | 'pages' | 'details'>('source');
  readonly error = signal('');
  readonly busy = signal(false);
  readonly progress = signal('');
  /** True only while cancel can stop remaining uploads or the processing worker. */
  readonly cancellable = signal(false);
  readonly saved = signal('');
  readonly preview = signal('');
  readonly thumbs = signal<Record<string, string>>({});
  readonly selected = signal(0);
  readonly compare = signal(false);
  readonly zoom = signal(1);
  readonly handles = signal<'crop' | 'corners' | null>(null);
  readonly pendingEdges = signal<number[][]>([]);
  readonly edgeReady = signal(false);
  readonly edgeAspect = signal(0.75);
  readonly edgeResetRequired = signal(false);
  private edgeCompare = false;
  private gesture = false;
  private previewTimer?: ReturnType<typeof setTimeout>;
  private backgroundTimer?: ReturnType<typeof setTimeout>;
  private dragCleanup?: () => void;
  readonly selectedIDs = signal<Set<string>>(new Set());
  readonly suggestion = signal<Suggestion | null>(null);
  imslp = '';
  readonly sourceMode = signal('all');
  rangeSourceId = '';
  rangeText = '';
  private uploadGeneration = 0;
  private readonly workerClient = new ProcessingWorkerClient(
    () => new Worker('/intake/processing-worker.js'),
  );
  private foregroundWorker = false;
  private readonly preparedPages = new PreparedPageCache();
  private preparedKeysByPage = new Map<string, string>();
  private lastEditOrSelectionAt = performance.now();
  private saveTimer?: ReturnType<typeof setTimeout>;
  private pendingSave?: Promise<void>;
  private dirty = false;
  private discarding = false;
  private destroyed = false;
  private previewRevision = 0;
  private previewTask?: ReturnType<typeof getDocument>;
  private thumbnailRevision = 0;
  private thumbnailRequest?: ThumbnailRequest;
  private thumbnailPump?: Promise<void>;
  private pdfTasks = new Map<string, { task: ReturnType<typeof getDocument>; users: number }>();
  private history: EditManifest[] = [];
  private replaceID?: string;
  private objectURL = '';
  private displayRaster?: DisplayRaster;
  private displayRasterLoad?: {
    key: string;
    promise: Promise<DisplayRaster>;
    controller: AbortController;
  };
  constructor() {
    void this.load();
  }
  get page(): PageEdit | undefined {
    return this.draft()?.manifest.pages[this.selected()];
  }
  get source() {
    return this.draft()?.sources.find((a) => a.id === this.page?.sourceId);
  }
  get isPhoto() {
    return this.source?.mime.startsWith('image/') ?? false;
  }
  get edgePoints(): number[][] {
    return this.pendingEdges();
  }
  get edgePolygon() {
    return this.edgePoints.map(([x, y]) => `${x * 100},${y * 100}`).join(' ');
  }
  get edgeShade() {
    return `M0 0H100V100H0Z M${this.edgePoints.map(([x, y]) => `${x * 100} ${y * 100}`).join('L')}Z`;
  }
  readonly marginLabels = ['Top', 'Right', 'Bottom', 'Left'];
  marginMM(index: number) {
    return Math.round((((this.page?.margins?.[index] || 0) * 25.4) / 72) * 10) / 10;
  }
  changeMargin(index: number, mm: number) {
    if (!this.page || !Number.isFinite(mm) || this.editingEdges) return;
    this.startGesture();
    const margins = [...(this.page.margins || [0, 0, 0, 0])];
    margins[index] = (Math.max(0, Math.min(50, mm)) * 72) / 25.4;
    this.page.margins = margins;
    this.changed();
  }
  get paperStrength() {
    return Math.round((this.page?.paperCleanupStrength ?? (this.page?.paperCleanup ? 1 : 0)) * 100);
  }
  get editingEdges() {
    return this.handles() !== null;
  }
  async load() {
    try {
      const id = this.route.snapshot.paramMap.get('draftId')!;
      const d = await firstValueFrom(this.api.importDraft(id));
      if (d.finalized && d.pieceId) {
        await this.router.navigate(['/reader', d.pieceId]);
        return;
      }
      this.draft.set(d);
      this.sourceMode.set(this.route.snapshot.queryParamMap.get('source') || 'all');
      this.rangeSourceId = d.sources[0]?.id || '';
      this.imslp = /^https:\/\/(www\.)?imslp\.org\/wiki\//.test(d.metadata.sourceUrl)
        ? d.metadata.sourceUrl
        : '';
      this.step.set(d.manifest.pages.length ? 'pages' : 'source');
      this.reconcilePreparedKeys();
      void this.renderThumbnails();
      setTimeout(() => void this.renderThumbnails());
      await this.renderPreview();
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }
  ngOnDestroy() {
    this.destroyed = true;
    this.invalidatePreview();
    this.dragCleanup?.();
    clearTimeout(this.previewTimer);
    clearTimeout(this.backgroundTimer);
    this.thumbnailRevision++;
    this.thumbnailRequest = undefined;
    for (const entry of this.pdfTasks.values()) void entry.task.destroy();
    this.pdfTasks.clear();
    this.workerClient.destroy();
    this.preparedPages.clear();
    clearTimeout(this.saveTimer);
    this.revokePreviewURL();
    this.revokeDisplayRaster();
    this.revokeThumbnails();
  }
  async detailsWithoutPDF() {
    const d = this.draft();
    if (!d || d.sources.length || this.busy()) return;
    this.busy.set(true);
    try {
      await this.pendingSave;
      await firstValueFrom(this.api.deleteImport(d.id));
      this.dirty = false;
      await this.router.navigate(['/'], { queryParams: { details: 'new' } });
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
  async backFromPages() {
    if (this.busy() || this.editingEdges) return;
    if (this.draft()?.pieceId) await this.close();
    else this.setStep('source');
  }
  async close() {
    if (this.busy() || this.editingEdges) return;
    this.invalidatePreview();
    try {
      await this.persist();
      await this.router.navigate(['/']);
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }
  async discard() {
    const d = this.draft();
    if (!d || this.busy() || this.editingEdges) return;
    if (!window.confirm('Discard this draft? Your saved score will remain unchanged.')) return;
    this.busy.set(true);
    this.error.set('');
    this.discarding = true;
    clearTimeout(this.saveTimer);
    this.dirty = false;
    try {
      // A failed autosave must not trap the user in a draft they chose to discard.
      await this.pendingSave?.catch(() => {});
      this.dirty = false;
      await firstValueFrom(this.api.deleteImport(d.id));
      await this.router.navigate(['/']);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.discarding = false;
      this.busy.set(false);
    }
  }
  mark() {
    if (this.discarding) return;
    this.dirty = true;
    this.saved.set('Unsaved changes');
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(
      () => void this.persist().catch((e) => this.error.set(errorMessage(e))),
      500,
    );
  }
  async persist(): Promise<void> {
    clearTimeout(this.saveTimer);
    if (this.pendingSave) {
      await this.pendingSave;
      if (this.dirty) return this.persist();
      return;
    }
    const d = this.draft();
    if (!d || !this.dirty) return;
    const snapshot = structuredClone(d);
    this.dirty = false;
    this.pendingSave = (async () => {
      try {
        const updated = await firstValueFrom(this.api.updateImport(snapshot));
        this.draft.update((current) =>
          current ? { ...current, revision: updated.revision, updatedAt: updated.updatedAt } : null,
        );
        this.saved.set(this.dirty ? 'Unsaved changes' : 'Draft saved');
      } catch (e) {
        this.dirty = !this.discarding;
        throw e;
      } finally {
        this.pendingSave = undefined;
      }
    })();
    await this.pendingSave;
  }
  remember() {
    const d = this.draft();
    if (d) {
      this.history.push(structuredClone(d.manifest));
      if (this.history.length > 30) this.history.shift();
    }
  }
  startGesture() {
    if (!this.gesture) {
      this.remember();
      this.gesture = true;
    }
  }
  endGesture() {
    this.gesture = false;
  }
  change(key: 'angle' | 'rotation', value: number, input?: HTMLInputElement) {
    if (!this.page || !Number.isFinite(value) || this.editingEdges) return;
    const requested = value;
    if (key === 'angle') value = Math.max(-10, Math.min(10, value));
    // ngModel may already hold the same clamped model value after another
    // out-of-range entry, so synchronize the native number field as well.
    if (input && value !== requested) input.value = String(value);
    this.startGesture();
    this.page[key] = value;
    if (
      !this.page.outputWidth &&
      !this.page.x &&
      !this.page.y &&
      (!this.page.scale || this.page.scale === 1)
    )
      this.page.fitEdges = true;
    this.changed();
  }
  rotate() {
    if (!this.page || this.editingEdges) return;
    this.remember();
    this.page.rotation = ((this.page.rotation || 0) + 90) % 360;
    this.changed();
    this.endGesture();
  }
  changePaperStrength(value: number) {
    if (!this.page || !this.isPhoto || this.busy() || this.editingEdges) return;
    this.startGesture();
    this.page.paperCleanupStrength = Math.max(0, Math.min(100, value)) / 100;
    this.changed();
  }
  private invalidatePreview() {
    ++this.previewRevision;
    clearTimeout(this.previewTimer);
    clearTimeout(this.backgroundTimer);
    if (this.previewTask) {
      void this.previewTask.destroy().catch(() => {});
      this.previewTask = undefined;
    }
    if (this.workerClient.activeRequest && (!this.busy() || this.uploading)) {
      this.workerClient.supersede();
      this.foregroundWorker = false;
      this.progress.set('');
      this.syncCancellable();
    }
  }
  changed() {
    this.lastEditOrSelectionAt = performance.now();
    this.invalidatePreview();
    this.draft.update((d) =>
      d ? { ...d, manifest: { ...d.manifest, pages: [...d.manifest.pages] } } : null,
    );
    this.reconcilePreparedKeys();
    this.mark();
    this.suggestion.set(null);
    clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => void this.renderPreview(), 250);
  }
  undo() {
    this.endGesture();
    const m = this.history.pop();
    if (m) {
      this.draft.update((d) => (d ? { ...d, manifest: m } : null));
      this.selected.set(Math.min(this.selected(), m.pages.length - 1));
      this.reconcilePreparedKeys();
      this.mark();
      void this.renderPreview();
      void this.renderThumbnails();
    }
  }
  resetPage() {
    if (!this.page) return;
    this.remember();
    const { id, sourceId, page } = this.page;
    this.draft()!.manifest.pages[this.selected()] = { id, sourceId, page };
    this.handles.set(null);
    this.changed();
  }
  resetAll() {
    const d = this.draft();
    if (!d) return;
    this.remember();
    d.manifest = {
      version: 1,
      pages: d.manifest.pages.map(({ id, sourceId, page }) => ({ id, sourceId, page })),
    };
    this.changed();
  }
  choose(index: number) {
    if (this.busy() || this.editingEdges) return;
    this.endGesture();
    const nextPage = this.draft()?.manifest.pages[index];
    const nextSource = this.draft()?.sources.find((source) => source.id === nextPage?.sourceId);
    if (
      this.displayRaster &&
      `${nextSource?.checksum}:${nextPage?.page}` !== this.displayRaster.key
    )
      this.revokeDisplayRaster();
    this.lastEditOrSelectionAt = performance.now();
    this.selected.set(index);
    this.handles.set(null);
    this.suggestion.set(null);
    void this.renderThumbnails();
    void this.renderPreview();
  }
  move(delta: number) {
    const pages = this.draft()?.manifest.pages,
      index = this.selected();
    if (!pages || index + delta < 0 || index + delta >= pages.length) return;
    this.remember();
    [pages[index], pages[index + delta]] = [pages[index + delta], pages[index]];
    this.selected.set(index + delta);
    this.changed();
  }
  remove() {
    const d = this.draft();
    if (!d || !this.page) return;
    this.remember();
    d.manifest.pages.splice(this.selected(), 1);
    this.selected.set(Math.max(0, Math.min(this.selected(), d.manifest.pages.length - 1)));
    this.changed();
  }
  toggle(id: string) {
    const set = new Set(this.selectedIDs());
    if (set.has(id)) set.delete(id);
    else set.add(id);
    this.selectedIDs.set(set);
  }
  keepSelected() {
    const d = this.draft(),
      ids = this.selectedIDs();
    if (!d || !ids.size) return;
    this.remember();
    d.manifest.pages = d.manifest.pages.filter((p) => ids.has(p.id));
    this.selected.set(0);
    this.changed();
  }
  private uploading = false;
  private skipRemainingUploads = false;
  async upload(event: Event, replace = false) {
    if (this.busy()) return;
    const input = event.target as HTMLInputElement,
      files = Array.from(input.files ?? []);
    input.value = '';
    if (!files.length) return;
    this.busy.set(true);
    this.error.set('');
    this.uploading = true;
    this.skipRemainingUploads = false;
    this.syncCancellable();
    const uploadGeneration = ++this.uploadGeneration;
    try {
      this.applyIMSLP();
      await this.persist();
      this.replaceID = replace ? this.page?.id : undefined;
      for (const [i, file] of files.entries()) {
        if (uploadGeneration !== this.uploadGeneration) break;
        const d = this.draft()!;
        if (file.size > d.maxFileBytes)
          throw Error(
            `${file.name} exceeds the ${Math.round(d.maxFileBytes / 1048576)} MiB file limit.`,
          );
        this.progress.set(`Adding ${i + 1} of ${files.length}: ${file.name}`);
        const oldCount = d.manifest.pages.length;
        const next = await firstValueFrom(this.api.uploadImport(d, file));
        this.draft.set(next);
        this.rangeSourceId ||= next.sources[0]?.id || '';
        if (this.replaceID) {
          const target = next.manifest.pages.findIndex((p) => p.id === this.replaceID);
          const incoming = next.sources.find(
            (source) => !d.sources.some((old) => old.id === source.id),
          );
          if (!incoming || target < 0) throw Error('Replacement source was not received.');
          next.manifest.pages = next.manifest.pages.filter((page) => page.sourceId !== incoming.id);
          next.manifest.pages[target] = { id: this.replaceID, sourceId: incoming.id, page: 0 };
          this.mark();
          await this.persist();
          const replacementID = this.replaceID;
          this.thumbs.update((t) => {
            const next = { ...t };
            if (next[replacementID!]) URL.revokeObjectURL(next[replacementID!]);
            delete next[replacementID!];
            return next;
          });
          this.revokeDisplayRaster();
          this.reconcilePreparedKeys();
          this.replaceID = undefined;
        }
        this.selected.set(Math.min(oldCount, this.draft()!.manifest.pages.length - 1));
      }
      this.setStep('pages');
      this.reconcilePreparedKeys();
      await this.renderPreview();
    } catch (e) {
      this.error.set(errorMessage(e) + ' Pages already added remain in this draft.');
    } finally {
      this.uploading = false;
      this.skipRemainingUploads = false;
      this.syncCancellable();
      this.busy.set(false);
      this.progress.set('');
    }
  }
  async sourceCanvas(page: PageEdit, width = 1000): Promise<HTMLCanvasElement> {
    const d = this.draft()!,
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
  async renderThumbnails(container = this.thumbRail?.nativeElement) {
    if (this.destroyed) return;
    const d = this.draft();
    if (!d) return;
    const visibleIDs = this.thumbnailIDs(d, container);
    const selectedPage = d.manifest.pages[this.selected()];
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
        if (!this.destroyed && this.thumbnailRequest?.revision === request.revision)
          this.error.set(errorMessage(e));
      } finally {
        if (canvas) canvas.width = canvas.height = 1;
      }
    }
  }
  thumbnailRailScrolled(event: Event): void {
    void this.renderThumbnails(event.currentTarget as HTMLElement);
  }
  private thumbnailIDs(d: ImportDraft, container?: HTMLElement): Set<string> {
    const ids = new Set<string>();
    if (this.step() === 'source') return ids;
    const selected = d.manifest.pages[this.selected()];
    if (selected) ids.add(selected.id);
    if (this.step() === 'details') {
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
    const first = Math.max(0, this.selected() - 3);
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
    const source = this.draft()?.sources.find((item) => item.id === page.sourceId);
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
  private async selectedDisplayRaster(page: PageEdit, source: ImportAsset): Promise<DisplayRaster> {
    const key = `${source.checksum}:${page.page}`;
    if (this.displayRaster?.key === key) return this.displayRaster;
    if (this.displayRasterLoad?.key === key) return this.displayRasterLoad.promise;
    this.revokeDisplayRaster();
    const controller = new AbortController();
    const promise = measureAsync('noted.intake.source-decode', async () => {
      const d = this.draft()!;
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
  private async runWorker(
    payload: Record<string, unknown>,
    foreground = false,
    transfer: Transferable[] = [],
  ): Promise<ProcessingResponse> {
    this.foregroundWorker = foreground;
    this.syncCancellable();
    try {
      return await this.workerClient.run(payload, {
        transfer,
        onProgress: foreground ? (progress) => this.progress.set(progress) : undefined,
      });
    } finally {
      if (foreground) {
        this.foregroundWorker = false;
        this.syncCancellable();
      }
    }
  }
  async renderPreview() {
    clearTimeout(this.previewTimer);
    if (this.busy() && !this.uploading) return;
    this.invalidatePreview();
    const revision = this.previewRevision,
      page = this.page ? structuredClone(this.page) : undefined;
    if (!page) {
      this.preview.set('');
      return;
    }
    try {
      const plain =
        this.compare() ||
        this.handles() ||
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
      const source = this.source;
      if (source?.mime.startsWith('image/')) {
        const raster = await this.selectedDisplayRaster(page, source);
        if (revision !== this.previewRevision || this.destroyed) return;
        if (plain) {
          this.revokePreviewURL();
          this.edgeAspect.set(raster.width / raster.height);
          this.preview.set(raster.url);
          this.scheduleBackgroundPrepare(page, source, revision);
        } else if (this.supportsRasterPreview(page)) {
          const response = await measureAsync('noted.intake.preview', () =>
            this.runWorker({ kind: 'preview', raster: raster.blob, edit: page, maxEdge: 1050 }),
          );
          if (revision !== this.previewRevision || this.destroyed || !response.blob) return;
          this.revokePreviewURL();
          this.objectURL = URL.createObjectURL(response.blob);
          this.edgeAspect.set((response.width || 1) / (response.height || 1));
          this.preview.set(this.objectURL);
          this.scheduleBackgroundPrepare(page, source, revision);
        } else {
          await this.renderAuthoritativePreview(page, revision);
          if (revision === this.previewRevision && !this.destroyed)
            this.scheduleBackgroundPrepare(page, source, revision);
        }
        return;
      }
      let canvas: HTMLCanvasElement;
      if (plain) {
        canvas = await this.sourceCanvas(page, 1050);
      } else {
        await this.renderAuthoritativePreview(page, revision);
        return;
      }
      if (revision === this.previewRevision && !this.destroyed) {
        this.edgeAspect.set(canvas.width / canvas.height);
        this.revokePreviewURL();
        this.preview.set(canvas.toDataURL('image/png'));
      }
      canvas.width = canvas.height = 1;
    } catch (e) {
      if (revision === this.previewRevision && !isProcessingStopped(e))
        this.error.set(errorMessage(e));
    }
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
  private async renderAuthoritativePreview(page: PageEdit, revision: number): Promise<void> {
    const d = this.draft()!;
    const response = await measureAsync('noted.intake.preview', () =>
      this.runWorker({
        kind: 'build',
        draftId: d.id,
        sources: d.sources,
        manifest: { version: 1, pages: [page] },
      }),
    );
    if (revision !== this.previewRevision || this.destroyed || !response.bytes) return;
    const task = getDocument({
      data: new Uint8Array(response.bytes),
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
      if (revision === this.previewRevision && !this.destroyed) {
        this.edgeAspect.set(canvas.width / canvas.height);
        this.revokePreviewURL();
        this.preview.set(canvas.toDataURL('image/png'));
      }
    } finally {
      if (this.previewTask === task) this.previewTask = undefined;
      await task.destroy();
      if (canvas) canvas.width = canvas.height = 1;
    }
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
    if (
      this.destroyed ||
      this.busy() ||
      this.previewRevision !== revision ||
      this.page?.id !== page.id ||
      this.source?.checksum !== source.checksum ||
      !this.page ||
      this.currentPreparedKey(this.page) !== key
    )
      return;
    try {
      const d = this.draft()!;
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
        !this.destroyed &&
        this.previewRevision === revision &&
        this.page?.id === page.id &&
        this.currentPreparedKey(this.page) === key
      )
        this.preparedPages.set(key, response.bytes);
    } catch (error) {
      // Background preparation is opportunistic. Save will process a cache miss.
      if (!isProcessingStopped(error)) console.warn('Background page preparation failed.', error);
    }
  }
  private currentPreparedKey(page: PageEdit): string | undefined {
    const d = this.draft();
    const source = d?.sources.find((item) => item.id === page.sourceId);
    return source?.mime.startsWith('image/') ? preparedPhotoKey(source, page) : undefined;
  }
  private reconcilePreparedKeys(): void {
    const current = new Map<string, string>();
    for (const page of this.draft()?.manifest.pages ?? []) {
      const key = this.currentPreparedKey(page);
      if (!key) continue;
      current.set(page.id, key);
    }
    const referenced = new Set(current.values());
    for (const key of this.preparedKeysByPage.values())
      if (!referenced.has(key)) this.preparedPages.delete(key);
    this.preparedKeysByPage = current;
  }
  setStep(step: 'source' | 'pages' | 'details'): void {
    this.step.set(step);
    void this.renderThumbnails();
    setTimeout(() => void this.renderThumbnails());
  }
  private revokePreviewURL(): void {
    if (!this.objectURL) return;
    URL.revokeObjectURL(this.objectURL);
    this.objectURL = '';
  }
  private revokeDisplayRaster(): void {
    this.displayRasterLoad?.controller.abort();
    this.displayRasterLoad = undefined;
    if (!this.displayRaster) return;
    URL.revokeObjectURL(this.displayRaster.url);
    this.displayRaster = undefined;
  }
  private revokeThumbnails(): void {
    for (const url of Object.values(this.thumbs())) URL.revokeObjectURL(url);
    this.thumbs.set({});
  }
  setCompare(value: boolean) {
    if (this.busy()) return;
    this.compare.set(value);
    void this.renderPreview();
  }
  async beginEdges() {
    if (this.busy() || !this.page) return;
    this.endGesture();
    this.edgeCompare = this.compare();
    this.zoom.set(1);
    this.edgeReady.set(false);
    this.edgeResetRequired.set(!!(this.page.corners?.length && this.page.crop?.length));
    const [l, t, r, b] = this.page.crop ?? [0, 0, 1, 1];
    this.pendingEdges.set(
      structuredClone(
        this.page.corners ?? [
          [l, t],
          [r, t],
          [r, b],
          [l, b],
        ],
      ),
    );
    this.handles.set(this.isPhoto ? 'corners' : 'crop');
    this.compare.set(true);
    await this.renderPreview();
    this.edgeReady.set(true);
    this.surface?.nativeElement.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  resetPendingEdges() {
    this.pendingEdges.set([
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]);
    this.edgeResetRequired.set(false);
  }
  cancelEdges() {
    this.dragCleanup?.();
    this.handles.set(null);
    this.pendingEdges.set([]);
    this.compare.set(this.edgeCompare);
    void this.renderPreview();
  }
  applyEdges() {
    if (!this.page || !this.edgeReady() || this.edgeResetRequired()) return;
    this.remember();
    const p = this.page,
      points = structuredClone(this.edgePoints);
    delete p.crop;
    delete p.corners;
    delete p.x;
    delete p.y;
    delete p.scale;
    delete p.outputWidth;
    delete p.outputHeight;
    if (this.isPhoto) p.corners = points;
    else p.crop = [points[0][0], points[0][1], points[2][0], points[2][1]];
    p.fitEdges = true;
    this.dragCleanup?.();
    this.handles.set(null);
    this.pendingEdges.set([]);
    this.compare.set(false);
    this.changed();
  }
  private setEdge(index: number, x: number, y: number, rectangle = false) {
    if (!this.edgeReady() || this.edgeResetRequired()) return;
    x = Math.max(0, Math.min(1, x));
    y = Math.max(0, Math.min(1, y));
    const points = this.edgePoints.map((p) => [...p]);
    if (this.handles() === 'crop' || rectangle) {
      const anchor = points[(index + 2) % 4],
        gap = 0.050001,
        left = index === 0 || index === 3,
        top = index < 2;
      x = left ? Math.min(x, anchor[0] - gap) : Math.max(x, anchor[0] + gap);
      y = top ? Math.min(y, anchor[1] - gap) : Math.max(y, anchor[1] + gap);
      if (x < 0 || x > 1 || y < 0 || y > 1) return;
      const l = left ? x : anchor[0],
        r = left ? anchor[0] : x,
        t = top ? y : anchor[1],
        b = top ? anchor[1] : y;
      this.pendingEdges.set([
        [l, t],
        [r, t],
        [r, b],
        [l, b],
      ]);
      return;
    }
    points[index] = [x, y];
    // Reject crossed, collapsed, or nearly collinear quads, for pointer and keyboard alike.
    for (let i = 0; i < 4; i++) {
      const a = points[i],
        b = points[(i + 1) % 4],
        c = points[(i + 2) % 4];
      if (
        Math.hypot(b[0] - a[0], b[1] - a[1]) < 0.05 ||
        (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) <= 0.0025
      )
        return;
    }
    this.pendingEdges.set(points);
  }
  dragCorner(event: PointerEvent, index: number) {
    if (this.busy() || !this.edgeReady() || !this.surface) return;
    event.preventDefault();
    this.dragCleanup?.();
    const target = event.currentTarget as HTMLElement;
    const rect = this.surface.nativeElement.querySelector('img')!.getBoundingClientRect();
    target.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) =>
      this.setEdge(
        index,
        (e.clientX - rect.left) / rect.width,
        (e.clientY - rect.top) / rect.height,
        e.shiftKey,
      );
    const cleanup = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', cleanup);
      target.removeEventListener('pointercancel', cleanup);
      target.removeEventListener('lostpointercapture', cleanup);
      if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
      this.dragCleanup = undefined;
    };
    this.dragCleanup = cleanup;
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', cleanup);
    target.addEventListener('pointercancel', cleanup);
    target.addEventListener('lostpointercapture', cleanup);
  }
  nudgeCorner(index: number, event: KeyboardEvent) {
    const delta: Record<string, number[]> = {
      ArrowLeft: [-0.01, 0],
      ArrowRight: [0.01, 0],
      ArrowUp: [0, -0.01],
      ArrowDown: [0, 0.01],
    };
    if (!delta[event.key] || !this.edgeReady()) return;
    event.preventDefault();
    const p = this.edgePoints[index],
      d = delta[event.key];
    this.setEdge(index, p[0] + d[0], p[1] + d[1], event.shiftKey);
  }
  useRange() {
    const d = this.draft();
    if (!d) return;
    const source = d.sources.find((a) => a.id === this.rangeSourceId);
    if (!source) return;
    try {
      const pages: number[] = [];
      for (const part of this.rangeText.split(',')) {
        const match = part.trim().match(/^(\d+)(?:-(\d+))?$/);
        if (!match) throw Error('Enter page numbers such as 1-4, 7.');
        const first = +match[1],
          last = +(match[2] || match[1]);
        if (first < 1 || last < first || last > source.pageCount || last - first > 99)
          throw Error('Choose a valid source range of at most 100 pages.');
        for (let n = first; n <= last; n++) pages.push(n - 1);
      }
      if (!pages.length || pages.length > 100) throw Error('Choose 1 to 100 pages.');
      this.remember();
      d.manifest = {
        version: 1,
        pages: pages.map((page) => ({ id: crypto.randomUUID(), sourceId: source.id, page })),
      };
      this.selected.set(0);
      this.changed();
      void this.renderThumbnails();
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }
  private applyIMSLP() {
    if (this.step() !== 'source' || !this.imslp.trim()) return;
    const url = new URL(this.imslp);
    if (
      url.protocol !== 'https:' ||
      !['imslp.org', 'www.imslp.org'].includes(url.host) ||
      !url.pathname.startsWith('/wiki/') ||
      url.username ||
      url.password
    )
      throw Error('Use an HTTPS work link from imslp.org/wiki/.');
    const metadata = this.draft()!.metadata;
    metadata.sourceUrl = url.href;
    const name = decodeURIComponent(url.pathname.slice(6)).replaceAll('_', ' ');
    if (!metadata.title) metadata.title = name.replace(/\s*\([^)]*\)$/, '');
    const composer = name.match(/\(([^()]+, [^()]+)\)$/)?.[1];
    if (!metadata.composer && composer) metadata.composer = composer;
    this.mark();
    return url.href;
  }
  async openIMSLP() {
    try {
      const url = this.applyIMSLP();
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
      await this.persist();
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }
  async continue() {
    try {
      this.applyIMSLP();
      await this.persist();
      this.setStep(this.step() === 'source' ? 'pages' : 'details');
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }
  async save() {
    this.invalidatePreview();
    const d = this.draft();
    if (!d) return;
    this.busy.set(true);
    this.error.set('');
    this.progress.set('Preparing score');
    try {
      this.applyIMSLP();
      await this.persist();
      const current = this.draft()!;
      const prepared: { key: string; bytes: ArrayBuffer }[] = [];
      const preparedKeys = current.manifest.pages.map((page) => {
        const source = current.sources.find((item) => item.id === page.sourceId);
        return source?.mime.startsWith('image/') ? preparedPhotoKey(source, page) : '';
      });
      for (const key of new Set(preparedKeys.filter(Boolean))) {
        const bytes = this.preparedPages.take(key);
        if (bytes) prepared.push({ key, bytes });
      }
      const transfer = prepared.map((item) => item.bytes);
      const response = await measureAsync('noted.intake.final-assembly', () =>
        this.runWorker(
          {
            kind: 'build',
            draftId: current.id,
            sources: current.sources,
            manifest: current.manifest,
            prepared,
            preparedKeys,
          },
          true,
          transfer,
        ),
      );
      const bytes = response.bytes;
      if (!bytes) throw Error('Prepared PDF was not returned.');
      if (bytes.byteLength > current.maxFileBytes)
        throw Error(
          'Prepared PDF exceeds the file limit. Remove pages or use smaller images; your draft is retained.',
        );
      const piece = await measureAsync('noted.intake.finalize', () =>
        firstValueFrom(
          this.api.finalizeImport(current, new Blob([bytes], { type: 'application/pdf' })),
        ),
      );
      this.dirty = false;
      await this.router.navigate(['/reader', piece.id]);
    } catch (e) {
      this.error.set(
        isProcessingStopped(e) && e.reason === 'cancelled'
          ? 'Processing cancelled. Your draft and originals are retained.'
          : errorMessage(e),
      );
    } finally {
      this.busy.set(false);
      this.progress.set('');
    }
  }
  cancel() {
    if (!this.cancellable()) return;
    if (this.uploading) {
      this.uploadGeneration++;
      this.skipRemainingUploads = true;
      this.syncCancellable();
      this.progress.set('Finishing the current upload; remaining files cancelled.');
      return;
    }
    this.workerClient.cancel();
    this.foregroundWorker = false;
    this.uploadGeneration++;
    this.syncCancellable();
    this.busy.set(false);
    this.progress.set('');
    this.error.set('Processing cancelled. Your draft and originals are retained.');
  }

  private syncCancellable(): void {
    this.cancellable.set(
      (this.uploading && !this.skipRemainingUploads) || (this.busy() && this.foregroundWorker),
    );
  }
}
