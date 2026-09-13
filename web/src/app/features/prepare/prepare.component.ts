import { Component, ElementRef, OnDestroy, ViewChild, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
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
  imports: [FormsModule, RouterLink],
  templateUrl: './prepare.component.html',
  styleUrl: './prepare.component.scss',
})
export class PrepareComponent implements OnDestroy {
  readonly Math = Math;
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
    return this.handles() === 'corners'
      ? (this.page?.corners ?? [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ])
      : this.cropPoints();
  }
  cropPoints(): number[][] {
    const [l, t, r, b] = this.page?.crop ?? [0, 0, 1, 1];
    return [
      [l, t],
      [r, t],
      [r, b],
      [l, b],
    ];
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
    this.worker?.terminate();
    clearTimeout(this.saveTimer);
    if (this.objectURL) URL.revokeObjectURL(this.objectURL);
  }
  async close() {
    if (this.busy()) return;
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
  change(key: 'angle' | 'rotation' | 'scale' | 'x' | 'y', value: number) {
    if (!this.page || !Number.isFinite(value)) return;
    this.remember();
    this.page[key] = value;
    this.changed();
  }
  changed() {
    this.draft.update((d) =>
      d ? { ...d, manifest: { ...d.manifest, pages: [...d.manifest.pages] } } : null,
    );
    this.mark();
    this.suggestion.set(null);
    void this.renderPreview();
  }
  undo() {
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
    if (this.busy()) return;
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
      await this.renderThumbnails();
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
      const task = getDocument({ url, wasmUrl: '/pdfjs/wasm/' });
      try {
        const pdf = await task.promise,
          p = await pdf.getPage(page.page + 1),
          base = p.getViewport({ scale: 1 }),
          viewport = p.getViewport({ scale: Math.min(width / base.width, 2) });
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await p.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise;
      } finally {
        await task.destroy();
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
    const d = this.draft();
    if (!d) return;
    for (const p of d.manifest.pages) {
      if (this.destroyed) return;
      if (this.thumbs()[p.id]) continue;
      try {
        const canvas = await this.sourceCanvas(p, 140);
        this.thumbs.update((t) => ({ ...t, [p.id]: canvas.toDataURL('image/jpeg', 0.8) }));
        canvas.width = canvas.height = 1;
      } catch (e) {
        this.error.set(errorMessage(e));
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
        worker.terminate();
        reject(Error('Page processing could not start. Please reload.'));
      };
      worker.onmessage = ({ data }) => {
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
    const revision = ++this.previewRevision,
      page = this.page;
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
          !page.outputWidth);
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
        const task = getDocument({ data: new Uint8Array(bytes), wasmUrl: '/pdfjs/wasm/' });
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
          await task.destroy();
        }
      }
      if (revision === this.previewRevision && !this.destroyed)
        this.preview.set(canvas.toDataURL('image/png'));
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
  setHandles(mode: 'crop' | 'corners' | null) {
    if (this.busy()) return;
    this.handles.set(mode);
    void this.renderPreview();
  }
  dragCorner(event: PointerEvent, index: number) {
    if (this.busy() || !this.page || !this.surface) return;
    event.preventDefault();
    this.remember();
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    const rect = this.surface.nativeElement.getBoundingClientRect();
    const move = (e: PointerEvent) => {
      const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
        y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
      if (this.handles() === 'corners') {
        const c = this.page!.corners?.map((p) => [...p]) ?? [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ];
        c[index] = [x, y];
        this.page!.corners = c;
      } else {
        const c = [...(this.page!.crop ?? [0, 0, 1, 1])];
        if (index === 0 || index === 3) c[0] = Math.min(x, c[2] - 0.05);
        else c[2] = Math.max(x, c[0] + 0.05);
        if (index < 2) c[1] = Math.min(y, c[3] - 0.05);
        else c[3] = Math.max(y, c[1] + 0.05);
        this.page!.crop = c;
      }
      this.draft.update((d) => (d ? { ...d } : null));
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      this.changed();
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up, { once: true });
  }
  nudgeCorner(index: number, event: KeyboardEvent) {
    const offset: { [key: string]: number[] } = {
      ArrowLeft: [-0.01, 0],
      ArrowRight: [0.01, 0],
      ArrowUp: [0, -0.01],
      ArrowDown: [0, 0.01],
    };
    const delta = offset[event.key];
    if (this.busy() || !delta || !this.page) return;
    event.preventDefault();
    this.remember();
    if (this.handles() === 'corners') {
      const corners = this.edgePoints.map((p) => [...p]);
      corners[index] = corners[index].map((v, i) => Math.max(0, Math.min(1, v + delta[i])));
      this.page.corners = corners;
    } else {
      const c = [...(this.page.crop ?? [0, 0, 1, 1])];
      const xi = index === 0 || index === 3 ? 0 : 2,
        yi = index < 2 ? 1 : 3;
      c[xi] = Math.max(0, Math.min(1, c[xi] + delta[0]));
      c[yi] = Math.max(0, Math.min(1, c[yi] + delta[1]));
      this.page.crop = c;
    }
    this.changed();
  }
  async suggest() {
    if (!this.page) return;
    this.busy.set(true);
    this.progress.set('Looking for staff lines');
    try {
      const c = await this.sourceCanvas(this.page, 1400);
      const result = (await this.runWorker({
        kind: 'analyze',
        image: c.getContext('2d')!.getImageData(0, 0, c.width, c.height),
      })) as Suggestion;
      this.suggestion.set(result);
      c.width = c.height = 1;
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
      this.progress.set('');
    }
  }
  applySuggestion() {
    const s = this.suggestion();
    if (s?.confident) this.change('angle', Math.round((s.angle ?? 0) * 100) / 100);
  }
  async match() {
    const d = this.draft(),
      reference = this.page;
    if (!d || !reference) return;
    const targets = d.manifest.pages.filter(
      (p) => this.selectedIDs().has(p.id) && p.id !== reference.id,
    );
    if (!targets.length) {
      this.error.set('Select other page checkboxes to match to this reference page.');
      return;
    }
    this.busy.set(true);
    try {
      const matched = (await this.runWorker({
        kind: 'match',
        draftId: d.id,
        sources: d.sources,
        reference,
        targets,
      })) as PageEdit[];
      this.remember();
      for (const edit of matched) {
        const index = d.manifest.pages.findIndex((p) => p.id === edit.id);
        d.manifest.pages[index] = edit;
      }
      this.changed();
      this.saved.set('Alignment suggested. Review each selected page before saving.');
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
      this.progress.set('');
    }
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
