import { Injectable, OnDestroy, computed, effect, inject, signal, untracked } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
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
import { rememberLibraryParams } from '../../core/library-address';
import {
  LIBRARY_FILTERS,
  LIBRARY_SORTS,
  LibraryFilter,
  LibrarySort,
  PieceStatus,
  PieceSummary,
  Preferences,
} from '../../core/models';
import { fold } from '../../core/search';
import {
  LibraryParams,
  LibraryView,
  filterAndSort,
  paramsOfView,
  summaryOf,
  viewFromParams,
} from './library.utils';

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

/**
 * The library's search, filter, sort and the piece list they operate on.
 * Provided on the library page, so a visit starts from a clean copy.
 */
@Injectable()
export class LibraryStore implements OnDestroy {
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  /** The search, filter and sort in the address, which win over the remembered ones. */
  private readonly addressed = viewFromParams(this.route.snapshot.queryParamMap);
  /** The whole library, loaded once and again after a save or delete. */
  readonly allPieces = signal<PieceSummary[]>([]);
  readonly query = signal(this.addressed.query ?? '');
  /** Opens on the address's filter, or else the one this user last chose, on any device. */
  readonly filter = signal<LibraryFilter>(this.addressed.filter ?? 'current');
  /** Opens on the address's sort, or else the one this user last chose; new users get Title. */
  readonly sort = signal<LibrarySort>(this.addressed.sort ?? 'title');
  /** The filter and sort the library opens on without them in the address. */
  private readonly rememberedFilter = signal<LibraryFilter>('current');
  private readonly rememberedSort = signal<LibrarySort>('title');
  /** Punctuation alone folds to no search, as on the server. */
  readonly searching = computed(() => !!fold(this.query()));
  /** The pieces matching the search and filter, in order: filtered here on every keystroke. */
  readonly visible = computed(() =>
    filterAndSort(this.allPieces(), {
      query: this.query(),
      filter: this.filter(),
      sort: this.sort(),
    }),
  );
  /** Played lines belong to the sorts that order by them. */
  readonly showPlayed = computed(() => this.sort() === 'recent' || this.sort() === 'fresh');
  /**
   * The piece played most recently (in the last two weeks) from the whole
   * library, whatever the filter. It is offered only while Recently played is
   * the sort and the search is empty: any other sort keeps its own order, so
   * opening a piece and coming back cannot pull it to the top. Its row has the
   * usual actions, so it leaves the list below rather than showing twice.
   */
  private readonly offered = signal<PieceSummary | null>(null);
  readonly continued = computed(() =>
    this.searching() || this.sort() !== 'recent' ? null : this.offered(),
  );
  readonly listed = computed(() => {
    const continued = this.continued();
    const pieces = this.visible();
    return continued ? pieces.filter((piece) => piece.id !== continued.id) : pieces;
  });
  /** The default view is empty, but the binder is not: every piece is shelved. */
  readonly onlyShelved = computed(
    () =>
      this.filter() === 'current' &&
      !this.searching() &&
      this.allPieces().length > 0 &&
      this.allPieces().every((piece) => piece.status === 'shelved'),
  );
  /** Until the library and the remembered filter and sort have both arrived. */
  private readonly listedOnce = signal(false);
  private readonly preferencesSettled = signal(false);
  readonly loading = computed(() => !this.listedOnce() || !this.preferencesSettled());
  readonly error = signal('');
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
    this.loadPreferences();
    void this.load();
  }

  ngOnDestroy(): void {
    this.pieceLoadSubscription.unsubscribe();
    this.pieceLoadRequests.complete();
  }

  /** Loads the whole library from the server: on opening, and after a save or delete. */
  load(): Promise<void> {
    return new Promise((complete) => this.pieceLoadRequests.next(complete));
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
