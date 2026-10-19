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
  LucideChevronDown,
  LucideDownload,
  LucideFileText,
  LucideHeadphones,
  LucideHeart,
  LucidePencil,
  LucidePlus,
  LucideSearch,
  LucideTrash2,
  LucideX,
} from '@lucide/angular';
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
  LIBRARY_FILTERS,
  LibraryFilter,
  MAX_PREPARED_PAGES,
  PIECE_STATUSES,
  Piece,
  PieceInput,
  PieceStatus,
  Session,
  ImportDraft,
  ShortcutToken,
  ShortcutTokenCreated,
} from '../../core/models';
import { formatDay, lastUsedText, listeningUrlError } from './library.utils';

interface PieceLoadRequest {
  query: string;
  filter: LibraryFilter;
  complete: () => void;
}

/** `hidden` is set when the default view is empty only because everything is shelved. */
type PieceLoadResult = { pieces: Piece[]; hidden: boolean } | { error: unknown };

/** One row's status saves: the latest choice, the last saved row, and the save queue. */
interface StatusSave {
  latest: PieceStatus;
  saved: Piece;
  queue: Promise<void>;
  /** The row's select, reset directly on failure: a fast failure leaves no binding change. */
  control: HTMLSelectElement;
}

/** The details form always carries a status, unlike an import draft's metadata. */
type PieceForm = PieceInput & { status: PieceStatus };

/** The Send to Noted section: no token, a token just created (shown once), or an active one. */
type ShortcutState = 'loading' | 'none' | 'created' | 'active';

@Component({
  selector: 'app-library',
  imports: [
    FormsModule,
    LucideChevronDown,
    LucideDownload,
    LucideFileText,
    LucideHeadphones,
    LucideHeart,
    LucidePencil,
    LucidePlus,
    LucideSearch,
    LucideTrash2,
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
  protected readonly libraryFilters = LIBRARY_FILTERS;
  protected readonly pieceStatuses = PIECE_STATUSES;
  protected readonly pieces = signal<Piece[]>([]);
  /** The default view is empty, but the binder is not: every piece is shelved. */
  protected readonly onlyShelved = signal(false);
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
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
  /** Opens on the filter this user last chose, on any device. */
  protected filter: LibraryFilter = 'current';
  private filterChosen = false;
  /** Saves run one at a time, so an older choice can never land after a newer one. */
  private filterSave: Promise<void> = Promise.resolve();
  /** Status saves still running, by piece. */
  private readonly statusSaves = new Map<string, StatusSave>();
  protected editing: Piece | null = null;
  protected form: PieceForm = emptyPiece();
  private searchTimer?: number;
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
          defer(() => this.api.pieces(request.query, request.filter)).pipe(
            switchMap((pieces) =>
              pieces.length || request.filter !== 'current' || request.query.trim()
                ? of<PieceLoadResult>({ pieces, hidden: false })
                : this.api
                    .pieces('', 'all')
                    .pipe(map((all): PieceLoadResult => ({ pieces, hidden: all.length > 0 }))),
            ),
            catchError((error: unknown) => of<PieceLoadResult>({ error })),
            finalize(request.complete),
          ),
        ),
      )
      .subscribe((result) => {
        if ('pieces' in result) {
          this.pieces.set(result.pieces);
          this.onlyShelved.set(result.hidden);
        } else {
          this.error.set(errorMessage(result.error));
        }
        this.loading.set(false);
      });
    afterNextRender(() => {
      if (this.route.snapshot.queryParamMap.get('details') === 'new') {
        this.openCreate();
        void this.router.navigate([], { queryParams: {}, replaceUrl: true });
      }
    });
    void this.loadSession();
    this.loadPreferences();
    void this.loadDrafts();
  }

  /** Loads the remembered filter, then the list; a first-time user gets the default. */
  private loadPreferences(): void {
    this.api.preferences().subscribe({
      next: (preferences) => {
        if (this.filterChosen) return;
        if (LIBRARY_FILTERS.some((option) => option.value === preferences.libraryFilter)) {
          this.filter = preferences.libraryFilter;
        }
        void this.load();
      },
      error: () => {
        if (!this.filterChosen) void this.load();
      },
    });
  }

  /** Lists by the new filter and remembers it for this user's next visit. */
  async chooseFilter(filter: LibraryFilter): Promise<void> {
    this.filter = filter;
    this.filterChosen = true;
    const listed = this.load();
    const saved = this.filterSave.then(() => this.saveFilter(filter));
    this.filterSave = saved;
    await saved;
    await listed;
  }

  private async saveFilter(filter: LibraryFilter): Promise<void> {
    // A newer choice is queued behind this one and saves itself.
    if (filter !== this.filter) return;
    try {
      await firstValueFrom(this.api.savePreferences({ libraryFilter: filter }));
    } catch (error) {
      this.error.set(errorMessage(error));
    }
  }

  /** Whether the piece still belongs in the list on screen. */
  private shown(piece: Piece): boolean {
    switch (this.filter) {
      case 'current':
        // A search never hides a shelved piece.
        return piece.status !== 'shelved' || !!this.query.trim();
      case 'all':
        return true;
      case 'favorites':
        return piece.favorite;
      default:
        return piece.status === this.filter;
    }
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
        filter: this.filter,
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
  /** A saved score longer than the preparation limit cannot be opened in Prepare. */
  protected tooLongToPrepare(piece: Piece | null): boolean {
    return (piece?.pdf?.pageCount ?? 0) > MAX_PREPARED_PAGES;
  }

  /** Opens Prepare for the piece, which is how a PDF is added, edited or replaced. */
  async editPages(): Promise<void> {
    if (!this.editing || this.saving() || this.tooLongToPrepare(this.editing)) return;
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
    this.error.set('');
    this.editing = null;
    this.form = emptyPiece();
    this.editor?.nativeElement.showModal();
  }

  openEdit(piece: Piece, event?: Event): void {
    event?.stopPropagation();
    this.error.set('');
    this.editing = piece;
    this.form = {
      title: piece.title,
      composer: piece.composer,
      favorite: piece.favorite,
      status: piece.status,
      sourceUrl: piece.sourceUrl,
      listeningUrl: piece.listeningUrl,
      notes: piece.notes,
    };
    this.editor?.nativeElement.showModal();
  }

  closeEditor(): void {
    if (this.saving()) return;
    this.editor?.nativeElement.close();
  }

  async save(): Promise<void> {
    const piece = await this.persistEditor();
    if (!piece) return;
    this.editor?.nativeElement.close();
    await this.load();
  }

  private editorDirty(): boolean {
    const piece = this.editing;
    if (!piece) return false;
    return (
      this.form.title !== piece.title ||
      this.form.composer !== piece.composer ||
      this.form.favorite !== piece.favorite ||
      this.form.status !== piece.status ||
      this.form.sourceUrl !== piece.sourceUrl ||
      this.form.listeningUrl.trim() !== piece.listeningUrl ||
      this.form.notes !== piece.notes
    );
  }

  private async persistEditor(): Promise<Piece | null> {
    this.form.listeningUrl = this.form.listeningUrl.trim();
    if (this.saving()) return null;
    if (!this.form.title.trim() || this.listeningUrlValidationError()) {
      this.error.set(this.listeningUrlValidationError() || 'Add a title first.');
      return null;
    }
    this.saving.set(true);
    this.error.set('');
    try {
      const piece = this.editing
        ? await firstValueFrom(this.api.updatePiece(this.editing.id, this.form))
        : await firstValueFrom(this.api.createPiece(this.form));
      this.editing = piece;
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
      this.showSaved(
        await firstValueFrom(this.api.updatePiece(piece.id, { favorite: !piece.favorite })),
      );
    } catch (error) {
      this.error.set(errorMessage(error));
    }
  }

  /**
   * Shows the choice at once and saves it. A row's saves run one at a time, and
   * only the latest choice is saved or shown, so a slow older request can never
   * overwrite a newer status. A failed save puts back the last saved row.
   */
  async changeStatus(piece: Piece, control: HTMLSelectElement): Promise<void> {
    const status = control.value as PieceStatus;
    if (status === piece.status) return;
    const pending = this.statusSaves.get(piece.id) ?? {
      latest: status,
      saved: piece,
      queue: Promise.resolve(),
      control,
    };
    pending.latest = status;
    pending.control = control;
    this.statusSaves.set(piece.id, pending);
    this.replaceRow({ ...piece, status });
    const done = pending.queue.then(() => this.saveStatus(piece.id, status, pending));
    pending.queue = done;
    await done;
    if (pending.queue === done) this.statusSaves.delete(piece.id);
  }

  private async saveStatus(id: string, status: PieceStatus, pending: StatusSave): Promise<void> {
    if (pending.latest !== status) return;
    try {
      const updated = await firstValueFrom(this.api.updatePiece(id, { status }));
      pending.saved = updated;
      if (pending.latest === status) this.showSaved(updated);
    } catch (error) {
      if (pending.latest !== status) return;
      this.error.set(errorMessage(error));
      this.replaceRow(pending.saved);
      pending.control.value = pending.saved.status;
    }
  }

  /** Shows a saved row, or drops it if it no longer fits the filter. */
  private showSaved(updated: Piece): void {
    if (this.shown(updated)) this.replaceRow(updated);
    else this.pieces.update((pieces) => pieces.filter((row) => row.id !== updated.id));
  }

  private replaceRow(piece: Piece): void {
    this.pieces.update((pieces) => pieces.map((row) => (row.id === piece.id ? piece : row)));
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

function emptyPiece(): PieceForm {
  return {
    title: '',
    composer: '',
    favorite: false,
    status: 'playing',
    sourceUrl: '',
    listeningUrl: '',
    notes: '',
  };
}
