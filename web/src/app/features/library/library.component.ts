import {
  Component,
  ElementRef,
  computed,
  OnDestroy,
  ViewChild,
  inject,
  signal,
  afterNextRender,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import {
  LucideDownload,
  LucideFileText,
  LucideHeadphones,
  LucideHeart,
  LucidePencil,
  LucidePlus,
  LucideSearch,
  LucideTrash2,
  LucideUpload,
  LucideX,
} from '@lucide/angular';
import { GlobalWorkerOptions, PDFDocumentLoadingTask, getDocument } from 'pdfjs-dist';
import {
  Subject,
  Subscription,
  catchError,
  defer,
  finalize,
  firstValueFrom,
  map,
  of,
  switchMap,
  tap,
} from 'rxjs';
import { ApiService, errorMessage } from '../../core/api.service';
import {
  MAX_PREPARED_PAGES,
  Piece,
  PieceInput,
  Session,
  ImportDraft,
  ShortcutToken,
  ShortcutTokenCreated,
} from '../../core/models';
import { formatDay, lastUsedText, listeningUrlError, titleFromFilename } from './library.utils';

GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';

interface PieceLoadRequest {
  query: string;
  favoritesOnly: boolean;
  complete: () => void;
}

type PieceLoadResult = { pieces: Piece[] } | { error: unknown };

/** The Send to Noted section: no token, a token just created (shown once), or an active one. */
type ShortcutState = 'loading' | 'none' | 'created' | 'active';

@Component({
  selector: 'app-library',
  imports: [
    FormsModule,
    LucideDownload,
    LucideFileText,
    LucideHeadphones,
    LucideHeart,
    LucidePencil,
    LucidePlus,
    LucideSearch,
    LucideTrash2,
    LucideUpload,
    LucideX,
  ],
  templateUrl: './library.component.html',
  styleUrl: './library.component.scss',
})
export class LibraryComponent implements OnDestroy {
  protected readonly drafts = signal<ImportDraft[]>([]);
  protected readonly maxPreparedPages = MAX_PREPARED_PAGES;
  @ViewChild('editor') private editor?: ElementRef<HTMLDialogElement>;
  @ViewChild('account') private account?: ElementRef<HTMLDialogElement>;
  @ViewChild('tokenText') private tokenText?: ElementRef<HTMLElement>;
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  protected readonly pieces = signal<Piece[]>([]);
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly readingPdf = signal(false);
  protected readonly error = signal('');
  protected readonly session = signal<Session | null>(null);
  protected readonly signingOut = signal(false);
  protected readonly shortcut = signal<ShortcutToken | null>(null);
  /** The plaintext token lives only here, from creation until the dialog closes. */
  protected readonly createdToken = signal<ShortcutTokenCreated | null>(null);
  protected readonly confirming = signal<'replace' | 'off' | null>(null);
  protected readonly shortcutBusy = signal(false);
  protected readonly shortcutError = signal('');
  protected readonly copyNote = signal('');
  protected readonly shortcutState = computed<ShortcutState>(() => {
    if (this.createdToken()) return 'created';
    const token = this.shortcut();
    if (!token) return 'loading';
    return token.active ? 'active' : 'none';
  });
  protected readonly shortcutStatus = computed(() => {
    const token = this.shortcut();
    if (!token?.active || !token.createdAt) return '';
    return `Set up on ${formatDay(token.createdAt)} · last used ${lastUsedText(token.lastUsedAt)}`;
  });
  private copyTimer?: number;
  /** Ignores a status read that finishes after the dialog closed or the token changed. */
  private accountVisit = 0;
  protected query = '';
  protected favoritesOnly = false;
  protected editing: Piece | null = null;
  protected form: PieceInput = emptyPiece();
  protected selectedFile: File | null = null;
  protected selectedPageCount = 0;
  private searchTimer?: number;
  /** Identifies the open editor and the latest PDF selection so stale reads are ignored. */
  private editorSession = 0;
  private pdfSelection = 0;
  private pdfLoadingTask?: PDFDocumentLoadingTask;
  private readonly pieceLoadRequests = new Subject<PieceLoadRequest>();
  private readonly pieceLoadSubscription: Subscription;

  constructor() {
    this.pieceLoadSubscription = this.pieceLoadRequests
      .pipe(
        tap(() => {
          this.loading.set(true);
          this.error.set('');
        }),
        switchMap((request) =>
          defer(() => this.api.pieces(request.query, request.favoritesOnly)).pipe(
            map((pieces): PieceLoadResult => ({ pieces })),
            catchError((error: unknown) => of<PieceLoadResult>({ error })),
            finalize(request.complete),
          ),
        ),
      )
      .subscribe((result) => {
        if ('pieces' in result) this.pieces.set(result.pieces);
        else this.error.set(errorMessage(result.error));
        this.loading.set(false);
      });
    afterNextRender(() => {
      if (this.route.snapshot.queryParamMap.get('details') === 'new') {
        this.openCreate();
        void this.router.navigate([], { queryParams: {}, replaceUrl: true });
      }
    });
    void this.loadSession();
    void this.load();
    void this.loadDrafts();
  }

  async loadSession(): Promise<void> {
    try {
      this.session.set(await firstValueFrom(this.api.session()));
    } catch {
      this.session.set(null);
    }
  }

  async logout(): Promise<void> {
    if (this.signingOut()) return;
    this.signingOut.set(true);
    try {
      await firstValueFrom(this.api.logout());
      window.location.reload();
    } catch (error) {
      this.error.set(errorMessage(error));
      this.signingOut.set(false);
    }
  }

  openAccount(): void {
    this.accountVisit++;
    this.confirming.set(null);
    this.shortcutError.set('');
    this.copyNote.set('');
    this.account?.nativeElement.showModal();
    void this.loadShortcut(this.accountVisit);
  }

  closeAccount(): void {
    this.account?.nativeElement.close();
  }

  /** Runs on every close, including Escape: the token is never shown again. */
  accountClosed(): void {
    this.accountVisit++;
    this.createdToken.set(null);
    this.confirming.set(null);
    this.copyNote.set('');
    if (this.copyTimer) window.clearTimeout(this.copyTimer);
  }

  private async loadShortcut(visit: number): Promise<void> {
    try {
      const token = await firstValueFrom(this.api.shortcutToken());
      if (visit === this.accountVisit) this.shortcut.set(token);
    } catch (error) {
      if (visit === this.accountVisit) this.shortcutError.set(errorMessage(error));
    }
  }

  /** Creates the token, or replaces the current one after its inline confirm. */
  async createShortcut(): Promise<void> {
    if (this.shortcutBusy()) return;
    this.shortcutBusy.set(true);
    this.shortcutError.set('');
    const visit = ++this.accountVisit;
    try {
      const created = await firstValueFrom(this.api.createShortcutToken());
      this.shortcut.set({ active: true, createdAt: created.createdAt, lastUsedAt: null });
      // A dialog closed meanwhile never shows the token; Replace issues another.
      if (visit !== this.accountVisit) return;
      this.createdToken.set(created);
      this.confirming.set(null);
      this.copyNote.set('');
    } catch (error) {
      this.shortcutError.set(errorMessage(error));
    } finally {
      this.shortcutBusy.set(false);
    }
  }

  async turnOffShortcut(): Promise<void> {
    if (this.shortcutBusy()) return;
    this.shortcutBusy.set(true);
    this.shortcutError.set('');
    const visit = ++this.accountVisit;
    try {
      await firstValueFrom(this.api.deleteShortcutToken(), { defaultValue: undefined });
      this.shortcut.set({ active: false, createdAt: null, lastUsedAt: null });
      if (visit === this.accountVisit) this.confirming.set(null);
    } catch (error) {
      this.shortcutError.set(errorMessage(error));
    } finally {
      this.shortcutBusy.set(false);
    }
  }

  /** Copies the token; where the clipboard is refused, selects it for a manual copy. */
  async copyToken(): Promise<void> {
    const token = this.createdToken()?.token;
    if (!token) return;
    if (this.copyTimer) window.clearTimeout(this.copyTimer);
    try {
      if (!navigator.clipboard) throw Error('Clipboard unavailable');
      await navigator.clipboard.writeText(token);
      this.copyNote.set('Copied');
      this.copyTimer = window.setTimeout(() => this.copyNote.set(''), 2000);
    } catch {
      const text = this.tokenText?.nativeElement;
      const selection = window.getSelection();
      if (text && selection) {
        selection.removeAllRanges();
        selection.selectAllChildren(text);
      }
      this.copyNote.set('The token is selected. Copy it from the menu.');
    }
  }

  ngOnDestroy(): void {
    this.cancelPdfSelection();
    if (this.copyTimer) window.clearTimeout(this.copyTimer);
    if (this.searchTimer) window.clearTimeout(this.searchTimer);
    this.pieceLoadSubscription.unsubscribe();
    this.pieceLoadRequests.complete();
  }

  onSearch(): void {
    if (this.searchTimer) window.clearTimeout(this.searchTimer);
    this.searchTimer = window.setTimeout(() => void this.load(), 250);
  }

  load(): Promise<void> {
    return new Promise((complete) => {
      this.pieceLoadRequests.next({
        query: this.query,
        favoritesOnly: this.favoritesOnly,
        complete,
      });
    });
  }

  async loadDrafts(): Promise<void> {
    try {
      this.drafts.set(await firstValueFrom(this.api.imports()));
    } catch {
      /* Library remains usable if drafts are temporarily unavailable. */
    }
  }
  /** Uses the chosen replacement PDF when there is one, otherwise the saved PDF. */
  protected tooLongToPrepare(piece: Piece | null): boolean {
    const pages = this.selectedFile ? this.selectedPageCount : (piece?.pdf?.pageCount ?? 0);
    return pages > MAX_PREPARED_PAGES;
  }

  async editPages(): Promise<void> {
    if (!this.editing || this.readingPdf() || this.saving() || this.tooLongToPrepare(this.editing))
      return;
    if (this.editorDirty()) {
      const saved = await this.persistEditor();
      if (!saved || !this.editing) return;
    }
    this.editor?.nativeElement.close();
    await this.beginImport(this.editing);
  }

  async beginImport(piece?: Piece, event?: Event, mode = 'all'): Promise<void> {
    event?.stopPropagation();
    try {
      const d = await firstValueFrom(this.api.createImport(piece?.id));
      await this.router.navigate(['/prepare', d.id], { queryParams: { source: mode } });
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }
  resumeImport(id: string): void {
    void this.router.navigate(['/prepare', id]);
  }
  openCreate(): void {
    this.beginEditorSession();
    this.editing = null;
    this.form = emptyPiece();
    this.editor?.nativeElement.showModal();
  }

  openEdit(piece: Piece, event?: Event): void {
    event?.stopPropagation();
    this.beginEditorSession();
    this.editing = piece;
    this.form = {
      title: piece.title,
      composer: piece.composer,
      favorite: piece.favorite,
      sourceUrl: piece.sourceUrl,
      listeningUrl: piece.listeningUrl,
      notes: piece.notes,
    };
    this.editor?.nativeElement.showModal();
  }

  closeEditor(): void {
    if (this.saving()) return;
    this.cancelPdfSelection();
    this.editor?.nativeElement.close();
  }

  async choosePdf(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    if (!file) return;
    this.cancelPdfSelection();
    const session = this.editorSession;
    const selection = this.pdfSelection;
    const current = () => session === this.editorSession && selection === this.pdfSelection;
    this.readingPdf.set(true);
    this.error.set('');
    let loadingTask: PDFDocumentLoadingTask | undefined;
    try {
      const data = await file.arrayBuffer();
      if (!current()) return;
      loadingTask = this.openPdf(data);
      this.pdfLoadingTask = loadingTask;
      const document = await loadingTask.promise;
      if (!current()) return;
      this.selectedFile = file;
      this.selectedPageCount = document.numPages;
      if (!this.form.title.trim()) this.form.title = titleFromFilename(file.name);
    } catch {
      if (!current()) return;
      this.selectedFile = null;
      this.selectedPageCount = 0;
      input.value = '';
      this.error.set('The selected file could not be read as a PDF.');
    } finally {
      // A superseded task was already destroyed when its selection was cancelled.
      if (loadingTask && this.pdfLoadingTask === loadingTask) {
        this.pdfLoadingTask = undefined;
        void loadingTask.destroy().catch(() => {});
      }
      if (current()) this.readingPdf.set(false);
    }
  }

  private openPdf(data: ArrayBuffer): PDFDocumentLoadingTask {
    return getDocument({ data, wasmUrl: '/pdfjs/wasm/' });
  }

  /** Starts a new editor session; results from an earlier session are discarded. */
  private beginEditorSession(): void {
    this.editorSession++;
    this.cancelPdfSelection();
    this.selectedFile = null;
    this.selectedPageCount = 0;
    this.error.set('');
  }

  private cancelPdfSelection(): void {
    this.pdfSelection++;
    const task = this.pdfLoadingTask;
    this.pdfLoadingTask = undefined;
    if (task) void task.destroy().catch(() => {});
    this.readingPdf.set(false);
  }

  async save(): Promise<void> {
    const wasNew = !this.editing;
    const piece = await this.persistEditor();
    if (!piece) return;
    this.editor?.nativeElement.close();
    await this.load();
    if (wasNew && piece.pdf) await this.router.navigate(['/reader', piece.id]);
  }

  private editorDirty(): boolean {
    const piece = this.editing;
    if (!piece) return false;
    return (
      this.selectedFile !== null ||
      this.form.title !== piece.title ||
      this.form.composer !== piece.composer ||
      this.form.favorite !== piece.favorite ||
      this.form.sourceUrl !== piece.sourceUrl ||
      this.form.listeningUrl.trim() !== piece.listeningUrl ||
      this.form.notes !== piece.notes
    );
  }

  private async persistEditor(): Promise<Piece | null> {
    this.form.listeningUrl = this.form.listeningUrl.trim();
    if (this.saving() || this.readingPdf()) return null;
    if (!this.form.title.trim() || this.listeningUrlValidationError()) {
      this.error.set(this.listeningUrlValidationError() || 'Add a title first.');
      return null;
    }
    this.saving.set(true);
    this.error.set('');
    try {
      let piece = this.editing
        ? await firstValueFrom(this.api.updatePiece(this.editing.id, this.form))
        : await firstValueFrom(this.api.createPiece(this.form));
      // Keep the created record as the retry target if the separate upload fails.
      this.editing = piece;
      if (this.selectedFile) {
        piece = await firstValueFrom(
          this.api.uploadPdf(piece.id, this.selectedFile, this.selectedPageCount),
        );
        this.editing = piece;
        this.selectedFile = null;
        this.selectedPageCount = 0;
      }
      return piece;
    } catch (error) {
      this.error.set(errorMessage(error));
      return null;
    } finally {
      this.saving.set(false);
    }
  }

  openPiece(piece: Piece): void {
    if (piece.pdf) {
      void this.router.navigate(['/reader', piece.id]);
    } else {
      this.openEdit(piece);
    }
  }

  openPieceFromKeyboard(piece: Piece, event: Event): void {
    if (event.target === event.currentTarget) this.openPiece(piece);
  }

  protected listeningUrlValidationError(): string {
    return listeningUrlError(this.form.listeningUrl);
  }

  async toggleFavorite(piece: Piece, event: Event): Promise<void> {
    event.stopPropagation();
    try {
      const updated = await firstValueFrom(
        this.api.updatePiece(piece.id, { favorite: !piece.favorite }),
      );
      this.pieces.update((pieces) =>
        this.favoritesOnly && !updated.favorite
          ? pieces.filter((candidate) => candidate.id !== updated.id)
          : pieces.map((candidate) => (candidate.id === updated.id ? updated : candidate)),
      );
    } catch (error) {
      this.error.set(errorMessage(error));
    }
  }

  async deletePiece(piece: Piece): Promise<void> {
    if (!window.confirm(`Delete “${piece.title}” and its PDF? This cannot be undone.`)) return;
    this.saving.set(true);
    try {
      await firstValueFrom(this.api.deletePiece(piece.id));
      this.editor?.nativeElement.close();
      await this.load();
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.saving.set(false);
    }
  }
}

function emptyPiece(): PieceInput {
  return {
    title: '',
    composer: '',
    favorite: false,
    sourceUrl: '',
    listeningUrl: '',
    notes: '',
  };
}
