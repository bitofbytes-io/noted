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
import { NgTemplateOutlet } from '@angular/common';
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
  forkJoin,
  map,
  of,
  switchMap,
} from 'rxjs';
import { ApiService, errorMessage } from '../../core/api.service';
import {
  LIBRARY_FILTERS,
  LIBRARY_SORTS,
  LibraryFilter,
  LibrarySort,
  MAX_PREPARED_PAGES,
  PIECE_STATUSES,
  Piece,
  PieceInput,
  PieceStatus,
  PieceSummary,
  Preferences,
  Session,
  ImportDraft,
  ShortcutToken,
  ShortcutTokenCreated,
} from '../../core/models';
import {
  filterAndSort,
  formatDay,
  lastUsedText,
  listeningUrlError,
  playedText,
  summaryOf,
} from './library.utils';
import { fold } from '../../core/search';
import { ChoiceMenuComponent } from './choice-menu.component';

/** The whole library, and the piece to continue whatever the filter. */
type PieceLoadResult =
  { pieces: PieceSummary[]; continued: PieceSummary | null } | { error: unknown };

/** One row's status saves: the latest choice, the last saved row, and the save queue. */
interface StatusSave {
  latest: PieceStatus;
  saved: PieceSummary;
  queue: Promise<void>;
  /** The row's select, reset directly on failure: a fast failure leaves no binding change. */
  control: HTMLSelectElement;
}

/** The details form always carries a status and aliases, unlike an import draft's metadata. */
type PieceForm = PieceInput & { status: PieceStatus; aliases: string };

/** The Send to Noted section: no token, a token just created (shown once), or an active one. */
type ShortcutState = 'loading' | 'none' | 'created' | 'active';

@Component({
  selector: 'app-library',
  imports: [
    ChoiceMenuComponent,
    FormsModule,
    NgTemplateOutlet,
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
  protected readonly librarySorts = LIBRARY_SORTS;
  protected readonly pieceStatuses = PIECE_STATUSES;
  /** The whole library, loaded once and again after a save or delete. */
  private readonly allPieces = signal<PieceSummary[]>([]);
  protected readonly query = signal('');
  /** Opens on the filter this user last chose, on any device. */
  protected readonly filter = signal<LibraryFilter>('current');
  /** Opens on the sort this user last chose, on any device; new users get Title. */
  protected readonly sort = signal<LibrarySort>('title');
  /** Punctuation alone folds to no search, as on the server. */
  protected readonly searching = computed(() => !!fold(this.query()));
  /** The pieces matching the search and filter, in order: filtered here on every keystroke. */
  protected readonly visible = computed(() =>
    filterAndSort(this.allPieces(), {
      query: this.query(),
      filter: this.filter(),
      sort: this.sort(),
    }),
  );
  /** Played lines belong to the sorts that order by them. */
  protected readonly showPlayed = computed(
    () => this.sort() === 'recent' || this.sort() === 'fresh',
  );
  protected readonly playedText = playedText;
  protected readonly lastUsedText = lastUsedText;
  /**
   * The piece played most recently (in the last two weeks) from the whole
   * library, whatever the filter, offered while not searching. Its row has the
   * usual actions, so it leaves the list below rather than showing twice.
   */
  private readonly offered = signal<PieceSummary | null>(null);
  protected readonly continued = computed(() => (this.searching() ? null : this.offered()));
  protected readonly listed = computed(() => {
    const continued = this.continued();
    const pieces = this.visible();
    return continued ? pieces.filter((piece) => piece.id !== continued.id) : pieces;
  });
  /** The default view is empty, but the binder is not: every piece is shelved. */
  protected readonly onlyShelved = computed(
    () =>
      this.filter() === 'current' &&
      !this.searching() &&
      this.allPieces().length > 0 &&
      this.allPieces().every((piece) => piece.status === 'shelved'),
  );
  /** Until the library and the remembered filter and sort have both arrived. */
  private readonly listedOnce = signal(false);
  private readonly preferencesSettled = signal(false);
  protected readonly loading = computed(() => !this.listedOnce() || !this.preferencesSettled());
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
  /** A filter or sort chosen before the remembered ones arrive wins over that one alone. */
  private filterChosen = false;
  private sortChosen = false;
  /** Saves run one at a time, so an older choice can never land after a newer one. */
  private preferenceSave: Promise<void> = Promise.resolve();
  /** Status saves still running, by piece. */
  private readonly statusSaves = new Map<string, StatusSave>();
  /** The whole piece in the details form, with its notes and source. */
  protected editing: Piece | null = null;
  protected form: PieceForm = emptyPiece();
  /** Ignores a details read that finishes after another row's details were asked for. */
  private editRequest = 0;
  private readonly pieceLoadRequests = new Subject<() => void>();
  private readonly pieceLoadSubscription: Subscription;

  constructor() {
    this.pieceLoadSubscription = this.pieceLoadRequests
      .pipe(
        // A newer load replaces an older one still running.
        switchMap((complete) =>
          forkJoin({
            pieces: defer(() => this.api.pieceSummaries()),
            // The library stays usable if Continue is unavailable.
            continued: defer(() => this.api.continuePiece()).pipe(catchError(() => of(null))),
          }).pipe(
            map(({ pieces, continued }): PieceLoadResult => ({
              pieces,
              continued: continued && summaryOf(continued),
            })),
            catchError((error: unknown) => of<PieceLoadResult>({ error })),
            finalize(complete),
          ),
        ),
      )
      .subscribe((result) => {
        if ('pieces' in result) {
          this.allPieces.set(result.pieces);
          this.offered.set(result.continued);
        } else {
          this.error.set(errorMessage(result.error));
        }
        this.listedOnce.set(true);
      });
    afterNextRender(() => {
      if (this.route.snapshot.queryParamMap.get('details') === 'new') {
        this.openCreate();
        void this.router.navigate([], { queryParams: {}, replaceUrl: true });
      }
    });
    void this.loadSession();
    this.loadPreferences();
    void this.load();
    void this.loadDrafts();
  }

  /** Loads the remembered filter and sort; a first-time user gets the defaults. */
  private loadPreferences(): void {
    this.api.preferences().subscribe({
      next: (preferences) => {
        if (
          !this.filterChosen &&
          LIBRARY_FILTERS.some((option) => option.value === preferences.libraryFilter)
        ) {
          this.filter.set(preferences.libraryFilter);
        }
        if (
          !this.sortChosen &&
          LIBRARY_SORTS.some((option) => option.value === preferences.librarySort)
        ) {
          this.sort.set(preferences.librarySort);
        }
        this.preferencesSettled.set(true);
      },
      // The library lists with the filter and sort shown.
      error: () => this.preferencesSettled.set(true),
    });
  }

  /** Shows the new filter at once and remembers it for this user's next visit. */
  async chooseFilter(filter: LibraryFilter): Promise<void> {
    this.filterChosen = true;
    if (filter === this.filter()) {
      // Before the remembered filter arrives, choosing the default shown still counts.
      if (!this.preferencesSettled()) await this.remember({ libraryFilter: filter });
      return;
    }
    this.filter.set(filter);
    await this.remember({ libraryFilter: filter });
  }

  /** Shows the new order at once and remembers it for this user's next visit. */
  async chooseSort(sort: LibrarySort): Promise<void> {
    this.sortChosen = true;
    if (sort === this.sort()) {
      // Before the remembered sort arrives, choosing the default shown still counts.
      if (!this.preferencesSettled()) await this.remember({ librarySort: sort });
      return;
    }
    this.sort.set(sort);
    await this.remember({ librarySort: sort });
  }

  private remember(change: Partial<Preferences>): Promise<void> {
    const saved = this.preferenceSave.then(() => this.savePreference(change));
    this.preferenceSave = saved;
    return saved;
  }

  private async savePreference(change: Partial<Preferences>): Promise<void> {
    // A newer choice is queued behind this one and saves itself.
    if (change.libraryFilter && change.libraryFilter !== this.filter()) return;
    if (change.librarySort && change.librarySort !== this.sort()) return;
    try {
      await firstValueFrom(this.api.savePreferences(change));
    } catch (error) {
      this.error.set(errorMessage(error));
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
    this.pieceLoadSubscription.unsubscribe();
    this.pieceLoadRequests.complete();
  }

  /** Loads the whole library from the server: on opening, and after a save or delete. */
  load(): Promise<void> {
    return new Promise((complete) => this.pieceLoadRequests.next(complete));
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
    this.editRequest++;
    this.error.set('');
    this.editing = null;
    this.form = emptyPiece();
    this.editor?.nativeElement.showModal();
  }

  /** Reads the whole piece, which a library row leaves out, then opens its details. */
  async openEdit(row: PieceSummary, event?: Event): Promise<void> {
    event?.stopPropagation();
    const request = ++this.editRequest;
    this.error.set('');
    let piece: Piece;
    try {
      piece = await firstValueFrom(this.api.piece(row.id));
    } catch (error) {
      if (request === this.editRequest) this.error.set(errorMessage(error));
      return;
    }
    if (request !== this.editRequest) return;
    this.editing = piece;
    this.form = {
      title: piece.title,
      composer: piece.composer,
      favorite: piece.favorite,
      status: piece.status,
      sourceUrl: piece.sourceUrl,
      listeningUrl: piece.listeningUrl,
      notes: piece.notes,
      aliases: piece.aliases,
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
      this.form.notes !== piece.notes ||
      this.form.aliases !== piece.aliases
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

  openPiece(piece: PieceSummary): void {
    if (piece.pdf) {
      void this.router.navigate(['/reader', piece.id]);
    } else {
      void this.openEdit(piece);
    }
  }

  openPieceFromKeyboard(piece: PieceSummary, event: Event): void {
    if (event.target === event.currentTarget) this.openPiece(piece);
  }

  protected listeningUrlValidationError(): string {
    return listeningUrlError(this.form.listeningUrl);
  }

  async toggleFavorite(piece: PieceSummary, event: Event): Promise<void> {
    event.stopPropagation();
    try {
      const updated = await firstValueFrom(
        this.api.updatePiece(piece.id, { favorite: !piece.favorite }),
      );
      this.replaceRow(summaryOf(updated));
    } catch (error) {
      this.error.set(errorMessage(error));
    }
  }

  /**
   * Shows the choice at once and saves it. A row's saves run one at a time, and
   * only the latest choice is saved or shown, so a slow older request can never
   * overwrite a newer status. A failed save puts back the last saved row. A row
   * that no longer fits the filter leaves the list at once; Continue spans the
   * whole library, so its row stays.
   */
  async changeStatus(piece: PieceSummary, control: HTMLSelectElement): Promise<void> {
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
      const updated = summaryOf(await firstValueFrom(this.api.updatePiece(id, { status })));
      pending.saved = updated;
      if (pending.latest === status) this.replaceRow(updated);
    } catch (error) {
      if (pending.latest !== status) return;
      this.error.set(errorMessage(error));
      this.replaceRow(pending.saved);
      pending.control.value = pending.saved.status;
    }
  }

  /** Shows a changed row; the list refilters and re-sorts itself. */
  private replaceRow(piece: PieceSummary): void {
    this.allPieces.update((pieces) => pieces.map((row) => (row.id === piece.id ? piece : row)));
    if (this.offered()?.id === piece.id) this.offered.set(piece);
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
    aliases: '',
  };
}
