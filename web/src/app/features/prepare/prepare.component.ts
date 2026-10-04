import {
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  ViewChild,
  forwardRef,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { LucideChevronDown, LucideChevronUp, LucideMinus, LucidePlus } from '@lucide/angular';
import { firstValueFrom } from 'rxjs';
import { ApiService, errorMessage } from '../../core/api.service';
import { LeaveGuarded } from '../../core/leave.guard';
import {
  EditManifest,
  ImportAsset,
  ImportDraft,
  MAX_PREPARED_PAGES,
  PageEdit,
  PieceInput,
} from '../../core/models';
import { measureAsync } from '../../core/performance';
import { PrepareEdgesComponent } from './prepare-edges.component';
import { PrepareImslpComponent } from './prepare-imslp.component';
import {
  IMSLPAddedFile,
  ImslpPanelHost,
  ImslpSearch,
  chosenIMSLPWork,
  imslpFileMatch,
  isIMSLPWorkLink,
  linkIMSLPWork,
} from './prepare-imslp';
import {
  PreparedPageCache,
  ProcessingResponse,
  ProcessingWorkerClient,
  isProcessingStopped,
  hasPageAdjustments,
  preparedPhotoKey,
} from './prepare-processing';
import { PageRenderer, PrepareStep } from './prepare-rendering';
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
    LucideMinus,
    LucidePlus,
    PrepareEdgesComponent,
    PrepareImslpComponent,
  ],
  templateUrl: './prepare.component.html',
  styleUrl: './prepare.component.scss',
  providers: [{ provide: ImslpPanelHost, useExisting: forwardRef(() => PrepareComponent) }],
})
export class PrepareComponent implements OnDestroy, LeaveGuarded, ImslpPanelHost {
  readonly Math = Math;
  readonly hasPageAdjustments = hasPageAdjustments;
  readonly maxPreparedPages = MAX_PREPARED_PAGES;
  readonly steps: { id: PrepareStep; label: string }[] = [
    { id: 'source', label: 'Source' },
    { id: 'pages', label: 'Pages' },
    { id: 'details', label: 'Details' },
  ];
  private readonly api = inject(ApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  @ViewChild('surface') surface?: ElementRef<HTMLElement>;
  @ViewChild('thumbRail') thumbRail?: ElementRef<HTMLElement>;
  @ViewChild(PrepareEdgesComponent) edgeEditor?: PrepareEdgesComponent;
  readonly draft = signal<ImportDraft | null>(null);
  readonly step = signal<PrepareStep>('source');
  readonly error = signal('');
  readonly busy = signal(false);
  readonly finalizing = signal(false);
  readonly progress = signal('');
  /** True only while cancel can stop remaining uploads or the processing worker. */
  readonly cancellable = signal(false);
  readonly saved = signal('');
  readonly preview = signal('');
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
  readonly selectedIDs = signal<Set<string>>(new Set());
  readonly suggestion = signal<Suggestion | null>(null);
  readonly sourceMode = signal('all');
  /** The IMSLP panel's search and link state, kept while the panel is closed. */
  readonly imslp = new ImslpSearch(
    this.api,
    () => this.sourceMode() === 'imslp' && this.step() === 'source',
  );
  /** Draws thumbnails and previews; it reads the draft and selection, never changes them. */
  private readonly renderer = new PageRenderer({
    draft: this.draft,
    step: this.step,
    selected: this.selected,
    error: this.error,
  });
  readonly thumbs = this.renderer.thumbs;
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
  readonly marginLabels = ['Top', 'Right', 'Bottom', 'Left'];
  marginMM(index: number) {
    return Math.round((((this.page?.margins?.[index] || 0) * 25.4) / 72) * 10) / 10;
  }
  changeMargin(index: number, mm: number) {
    if (!this.page || !Number.isFinite(mm) || this.busy() || this.editingEdges) return;
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
      this.imslp.link = isIMSLPWorkLink(d.metadata.sourceUrl) ? d.metadata.sourceUrl : '';
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
    this.imslp.destroy();
    this.invalidatePreview();
    clearTimeout(this.previewTimer);
    clearTimeout(this.backgroundTimer);
    this.renderer.destroy();
    this.workerClient.destroy();
    this.preparedPages.clear();
    clearTimeout(this.saveTimer);
    this.revokePreviewURL();
  }
  /** Route departure flushes pending draft edits; a failed save asks before discarding them. */
  async canLeave(): Promise<boolean> {
    if (!this.hasUnsavedChanges()) return true;
    try {
      await this.persist();
      return true;
    } catch (e) {
      this.error.set(errorMessage(e));
      return window.confirm(
        'Your latest draft changes could not be saved. Leave anyway and lose them?',
      );
    }
  }
  /** Closing or reloading the tab cannot await a save: start one and ask the browser to warn. */
  @HostListener('window:beforeunload', ['$event'])
  warnBeforeUnload(event: BeforeUnloadEvent) {
    if (!this.hasUnsavedChanges()) return;
    void this.persist().catch((e) => this.error.set(errorMessage(e)));
    event.preventDefault();
    event.returnValue = '';
  }
  private hasUnsavedChanges(): boolean {
    return !this.discarding && (this.dirty || this.pendingSave !== undefined);
  }
  async detailsWithoutPDF() {
    const d = this.draft();
    // A draft for an existing piece already has its details; this starts a new piece.
    if (!d || d.sources.length || d.pieceId || this.busy()) return;
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
    if (this.discarding || this.finalizing()) return;
    this.dirty = true;
    this.saved.set('Unsaved changes');
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(
      () => void this.persist().catch((e) => this.error.set(errorMessage(e))),
      500,
    );
  }
  updateMetadata<K extends keyof PieceInput>(key: K, value: PieceInput[K]): void {
    if (this.finalizing()) return;
    this.draft.update((current) =>
      current
        ? {
            ...current,
            metadata: { ...current.metadata, [key]: value },
            imslpAutoFill:
              key === 'title' || key === 'composer'
                ? {
                    ...current.imslpAutoFill,
                    [key]: undefined,
                    [key === 'title' ? 'titleEdited' : 'composerEdited']: true,
                  }
                : current.imslpAutoFill,
          }
        : null,
    );
    this.mark();
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
    if (!this.page || !Number.isFinite(value) || this.busy() || this.editingEdges) return;
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
    if (!this.page || this.busy() || this.editingEdges) return;
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
    this.renderer.cancelPdfPreview();
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
    if (this.busy()) return;
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
    if (!this.page || this.busy()) return;
    this.remember();
    const { id, sourceId, page } = this.page;
    this.draft()!.manifest.pages[this.selected()] = { id, sourceId, page };
    this.handles.set(null);
    this.changed();
  }
  resetAll() {
    const d = this.draft();
    if (!d || this.busy()) return;
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
    this.renderer.keepDisplayRasterFor(`${nextSource?.checksum}:${nextPage?.page}`);
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
    if (this.busy() || !pages || index + delta < 0 || index + delta >= pages.length) return;
    this.remember();
    [pages[index], pages[index + delta]] = [pages[index + delta], pages[index]];
    this.selected.set(index + delta);
    this.changed();
  }
  remove() {
    const d = this.draft();
    if (!d || !this.page || this.busy()) return;
    this.remember();
    d.manifest.pages.splice(this.selected(), 1);
    this.selected.set(Math.max(0, Math.min(this.selected(), d.manifest.pages.length - 1)));
    this.changed();
  }
  toggle(id: string) {
    if (this.busy()) return;
    const set = new Set(this.selectedIDs());
    if (set.has(id)) set.delete(id);
    else set.add(id);
    this.selectedIDs.set(set);
  }
  keepSelected() {
    const d = this.draft(),
      ids = this.selectedIDs();
    if (!d || !ids.size || this.busy()) return;
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
    await this.uploadFiles(files, replace);
  }
  /** The file inputs and the IMSLP drop target share this path. */
  async uploadFiles(files: File[], replace = false) {
    if (this.busy() || !files.length) return;
    // A PDF downloaded from IMSLP keeps the draft on Source with the chosen work
    // in view; Continue moves on to Pages.
    const stayOnSource = !replace && this.step() === 'source' && this.sourceMode() === 'imslp';
    const added: IMSLPAddedFile[] = [];
    this.busy.set(true);
    this.error.set('');
    this.uploading = true;
    this.skipRemainingUploads = false;
    this.syncCancellable();
    const uploadGeneration = ++this.uploadGeneration;
    let pagesOmitted = false;
    try {
      this.applyIMSLP();
      await this.persist();
      const chosen = chosenIMSLPWork(this.draft());
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
        // Each completed file is one Undo step, even when later files fail or are cancelled.
        this.remember();
        this.draft.set(next);
        this.rangeSourceId ||= next.sources[0]?.id || '';
        const incoming = next.sources.find(
          (source) => !d.sources.some((old) => old.id === source.id),
        );
        if (
          !this.replaceID &&
          incoming &&
          next.manifest.pages.length - oldCount < incoming.pageCount
        )
          pagesOmitted = true;
        if (this.replaceID) {
          const target = next.manifest.pages.findIndex((p) => p.id === this.replaceID);
          if (!incoming || target < 0) throw Error('Replacement source was not received.');
          next.manifest.pages = next.manifest.pages.filter((page) => page.sourceId !== incoming.id);
          next.manifest.pages[target] = { id: this.replaceID, sourceId: incoming.id, page: 0 };
          this.mark();
          await this.persist();
          this.renderer.dropThumbnail(this.replaceID);
          this.renderer.releaseDisplayRaster();
          this.reconcilePreparedKeys();
          this.replaceID = undefined;
        }
        this.selected.set(Math.min(oldCount, this.draft()!.manifest.pages.length - 1));
        if (stayOnSource)
          added.push({ filename: file.name, match: imslpFileMatch(file.name, chosen) });
      }
      if (!stayOnSource) this.setStep('pages');
      this.reconcilePreparedKeys();
      if (pagesOmitted)
        this.error.set(
          `A draft holds at most ${MAX_PREPARED_PAGES} pages, so some uploaded pages were not added. Use Choose source pages to pick others.`,
        );
      await this.renderPreview();
    } catch (e) {
      this.error.set(errorMessage(e) + ' Pages already added remain in this draft.');
    } finally {
      if (added.length) this.imslp.added.update((files) => [...files, ...added]);
      this.uploading = false;
      this.skipRemainingUploads = false;
      this.syncCancellable();
      this.busy.set(false);
      this.progress.set('');
    }
  }
  /** The rail and the details review draw only thumbnails near the viewport. */
  async renderThumbnails(container = this.thumbRail?.nativeElement) {
    await this.renderer.renderThumbnails(container);
  }
  thumbnailRailScrolled(event: Event): void {
    void this.renderThumbnails(event.currentTarget as HTMLElement);
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
        const raster = await this.renderer.selectedDisplayRaster(page, source);
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
        canvas = await this.renderer.sourceCanvas(page, 1050);
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
    await this.renderer.renderPdfPreview(response.bytes, (canvas) => {
      if (revision !== this.previewRevision || this.destroyed) return;
      this.edgeAspect.set(canvas.width / canvas.height);
      this.revokePreviewURL();
      this.preview.set(canvas.toDataURL('image/png'));
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
  setStep(step: PrepareStep): void {
    if (step !== 'source') this.imslp.cancel();
    this.step.set(step);
    void this.renderThumbnails();
    setTimeout(() => void this.renderThumbnails());
  }
  private revokePreviewURL(): void {
    if (!this.objectURL) return;
    URL.revokeObjectURL(this.objectURL);
    this.objectURL = '';
  }
  setCompare(value: boolean) {
    if (this.busy()) return;
    this.compare.set(value);
    void this.renderPreview();
  }
  async beginEdges() {
    if (this.busy() || !this.page) return;
    document.getSelection()?.removeAllRanges();
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
    this.edgeEditor?.endDrag();
    this.handles.set(null);
    this.pendingEdges.set([]);
    this.compare.set(this.edgeCompare);
    void this.renderPreview();
  }
  applyEdges() {
    if (this.busy() || !this.page || !this.edgeReady() || this.edgeResetRequired()) return;
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
    this.edgeEditor?.endDrag();
    this.handles.set(null);
    this.pendingEdges.set([]);
    this.compare.set(false);
    this.changed();
  }
  useRange() {
    const d = this.draft();
    if (!d || this.busy()) return;
    const source = d.sources.find((a) => a.id === this.rangeSourceId);
    if (!source) return;
    try {
      const pages: number[] = [];
      for (const part of this.rangeText.split(',')) {
        const match = part.trim().match(/^(\d+)(?:-(\d+))?$/);
        if (!match) throw Error('Enter page numbers such as 1-4, 7.');
        const first = +match[1],
          last = +(match[2] || match[1]);
        if (
          first < 1 ||
          last < first ||
          last > source.pageCount ||
          last - first >= MAX_PREPARED_PAGES
        )
          throw Error(`Choose a valid source range of at most ${MAX_PREPARED_PAGES} pages.`);
        for (let n = first; n <= last; n++) pages.push(n - 1);
      }
      if (!pages.length || pages.length > MAX_PREPARED_PAGES)
        throw Error(`Choose 1 to ${MAX_PREPARED_PAGES} pages.`);
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
  /** A pasted work link is stored on the draft whenever the Source step moves on. */
  applyIMSLP(): string | undefined {
    if (this.step() !== 'source' || !this.imslp.link.trim()) return;
    const href = linkIMSLPWork(this.draft()!, this.imslp.link);
    this.mark();
    return href;
  }
  chooseSource(mode: string) {
    if (mode !== 'imslp') this.imslp.cancel();
    this.sourceMode.set(mode);
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
    const d = this.draft();
    if (!d || this.busy() || this.finalizing()) return;
    try {
      this.applyIMSLP();
    } catch (e) {
      this.error.set(errorMessage(e));
      return;
    }
    this.finalizing.set(true);
    this.invalidatePreview();
    this.busy.set(true);
    this.error.set('');
    this.progress.set('Preparing score');
    try {
      await this.persist();
      const current = structuredClone(this.draft()!);
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
      this.finalizing.set(false);
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
    if (this.finalizing()) return;
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
