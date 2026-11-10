import { ElementRef, Injectable, OnDestroy, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService, errorMessage } from '../../core/api.service';
import { FinalizeResult, ImportDraft, PageEdit, PieceInput } from '../../core/models';
import { EdgeEditor } from './prepare-edge-editor';
import type { PrepareEdgesComponent } from './prepare-edges.component';
import { ImslpPanelHost, ImslpSearch, isIMSLPWorkLink, linkIMSLPWork } from './prepare-imslp';
import { PageEdits } from './prepare-page-edits';
import { PreparePreview } from './prepare-preview';
import { PrepareStep } from './prepare-rendering';
import { PrepareTransfer } from './prepare-transfer';

/** The DOM the store scrolls, focuses or reads; each child registers its element here. */
export interface PrepareViews {
  surface?: ElementRef<HTMLElement>;
  thumbRail?: ElementRef<HTMLElement>;
  completionHeading?: ElementRef<HTMLElement>;
  edgeEditor?: PrepareEdgesComponent;
  fileInputs?: { open(kind: PrepareFileKind): void };
}

export type PrepareFileKind = 'pdf' | 'photos' | 'camera' | 'add' | 'replace';

/**
 * The state of one Prepare visit and the draft's save lifecycle. The page component
 * provides it, so every child component shares one instance. Page edits, the preview,
 * the edge editor and uploads live in collaborators that read and change this state.
 */
@Injectable()
export class PrepareStore implements OnDestroy, ImslpPanelHost {
  readonly api = inject(ApiService);
  readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  readonly views: PrepareViews = {};
  readonly draft = signal<ImportDraft | null>(null);
  readonly completed = signal<FinalizeResult | null>(null);
  readonly step = signal<PrepareStep>('source');
  readonly error = signal('');
  readonly busy = signal(false);
  readonly finalizing = signal(false);
  readonly progress = signal('');
  /** True only while cancel can stop remaining uploads or the processing worker. */
  readonly cancellable = signal(false);
  readonly saved = signal('');
  readonly selected = signal(0);
  readonly selectedIDs = signal<Set<string>>(new Set());
  readonly zoom = signal(1);
  readonly sourceMode = signal('all');
  rangeSourceId = '';
  rangeText = '';
  dirty = false;
  destroyed = false;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private pendingSave?: Promise<void>;
  private discarding = false;
  /** The IMSLP panel's search and link state, kept while the panel is closed. */
  readonly imslp = new ImslpSearch(
    this.api,
    () => this.sourceMode() === 'imslp' && this.step() === 'source',
  );
  readonly edges = new EdgeEditor(this);
  readonly edits = new PageEdits(this);
  readonly transfer = new PrepareTransfer(this);
  readonly preview = new PreparePreview(this);
  readonly thumbs = this.preview.thumbs;

  /** Settles when the draft requested at construction has loaded. */
  readonly ready: Promise<void>;

  constructor() {
    this.ready = this.load();
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

  get editingEdges() {
    return this.edges.handles() !== null;
  }

  /** Controls that change the draft stay disabled while it is busy or its edges are edited. */
  get locked() {
    return this.busy() || this.editingEdges;
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
      this.preview.reconcileKeys();
      void this.renderThumbnails();
      setTimeout(() => void this.renderThumbnails());
      await this.preview.render();
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  ngOnDestroy() {
    this.destroyed = true;
    this.imslp.destroy();
    this.preview.destroy();
    clearTimeout(this.saveTimer);
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
    if (this.locked) return;
    if (this.draft()?.pieceId) await this.close();
    else this.setStep('source');
  }

  async close() {
    if (this.locked) return;
    this.preview.invalidate();
    try {
      await this.persist();
      await this.router.navigate(['/']);
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  async discard() {
    const d = this.draft();
    if (!d || d.finalized || this.locked) return;
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
    if (this.discarding || this.finalizing() || this.draft()?.finalized) return;
    this.dirty = true;
    this.saved.set('Unsaved changes');
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(
      () => void this.persist().catch((e) => this.error.set(errorMessage(e))),
      500,
    );
  }

  updateMetadata<K extends keyof PieceInput>(key: K, value: PieceInput[K]): void {
    if (this.finalizing() || this.draft()?.finalized) return;
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
    if (!d || d.finalized || !this.dirty) return;
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

  /** The rail and the details review draw only thumbnails near the viewport. */
  async renderThumbnails(container = this.views.thumbRail?.nativeElement) {
    await this.preview.renderer.renderThumbnails(container);
  }

  setStep(step: PrepareStep): void {
    if (step !== 'source') this.imslp.cancel();
    this.step.set(step);
    void this.renderThumbnails();
    setTimeout(() => void this.renderThumbnails());
  }

  chooseSource(mode: string) {
    if (mode !== 'imslp') this.imslp.cancel();
    this.sourceMode.set(mode);
  }

  /** A pasted work link is stored on the draft whenever the Source step moves on. */
  applyIMSLP(): string | undefined {
    if (this.step() !== 'source' || !this.imslp.link.trim()) return;
    const href = linkIMSLPWork(this.draft()!, this.imslp.link);
    this.mark();
    return href;
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

  uploadFiles(files: File[], replace = false) {
    return this.transfer.uploadFiles(files, replace);
  }
}
