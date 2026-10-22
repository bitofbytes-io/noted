import {
  ChangeDetectorRef,
  Component,
  ElementRef,
  HostListener,
  computed,
  effect,
  OnDestroy,
  ViewChild,
  inject,
  signal,
  untracked,
  afterNextRender,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
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
  LibraryParams,
  LibraryView,
  filterAndSort,
  formatDay,
  lastUsedText,
  listeningUrlError,
  paramsOfView,
  playedText,
  summaryOf,
  viewFromParams,
} from './library.utils';
import { fold } from '../../core/search';
import { SuggestionsComponent } from '../suggestions/suggestions.component';
import { ComposerFieldComponent } from '../composers/composer-field.component';
import { clearLibraryParams, rememberLibraryParams } from '../../core/library-address';
import { ChoiceMenuComponent } from './choice-menu.component';
import { MatchPartsPipe } from './match-parts.pipe';

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
    RouterLink,
    SuggestionsComponent,
    ComposerFieldComponent,
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
    MatchPartsPipe,
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
  @ViewChild('searchInput') private searchInput?: ElementRef<HTMLInputElement>;
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly changes = inject(ChangeDetectorRef);
  /** The search, filter and sort in the address, which win over the remembered ones. */
  private readonly addressed = viewFromParams(this.route.snapshot.queryParamMap);
  protected readonly libraryFilters = LIBRARY_FILTERS;
  protected readonly librarySorts = LIBRARY_SORTS;
  protected readonly pieceStatuses = PIECE_STATUSES;
  /** The whole library, loaded once and again after a save or delete. */
  private readonly allPieces = signal<PieceSummary[]>([]);
  protected readonly query = signal(this.addressed.query ?? '');
  /** Opens on the address's filter, or else the one this user last chose, on any device. */
  protected readonly filter = signal<LibraryFilter>(this.addressed.filter ?? 'current');
  /** Opens on the address's sort, or else the one this user last chose; new users get Title. */
  protected readonly sort = signal<LibrarySort>(this.addressed.sort ?? 'title');
  /** The filter and sort the library opens on without them in the address. */
  private readonly rememberedFilter = signal<LibraryFilter>('current');
  private readonly rememberedSort = signal<LibrarySort>('title');
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
  /** Set once that choice has been stored, so a slower preferences read cannot replace it. */
  private filterSaved = false;
  private sortSaved = false;
  /** The address named these on open, so they stay even though this tab did not choose them. */
  private readonly filterFromAddress = this.addressed.filter !== undefined;
  private readonly sortFromAddress = this.addressed.sort !== undefined;
  /**
   * The address last written, so only a change is written. Add a piece opened
   * from Prepare leaves details=new to drop, so that address counts as unwritten.
   */
  private writtenAddress: string | null =
    this.route.snapshot.queryParamMap.get('details') === 'new'
      ? null
      : addressKey(paramsFromSnapshot(this.route.snapshot.queryParamMap));
  /** Saves run one at a time, so an older choice can never land after a newer one. */
  private preferenceSave: Promise<void> = Promise.resolve();
  /** Status saves still running, by piece. */
  private readonly statusSaves = new Map<string, StatusSave>();
  /** The whole piece in the details form, with its notes and source. */
  protected editing: Piece | null = null;
  protected form: PieceForm = emptyPiece();

  // Form fields are plain properties: evaluate after each input event, rather
  // than caching a computed signal that would not track title edits.
  protected duplicateTitle(): PieceSummary | undefined {
    const title = fold(this.form.title.trim());
    if (!title) return undefined;
    return this.allPieces().find(
      (piece) => piece.id !== this.editing?.id && fold(piece.title.trim()) === title,
    );
  }
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
      // The address is written again below, without details=new.
      if (this.route.snapshot.queryParamMap.get('details') === 'new') this.openCreate();
    });
    // The address follows the view, so a reload keeps it and the reader can return to it.
    effect(() => {
      // Until then, the filter and sort shown may not be the ones the library opens on.
      if (!this.preferencesSettled()) return;
      const params = paramsOfView(this.view(), this.remembered(), {
        filter: this.filterFromAddress || this.filterChosen,
        sort: this.sortFromAddress || this.sortChosen,
      });
      untracked(() => this.writeAddress(params));
    });
    void this.loadSession();
    this.loadPreferences();
    void this.load();
    void this.loadDrafts();
  }

  private view(): LibraryView {
    return { query: this.query(), filter: this.filter(), sort: this.sort() };
  }

  private remembered(): Pick<LibraryView, 'filter' | 'sort'> {
    return { filter: this.rememberedFilter(), sort: this.rememberedSort() };
  }

  private writeAddress(params: LibraryParams): void {
    rememberLibraryParams(params);
    const key = addressKey(params);
    if (key === this.writtenAddress) return;
    this.writtenAddress = key;
    // Replaced, not pushed: Back leaves the library rather than undoing a keystroke.
    void this.router.navigate([], { queryParams: params, replaceUrl: true });
  }

  /** Loads the remembered filter and sort; a first-time user gets the defaults. */
  private loadPreferences(): void {
    this.api.preferences().subscribe({
      next: (preferences) => {
        if (LIBRARY_FILTERS.some((option) => option.value === preferences.libraryFilter)) {
          // A choice that has already been saved wins over a slower read of the old one.
          if (!this.filterChosen) {
            this.rememberedFilter.set(preferences.libraryFilter);
            if (!this.addressed.filter) this.filter.set(preferences.libraryFilter);
          } else if (!this.filterSaved) {
            this.rememberedFilter.set(preferences.libraryFilter);
          }
        }
        if (LIBRARY_SORTS.some((option) => option.value === preferences.librarySort)) {
          if (!this.sortChosen) {
            this.rememberedSort.set(preferences.librarySort);
            if (!this.addressed.sort) this.sort.set(preferences.librarySort);
          } else if (!this.sortSaved) {
            this.rememberedSort.set(preferences.librarySort);
          }
        }
        this.preferencesSettled.set(true);
      },
      // The library lists with the filter and sort shown.
      error: () => this.preferencesSettled.set(true),
    });
  }

  /** Shows the new filter at once and remembers it for this user's next visit. */
  async chooseFilter(filter: LibraryFilter): Promise<void> {
    // Choosing the filter already shown, once the server's copy is known, changes nothing.
    if (
      this.preferencesSettled() &&
      filter === this.filter() &&
      filter === this.rememberedFilter()
    ) {
      return;
    }
    this.filterChosen = true;
    this.filter.set(filter);
    await this.remember({ libraryFilter: filter });
  }

  /** Shows the new order at once and remembers it for this user's next visit. */
  async chooseSort(sort: LibrarySort): Promise<void> {
    if (this.preferencesSettled() && sort === this.sort() && sort === this.rememberedSort()) {
      return;
    }
    this.sortChosen = true;
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
      // Only a saved choice becomes what a bare address opens on. Until then the
      // address keeps the choice, so a failed save cannot fall back to the old one.
      if (change.libraryFilter && change.libraryFilter === this.filter()) {
        this.filterSaved = true;
        this.rememberedFilter.set(change.libraryFilter);
      }
      if (change.librarySort && change.librarySort === this.sort()) {
        this.sortSaved = true;
        this.rememberedSort.set(change.librarySort);
      }
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
      clearLibraryParams();
      // Drop the search from the address too, so the next account is not returned to it.
      window.location.replace('/');
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
      opus: piece.opus ?? '',
      musicKey: piece.musicKey ?? '',
    };
    // The form fields are not signals, and nothing else marks the view after the read.
    this.changes.markForCheck();
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
      this.form.aliases !== piece.aliases ||
      this.form.opus !== (piece.opus ?? '') ||
      this.form.musicKey !== (piece.musicKey ?? '')
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

  /** "/" goes to the search from anywhere but a field or a dialog. */
  @HostListener('document:keydown', ['$event'])
  protected focusSearch(event: KeyboardEvent): void {
    if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.isContentEditable || target?.closest('input, textarea, select, dialog')) return;
    if (this.host.nativeElement.querySelector('dialog[open]')) return;
    event.preventDefault();
    this.searchInput?.nativeElement.focus();
  }

  /**
   * Enter opens the first result, or the first similar match when nothing
   * matches exactly. Down moves to that same row. Escape clears the search.
   */
  protected searchKey(event: KeyboardEvent): void {
    if (event.isComposing) return;
    if (event.key === 'Enter') {
      const first = this.listed()[0];
      if (this.searching() && first) {
        event.preventDefault();
        this.openPiece(first);
        return;
      }
      const suggestion = this.suggestionButtons()[0];
      if (!suggestion) return;
      event.preventDefault();
      suggestion.click();
    } else if (event.key === 'ArrowDown') {
      const row = this.rows()[0] ?? this.suggestionButtons()[0];
      if (!row) return;
      event.preventDefault();
      row.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      if (this.query()) this.clearSearch();
      else this.searchInput?.nativeElement.blur();
    }
  }

  /** Up and Down move between rows, Up from the first back to the search; Escape clears it. */
  protected rowKey(event: KeyboardEvent): void {
    const rows = this.rows();
    const at = rows.indexOf(event.currentTarget as HTMLElement);
    let next: HTMLElement | undefined;
    if (event.key === 'ArrowDown') {
      next = rows[at + 1];
    } else if (event.key === 'ArrowUp') {
      next = at > 0 ? rows[at - 1] : this.searchInput?.nativeElement;
    } else if (event.key === 'Escape') {
      this.clearSearch();
      next = this.searchInput?.nativeElement;
    }
    if (!next) return;
    event.preventDefault();
    next.focus();
  }

  /** Empties the field at once too, so a letter typed straight after is not added to the old search. */
  private clearSearch(): void {
    this.query.set('');
    if (this.searchInput) this.searchInput.nativeElement.value = '';
  }

  /** The rows that open a piece, as shown: Continue first. */
  private rows(): HTMLElement[] {
    return [
      ...this.host.nativeElement.querySelectorAll<HTMLElement>('.results .piece-row[tabindex]'),
    ];
  }

  /** Similar matches shown when the search itself has no row to open. */
  private suggestionButtons(): HTMLElement[] {
    return [...this.host.nativeElement.querySelectorAll<HTMLElement>('.suggestions .suggestion')];
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

/** The search, filter and sort an address names as written, known or not. */
function paramsFromSnapshot(params: { get(name: string): string | null }): LibraryParams {
  return {
    q: params.get('q') ?? undefined,
    show: params.get('show') ?? undefined,
    sort: params.get('sort') ?? undefined,
  };
}

/** One address, however its parameters were put together. */
function addressKey(params: LibraryParams): string {
  return JSON.stringify([params.q ?? '', params.show ?? '', params.sort ?? '']);
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
    opus: '',
    musicKey: '',
  };
}
