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
import { EditManifest, ImportDraft, PageEdit } from '../../core/models';
GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';
interface Suggestion {
  confident: boolean;
  angle?: number;
  bounds?: number[];
  reason?: string;
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
  readonly draft = signal<ImportDraft | null>(null);
  readonly step = signal<'source' | 'pages' | 'details'>('source');
  readonly error = signal('');
  readonly busy = signal(false);
  readonly progress = signal('');
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
  private dragCleanup?: () => void;
  readonly selectedIDs = signal<Set<string>>(new Set());
  readonly suggestion = signal<Suggestion | null>(null);
  imslp = '';
  readonly sourceMode = signal('all');
  rangeSourceId = '';
  rangeText = '';
  private uploadGeneration = 0;
  private worker?: Worker;
  private workerReject?: (error: Error) => void;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private pendingSave?: Promise<void>;
  private dirty = false;
  private destroyed = false;
  private previewRevision = 0;
  private previewTask?: ReturnType<typeof getDocument>;
  private thumbnailRevision = 0;
  private pdfTasks = new Map<string, { task: ReturnType<typeof getDocument>; users: number }>();
  private history: EditManifest[] = [];
  private replaceID?: string;
  private objectURL = '';
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
      void this.renderThumbnails();
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
    this.thumbnailRevision++;
    for (const entry of this.pdfTasks.values()) void entry.task.destroy();
    this.pdfTasks.clear();
    this.worker?.terminate();
    clearTimeout(this.saveTimer);
    if (this.objectURL) URL.revokeObjectURL(this.objectURL);
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
    else this.step.set('source');
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
    if (!d) return;
    if (!confirm('Discard this draft? Your saved score will remain unchanged.')) return;
    try {
      await this.pendingSave;
      await firstValueFrom(this.api.deleteImport(d.id));
      this.dirty = false;
      await this.router.navigate(['/']);
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }
  mark() {
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
        this.dirty = true;
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
    if (this.previewTask) {
      void this.previewTask.destroy().catch(() => {});
      this.previewTask = undefined;
    }
    if (!this.busy() || this.uploading) {
      this.worker?.terminate();
      this.workerReject?.(new Error('Preview superseded.'));
      this.worker = undefined;
      this.workerReject = undefined;
      this.progress.set('');
    }
  }
  changed() {
    this.invalidatePreview();
    this.draft.update((d) =>
      d ? { ...d, manifest: { ...d.manifest, pages: [...d.manifest.pages] } } : null,
    );
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
    this.selected.set(index);
    this.handles.set(null);
    this.suggestion.set(null);
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
  async upload(event: Event, replace = false) {
    if (this.busy()) return;
    const input = event.target as HTMLInputElement,
      files = Array.from(input.files ?? []);
    input.value = '';
    if (!files.length) return;
    this.busy.set(true);
    this.error.set('');
    this.uploading = true;
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
            delete next[replacementID!];
            return next;
          });
          this.replaceID = undefined;
        }
        this.selected.set(Math.min(oldCount, this.draft()!.manifest.pages.length - 1));
      }
      this.step.set('pages');
      void this.renderThumbnails();
      await this.renderPreview();
    } catch (e) {
      this.error.set(errorMessage(e) + ' Pages already added remain in this draft.');
    } finally {
      this.uploading = false;
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
  async renderThumbnails() {
    const revision = ++this.thumbnailRevision;
    const d = this.draft();
    if (!d) return;
    for (const p of d.manifest.pages) {
      if (this.destroyed || revision !== this.thumbnailRevision) return;
      if (this.thumbs()[p.id]) continue;
      try {
        const canvas = await this.sourceCanvas(p, 140);
        if (!this.destroyed && revision === this.thumbnailRevision)
          this.thumbs.update((t) => ({ ...t, [p.id]: canvas.toDataURL('image/jpeg', 0.8) }));
        canvas.width = canvas.height = 1;
      } catch (e) {
        if (!this.destroyed && revision === this.thumbnailRevision) this.error.set(errorMessage(e));
        return;
      }
    }
  }
  async runWorker(payload: object): Promise<ArrayBuffer | Suggestion | PageEdit[]> {
    this.worker?.terminate();
    this.workerReject?.(new Error('Processing cancelled.'));
    this.workerReject = undefined;
    const worker = new Worker('/intake/processing-worker.js');
    this.worker = worker;
    return new Promise((resolve, reject) => {
      this.workerReject = reject;
      worker.onerror = () => {
        if (this.worker !== worker) return;
        this.worker = undefined;
        this.workerReject = undefined;
        worker.terminate();
        reject(Error('Page processing could not start. Please reload.'));
      };
      worker.onmessage = ({ data }) => {
        if (this.worker !== worker) return;
        if (!('progress' in data || 'bytes' in data || 'result' in data || 'error' in data)) return;
        if (data.progress) {
          this.progress.set(data.progress);
          return;
        }
        worker.terminate();
        if (this.worker === worker) {
          this.worker = undefined;
          this.workerReject = undefined;
        }
        this.progress.set('');
        if (data.error) reject(Error(data.error));
        else resolve(data.bytes ?? data.result);
      };
      worker.postMessage(payload);
    });
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
      let canvas: HTMLCanvasElement;
      if (plain) {
        canvas = await this.sourceCanvas(page, 1050);
      } else {
        const d = this.draft()!;
        const bytes = (await this.runWorker({
          kind: 'build',
          draftId: d.id,
          sources: d.sources,
          manifest: { version: 1, pages: [page] },
        })) as ArrayBuffer;
        if (revision !== this.previewRevision || this.destroyed) return;
        const task = getDocument({ data: new Uint8Array(bytes), wasmUrl: '/pdfjs/wasm/' });
        this.previewTask = task;
        try {
          const pdf = await task.promise,
            p = await pdf.getPage(1),
            base = p.getViewport({ scale: 1 }),
            v = p.getViewport({ scale: Math.min(2, 1050 / base.width) });
          canvas = document.createElement('canvas');
          canvas.width = Math.ceil(v.width);
          canvas.height = Math.ceil(v.height);
          await p.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport: v }).promise;
        } finally {
          if (this.previewTask === task) this.previewTask = undefined;
          await task.destroy();
        }
      }
      if (revision === this.previewRevision && !this.destroyed) {
        this.edgeAspect.set(canvas.width / canvas.height);
        this.preview.set(canvas.toDataURL('image/png'));
      }
      canvas.width = canvas.height = 1;
    } catch (e) {
      if (revision === this.previewRevision) this.error.set(errorMessage(e));
    }
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
      this.step.set(this.step() === 'source' ? 'pages' : 'details');
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
      const bytes = (await this.runWorker({
        kind: 'build',
        draftId: current.id,
        sources: current.sources,
        manifest: current.manifest,
      })) as ArrayBuffer;
      if (bytes.byteLength > current.maxFileBytes)
        throw Error(
          'Prepared PDF exceeds the file limit. Remove pages or use smaller images; your draft is retained.',
        );
      const piece = await firstValueFrom(
        this.api.finalizeImport(current, new Blob([bytes], { type: 'application/pdf' })),
      );
      this.dirty = false;
      await this.router.navigate(['/reader', piece.id]);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
      this.progress.set('');
    }
  }
  cancel() {
    if (this.uploading) {
      this.uploadGeneration++;
      this.progress.set('Finishing the current upload; remaining files cancelled.');
      return;
    }
    this.workerReject?.(new Error('Processing cancelled. Your draft is retained.'));
    this.workerReject = undefined;
    this.worker?.terminate();
    this.worker = undefined;
    this.uploadGeneration++;
    this.busy.set(false);
    this.progress.set('');
    this.error.set('Processing cancelled. Your draft and originals are retained.');
  }
}
