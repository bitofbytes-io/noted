import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { Subject, of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiService } from '../../core/api.service';
import {
  MAX_PREPARED_PAGES,
  Piece,
  Session,
  ShortcutToken,
  ShortcutTokenCreated,
} from '../../core/models';
import { LibraryComponent } from './library.component';
import {
  continuePiece,
  formatDay,
  lastUsedText,
  listeningUrlError,
  playedText,
} from './library.utils';

describe('LibraryComponent', () => {
  it('cancels a stale search so it cannot replace newer results', async () => {
    const stale = new Subject<Piece[]>();
    const latest = new Subject<Piece[]>();
    const api = {
      session: vi.fn(() => of({ authenticated: true, authMode: 'development', development: true })),
      imports: vi.fn(() => of([])),
      preferences: vi.fn(() => of({ libraryFilter: 'current' })),
      pieces: vi.fn().mockReturnValueOnce(stale).mockReturnValueOnce(latest),
    };
    await TestBed.configureTestingModule({
      imports: [LibraryComponent],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: convertToParamMap({}) } },
        },
        { provide: ApiService, useValue: api },
      ],
    }).compileComponents();
    const fixture: ComponentFixture<LibraryComponent> = TestBed.createComponent(LibraryComponent);
    fixture.detectChanges();
    const component = fixture.componentInstance;
    Reflect.set(component, 'query', 'new search');

    const latestLoad = component.load();
    expect(stale.observed).toBe(false);
    const latestPiece = { id: 'latest', title: 'Latest result' } as Piece;
    latest.next([latestPiece]);
    latest.complete();
    await latestLoad;

    stale.next([{ id: 'stale', title: 'Stale result' } as Piece]);
    stale.complete();
    expect(Reflect.get(component, 'pieces')()).toEqual([latestPiece]);
    fixture.destroy();
  });

  it('adds or replaces a PDF only through Prepare, and explains the page limit', async () => {
    const api = {
      session: vi.fn(() => of({ authenticated: true, authMode: 'development', development: true })),
      imports: vi.fn(() => of([])),
      preferences: vi.fn(() => of({ libraryFilter: 'current' })),
      pieces: vi.fn(() => of([])),
      createImport: vi.fn(() => of({ id: 'draft-1' })),
      updatePiece: vi.fn(),
    };
    await TestBed.configureTestingModule({
      imports: [LibraryComponent],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: convertToParamMap({}) } },
        },
        { provide: ApiService, useValue: api },
      ],
    }).compileComponents();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const fixture = TestBed.createComponent(LibraryComponent);
    fixture.detectChanges();
    const component = fixture.componentInstance;
    const dialog = fixture.nativeElement.querySelector('dialog') as HTMLDialogElement;
    dialog.showModal = vi.fn();
    dialog.close = vi.fn();
    const piece = (pageCount: number | null) =>
      ({
        id: `piece-${pageCount ?? 'none'}`,
        title: 'Score',
        composer: '',
        favorite: false,
        sourceUrl: '',
        listeningUrl: '',
        notes: '',
        pdf: pageCount === null ? null : { pageCount, contentUrl: '/api/pieces/x/pdf' },
      }) as Piece;
    const render = () => {
      fixture.componentRef.changeDetectorRef.markForCheck();
      fixture.detectChanges();
    };
    const actions = () =>
      [...fixture.nativeElement.querySelectorAll('.pdf-actions button, .pdf-actions a')].map(
        (action) => action.textContent.trim(),
      );
    const prepareButton = () =>
      fixture.nativeElement.querySelector('.pdf-actions button') as HTMLButtonElement;

    expect(fixture.nativeElement.querySelector('input[type="file"]')).toBeNull();

    component.openEdit(piece(null));
    render();
    expect(actions()).toEqual(['Add PDF']);
    prepareButton().click();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(api.createImport).toHaveBeenLastCalledWith('piece-none');
    expect(navigate).toHaveBeenLastCalledWith(['/prepare', 'draft-1'], {
      queryParams: { source: 'all' },
    });

    component.openEdit(piece(MAX_PREPARED_PAGES));
    render();
    expect(actions()).toEqual(['Edit or replace PDF', 'Download current PDF']);
    expect(fixture.nativeElement.querySelector('#edit-pages-limit')).toBeNull();
    prepareButton().click();
    await vi.waitFor(() =>
      expect(api.createImport).toHaveBeenLastCalledWith(`piece-${MAX_PREPARED_PAGES}`),
    );

    api.createImport.mockClear();
    component.openEdit(piece(MAX_PREPARED_PAGES + 1));
    render();
    expect(actions()).toEqual(['Download current PDF']);
    expect(fixture.nativeElement.querySelector('#edit-pages-limit').textContent).toContain(
      `up to ${MAX_PREPARED_PAGES} pages, so this score’s PDF`,
    );
    await component.editPages();
    expect(api.createImport).not.toHaveBeenCalled();
    expect(api.updatePiece).not.toHaveBeenCalled();
    fixture.destroy();
  });

  it('edits the other names a piece is searched by', async () => {
    const saved = {
      id: 'sonata',
      title: 'Piano Sonata No. 14',
      composer: 'Ludwig van Beethoven',
      favorite: false,
      status: 'playing',
      sourceUrl: '',
      listeningUrl: '',
      notes: '',
      aliases: '',
      pdf: null,
    } as Piece;
    const api = {
      session: vi.fn(() => of({ authenticated: true, authMode: 'development', development: true })),
      imports: vi.fn(() => of([])),
      preferences: vi.fn(() => of({ libraryFilter: 'current' })),
      pieces: vi.fn(() => of([saved])),
      updatePiece: vi.fn((_id: string, input: Partial<Piece>) => of({ ...saved, ...input })),
      createPiece: vi.fn((input: Partial<Piece>) => of({ ...saved, ...input, id: 'new' })),
    };
    await TestBed.configureTestingModule({
      imports: [LibraryComponent],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: convertToParamMap({}) } },
        },
        { provide: ApiService, useValue: api },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(LibraryComponent);
    fixture.detectChanges();
    const component = fixture.componentInstance;
    const dialog = fixture.nativeElement.querySelector('dialog') as HTMLDialogElement;
    dialog.showModal = vi.fn();
    dialog.close = vi.fn();
    const aliasesInput = () =>
      fixture.nativeElement.querySelector('input[name="aliases"]') as HTMLInputElement;

    component.openEdit({ ...saved, aliases: 'Moonlight' });
    fixture.componentRef.changeDetectorRef.markForCheck();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(aliasesInput().value).toBe('Moonlight');
    aliasesInput().value = 'Moonlight Sonata';
    aliasesInput().dispatchEvent(new Event('input'));
    await component.save();
    expect(api.updatePiece).toHaveBeenCalledWith(
      'sonata',
      expect.objectContaining({ aliases: 'Moonlight Sonata' }),
    );

    component.openCreate();
    expect(Reflect.get(component, 'form').aliases).toBe('');
    fixture.destroy();
  });

  it('treats a search of punctuation alone as no search', async () => {
    const shelved = { id: 'shelved', title: 'Shelved', status: 'shelved' } as Piece;
    const api = {
      session: vi.fn(() => of({ authenticated: true, authMode: 'development', development: true })),
      imports: vi.fn(() => of([])),
      preferences: vi.fn(() => of({ libraryFilter: 'current' })),
      // The default view is empty, but the binder holds a shelved piece.
      pieces: vi.fn((_query: string, filter: string) => of(filter === 'all' ? [shelved] : [])),
    };
    await TestBed.configureTestingModule({
      imports: [LibraryComponent],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: convertToParamMap({}) } },
        },
        { provide: ApiService, useValue: api },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(LibraryComponent);
    fixture.detectChanges();
    const component = fixture.componentInstance;

    Reflect.set(component, 'query', ' % ');
    await component.load();
    expect(Reflect.get(component, 'onlyShelved')()).toBe(true);

    Reflect.set(component, 'query', 'Dvořák');
    await component.load();
    expect(Reflect.get(component, 'onlyShelved')()).toBe(false);
    fixture.destroy();
  });
});

describe('LibraryComponent status and filter', () => {
  const row = (id: string, status: Piece['status'], favorite = false) =>
    ({
      id,
      title: `Piece ${id}`,
      composer: '',
      favorite,
      status,
      sourceUrl: '',
      listeningUrl: '',
      notes: '',
      aliases: '',
      pdf: null,
    }) as Piece;

  async function setup(libraryFilter: string, rows: Piece[], all: Piece[] = rows) {
    const api = {
      session: vi.fn(() => of({ authenticated: true, authMode: 'development', development: true })),
      imports: vi.fn(() => of([])),
      preferences: vi.fn(() => of({ libraryFilter })),
      savePreferences: vi.fn((preferences: unknown) => of(preferences)),
      pieces: vi.fn((_query: string, filter: string) => of(filter === 'all' ? all : rows)),
      updatePiece: vi.fn((id: string, change: Partial<Piece>) =>
        of({ ...rows.find((piece) => piece.id === id)!, ...change }),
      ),
    };
    await TestBed.configureTestingModule({
      imports: [LibraryComponent],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: convertToParamMap({}) } },
        },
        { provide: ApiService, useValue: api },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(LibraryComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const render = async () => {
      await fixture.whenStable();
      fixture.detectChanges();
    };
    const titles = () => [...root.querySelectorAll('.piece-row h2')].map((h) => h.textContent);
    return { fixture, api, root, render, titles };
  }

  it('opens on the remembered filter and remembers a new choice', async () => {
    const { fixture, api, root, render } = await setup('favorites', [row('a', 'shelved', true)]);
    const select = root.querySelector('.library-filter select') as HTMLSelectElement;
    expect(api.pieces).toHaveBeenCalledWith('', 'favorites', 'title');
    expect(select.value).toBe('favorites');
    expect([...select.options].map((option) => option.textContent?.trim())).toEqual([
      'Learning & Playing',
      'All',
      'Favorites',
      'Learning',
      'Playing',
      'Shelved',
    ]);

    select.value = 'shelved';
    select.dispatchEvent(new Event('change'));
    await render();
    expect(api.savePreferences).toHaveBeenCalledWith({ libraryFilter: 'shelved' });
    expect(api.pieces).toHaveBeenLastCalledWith('', 'shelved', 'title');
    fixture.destroy();
  });

  it('saves rapid filter choices one at a time, ending on the latest', async () => {
    const { fixture, api } = await setup('current', [row('a', 'playing')]);
    const component = fixture.componentInstance;
    const inFlight = new Subject<unknown>();
    api.savePreferences.mockImplementationOnce(() => inFlight);

    const first = component.chooseFilter('shelved');
    await vi.waitFor(() => expect(api.savePreferences).toHaveBeenCalledTimes(1));
    // While the first save is still open, two quick choices follow it.
    const second = component.chooseFilter('all');
    const third = component.chooseFilter('favorites');
    await Promise.resolve();
    expect(api.savePreferences).toHaveBeenCalledTimes(1);

    inFlight.next({ libraryFilter: 'shelved' });
    inFlight.complete();
    await Promise.all([first, second, third]);
    // The superseded choice is skipped, and the latest is saved last.
    expect(api.savePreferences.mock.calls).toEqual([
      [{ libraryFilter: 'shelved' }],
      [{ libraryFilter: 'favorites' }],
    ]);
    fixture.destroy();
  });

  it('changes a status from the row and drops it when it leaves the filter', async () => {
    const { fixture, api, root, render, titles } = await setup('current', [
      row('a', 'playing'),
      row('b', 'learning'),
    ]);
    expect(titles()).toEqual(['Piece a', 'Piece b']);
    const select = root.querySelector('.row-status select') as HTMLSelectElement;
    expect(select.value).toBe('playing');

    select.value = 'learning';
    select.dispatchEvent(new Event('change'));
    await render();
    expect(api.updatePiece).toHaveBeenLastCalledWith('a', { status: 'learning' });
    expect(titles()).toEqual(['Piece a', 'Piece b']);

    (root.querySelector('.row-status select') as HTMLSelectElement).value = 'shelved';
    root.querySelector('.row-status select')!.dispatchEvent(new Event('change'));
    await render();
    expect(api.updatePiece).toHaveBeenLastCalledWith('a', { status: 'shelved' });
    expect(titles()).toEqual(['Piece b']);
    fixture.destroy();
  });

  it('saves rapid status changes on a row in order and never shows a stale reply', async () => {
    const { fixture, api, root, render } = await setup('all', [row('a', 'playing')]);
    const inFlight = new Subject<Piece>();
    api.updatePiece.mockImplementationOnce(() => inFlight);
    const select = () => root.querySelector('.row-status select') as HTMLSelectElement;
    const choose = async (status: string) => {
      select().value = status;
      select().dispatchEvent(new Event('change'));
      await render();
    };

    await choose('learning');
    await choose('shelved');
    expect(api.updatePiece).toHaveBeenCalledTimes(1);
    expect(select().value).toBe('shelved');

    // The older reply arrives after the newer choice: it must not win.
    inFlight.next(row('a', 'learning'));
    inFlight.complete();
    await vi.waitFor(() => expect(api.updatePiece).toHaveBeenCalledTimes(2));
    await render();
    expect(api.updatePiece.mock.calls).toEqual([
      ['a', { status: 'learning' }],
      ['a', { status: 'shelved' }],
    ]);
    expect(select().value).toBe('shelved');
    fixture.destroy();
  });

  it('puts a row back to its saved status when a status change fails', async () => {
    const { fixture, api, root, render } = await setup('all', [row('a', 'playing')]);
    api.updatePiece.mockImplementationOnce(() => throwError(() => new Error('offline')));
    const select = root.querySelector('.row-status select') as HTMLSelectElement;
    select.value = 'shelved';
    select.dispatchEvent(new Event('change'));
    await vi.waitFor(async () => {
      await render();
      expect(root.querySelector('.notice')?.textContent).toContain('Offline.');
    });
    expect((root.querySelector('.row-status select') as HTMLSelectElement).value).toBe('playing');
    fixture.destroy();
  });

  it('says when the default view is empty only because everything is shelved', async () => {
    const { fixture, root } = await setup('current', [], [row('a', 'shelved')]);
    expect(root.querySelector('.empty-state h2')?.textContent).toBe(
      'Nothing in Learning or Playing',
    );
    fixture.destroy();
  });
});

describe('LibraryComponent sort and Continue', () => {
  afterEach(() => {
    vi.useRealTimers();
    // Focusing the sort menu leaves a document selection later specs rely on being empty.
    (document.activeElement as HTMLElement | null)?.blur();
    document.getSelection()?.removeAllRanges();
  });

  const NOW = new Date(2026, 9, 18, 20);
  const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
  const row = (id: string, lastPlayedAt: string | null, pdf = true) =>
    ({
      id,
      title: `Piece ${id}`,
      composer: 'Claude Debussy',
      favorite: false,
      status: 'playing',
      sourceUrl: '',
      listeningUrl: '',
      notes: '',
      pdf: pdf ? { pageCount: 2, contentUrl: `/api/pieces/${id}/pdf` } : null,
      lastPlayedAt,
    }) as Piece;

  async function setup(librarySort: string, rows: Piece[]) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const api = {
      session: vi.fn(() => of({ authenticated: true, authMode: 'development', development: true })),
      imports: vi.fn(() => of([])),
      preferences: vi.fn(() => of({ libraryFilter: 'current', librarySort })),
      savePreferences: vi.fn((preferences: unknown) => of(preferences)),
      pieces: vi.fn(() => of(rows)),
    };
    await TestBed.configureTestingModule({
      imports: [LibraryComponent],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: convertToParamMap({}) } },
        },
        { provide: ApiService, useValue: api },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(LibraryComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const render = async () => {
      await fixture.whenStable();
      fixture.detectChanges();
    };
    const sortButton = () => root.querySelector('.sort-button') as HTMLButtonElement;
    const options = () => [...root.querySelectorAll('.sort-options button')] as HTMLElement[];
    const listed = () =>
      [...root.querySelectorAll('.piece-list:not([aria-label]) .piece-row')].map((article) => ({
        title: article.querySelector('h2')?.textContent,
        note: article.querySelector('.piece-note')?.textContent ?? '',
      }));
    const continued = () => root.querySelector('.continue-row h2')?.textContent ?? null;
    return { fixture, api, root, render, sortButton, options, listed, continued };
  }

  it('opens on the remembered sort and remembers a new one from the menu', async () => {
    const { fixture, api, render, sortButton, options } = await setup('composer', [row('a', null)]);
    expect(api.pieces).toHaveBeenCalledWith('', 'current', 'composer');
    expect(sortButton().textContent).toContain('Sort: Composer');
    expect(options()).toEqual([]);

    sortButton().click();
    await render();
    expect(sortButton().getAttribute('aria-expanded')).toBe('true');
    const words = (option: HTMLElement) =>
      [...option.querySelectorAll('.sort-option > *')].map((part) => part.textContent?.trim());
    expect(options().map(words)).toEqual([
      ['Title'],
      ['Composer'],
      ['Recently played'],
      ['Recently added'],
      ['Fresh', 'least recently played first'],
    ]);
    // A green check marks the current choice, which takes the focus.
    const checked = options().filter((option) => option.getAttribute('aria-checked') === 'true');
    expect(checked.map((option) => option.textContent?.trim())).toEqual(['Composer']);
    expect(checked[0].querySelector('svg')).not.toBeNull();
    await vi.waitFor(() => expect(document.activeElement).toBe(checked[0]));

    options()[4].click();
    await render();
    expect(options()).toEqual([]);
    expect(sortButton().textContent).toContain('Sort: Fresh');
    expect(document.activeElement).toBe(sortButton());
    expect(api.savePreferences).toHaveBeenCalledWith({ librarySort: 'fresh' });
    expect(api.pieces).toHaveBeenLastCalledWith('', 'current', 'fresh');
    fixture.destroy();
  });

  it('closes the menu with Escape or an outside click, without choosing', async () => {
    const { fixture, api, root, render, sortButton, options } = await setup('title', [
      row('a', null),
    ]);
    sortButton().click();
    await render();
    await vi.waitFor(() => expect(document.activeElement).toBe(options()[0]));
    options()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(options()[1]);
    options()[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await render();
    expect(options()).toEqual([]);
    expect(document.activeElement).toBe(sortButton());

    sortButton().click();
    await render();
    (root.querySelector('h1') as HTMLElement).click();
    await render();
    expect(options()).toEqual([]);
    expect(api.savePreferences).not.toHaveBeenCalled();
    fixture.destroy();
  });

  it('shows Played lines only under Recently played and Fresh', async () => {
    const rows = [
      row('a', daysAgo(0)),
      row('b', daysAgo(3)),
      row('c', null),
      row('d', null, false),
    ];
    const { fixture, render, listed } = await setup('title', rows);
    expect(listed().map((piece) => piece.note)).toEqual(['', '', '', 'No PDF yet']);

    await fixture.componentInstance.chooseSort('fresh');
    await render();
    expect(listed().map((piece) => piece.note)).toEqual([
      'Played today',
      'Played 15 Oct 2026',
      'Not played yet',
      'No PDF yet',
    ]);
    fixture.destroy();
  });

  it('offers Continue for the latest piece played in two weeks, only while not searching', async () => {
    const rows = [row('a', daysAgo(3)), row('b', daysAgo(1)), row('c', null)];
    const { fixture, root, render, listed, continued } = await setup('title', rows);
    expect(continued()).toBe('Piece b');
    expect(root.querySelector('.continue-row .piece-note')?.textContent).toBe('Played yesterday');
    expect(root.querySelector('.continue-row button')?.textContent?.trim()).toBe('Continue');
    // Under Title the piece keeps its place in the list too.
    expect(listed().map((piece) => piece.title)).toEqual(['Piece a', 'Piece b', 'Piece c']);

    // Under Recently played too, so its Listen, status, favorite and edit stay at hand.
    await fixture.componentInstance.chooseSort('recent');
    await render();
    expect(continued()).toBe('Piece b');
    expect(listed().map((piece) => piece.title)).toEqual(['Piece a', 'Piece b', 'Piece c']);
    expect(
      root.querySelector('section[aria-label="Continue playing"] .continue-row'),
    ).not.toBeNull();
    expect(root.querySelector('.results-count p')?.textContent).toContain('3 pieces');

    Reflect.set(fixture.componentInstance, 'query', 'piece');
    await fixture.componentInstance.load();
    await render();
    expect(continued()).toBeNull();
    expect(listed().map((piece) => piece.title)).toEqual(['Piece a', 'Piece b', 'Piece c']);
    fixture.destroy();
  });

  it('keeps a filter or sort chosen before the remembered ones arrive, and only that one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const remembered = new Subject<unknown>();
    const api = {
      session: vi.fn(() => of({ authenticated: true, authMode: 'development', development: true })),
      imports: vi.fn(() => of([])),
      preferences: vi.fn(() => remembered),
      savePreferences: vi.fn((preferences: unknown) => of(preferences)),
      pieces: vi.fn(() => of([row('a', null)])),
    };
    await TestBed.configureTestingModule({
      imports: [LibraryComponent],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: convertToParamMap({}) } },
        },
        { provide: ApiService, useValue: api },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(LibraryComponent);
    fixture.detectChanges();
    const component = fixture.componentInstance;

    // Title is shown by default; choosing it early still overrides a remembered sort.
    await component.chooseSort('title');
    expect(api.savePreferences).toHaveBeenCalledWith({ librarySort: 'title' });
    await component.chooseFilter('shelved');
    remembered.next({ libraryFilter: 'favorites', librarySort: 'composer' });
    remembered.complete();
    await fixture.whenStable();
    expect(api.pieces).toHaveBeenLastCalledWith('', 'shelved', 'title');
    fixture.destroy();
  });

  it('applies the remembered sort when only the filter was chosen early', async () => {
    const remembered = new Subject<unknown>();
    const api = {
      session: vi.fn(() => of({ authenticated: true, authMode: 'development', development: true })),
      imports: vi.fn(() => of([])),
      preferences: vi.fn(() => remembered),
      savePreferences: vi.fn((preferences: unknown) => of(preferences)),
      pieces: vi.fn(() => of([row('a', null)])),
    };
    await TestBed.configureTestingModule({
      imports: [LibraryComponent],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: convertToParamMap({}) } },
        },
        { provide: ApiService, useValue: api },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(LibraryComponent);
    fixture.detectChanges();
    await fixture.componentInstance.chooseFilter('all');
    remembered.next({ libraryFilter: 'favorites', librarySort: 'composer' });
    remembered.complete();
    await fixture.whenStable();
    expect(api.pieces).toHaveBeenLastCalledWith('', 'all', 'composer');
    expect(api.savePreferences.mock.calls).toEqual([[{ libraryFilter: 'all' }]]);
    fixture.destroy();
  });

  it('leaves Continue out when nothing was played in the last two weeks', async () => {
    const { fixture, continued } = await setup('recent', [
      row('a', daysAgo(15)),
      row('b', daysAgo(1), false),
    ]);
    expect(continued()).toBeNull();
    fixture.destroy();
  });
});

describe('playedText and continuePiece', () => {
  it('names the day the piece was last played', () => {
    const now = new Date(2026, 9, 3, 0, 30);
    expect(playedText(null, now)).toBe('Not played yet');
    expect(playedText(new Date(2026, 9, 3, 0, 5).toISOString(), now)).toBe('Played today');
    expect(playedText(new Date(2026, 9, 2, 23).toISOString(), now)).toBe('Played yesterday');
    expect(playedText(new Date(2026, 8, 28, 12).toISOString(), now)).toBe('Played 28 Sep 2026');
  });

  it('picks the latest play within 14 days among pieces with a PDF', () => {
    const now = new Date(2026, 9, 18, 12);
    const at = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
    const pdf = {};
    expect(continuePiece([], now)).toBeNull();
    expect(
      continuePiece(
        [
          { id: 'old', pdf, lastPlayedAt: at(14.5) },
          { id: 'edge', pdf, lastPlayedAt: at(14) },
        ],
        now,
      )?.id,
    ).toBe('edge');
    expect(
      continuePiece(
        [
          { id: 'never', pdf, lastPlayedAt: null },
          { id: 'week', pdf, lastPlayedAt: at(7) },
          { id: 'no-pdf', pdf: null, lastPlayedAt: at(0) },
          { id: 'day', pdf, lastPlayedAt: at(1) },
        ],
        now,
      )?.id,
    ).toBe('day');
  });
});

const TOKEN = 'pR8xQ2nVf7Lw0mKaZc4HtYe9BjUs1GdNoI3vXb6Fq5E';
const REPLACEMENT = 'Zz9yXw8vUt7sRq6pOn5mLk4jIh3gFe2dCb1aZz9yXw8';

describe('LibraryComponent account dialog', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function setup(
    options: {
      development?: boolean;
      token?: ShortcutToken;
      created?: ShortcutTokenCreated[];
    } = {},
  ) {
    const session: Session = {
      authenticated: true,
      authMode: options.development ? 'development' : 'google',
      development: !!options.development,
      user: { id: 'u1', email: 'daniel@example.test', displayName: 'Daniel' },
    };
    const created = [...(options.created ?? [])];
    // Like the server: the status follows create and delete, and never holds the token.
    let status: ShortcutToken = options.token ?? {
      active: false,
      createdAt: null,
      lastUsedAt: null,
    };
    const api = {
      session: vi.fn(() => of(session)),
      imports: vi.fn(() => of([])),
      preferences: vi.fn(() => of({ libraryFilter: 'current' })),
      pieces: vi.fn(() => of([])),
      logout: vi.fn(() => of(undefined)),
      shortcutToken: vi.fn(() => of(status)),
      createShortcutToken: vi.fn(() => {
        const next = created.shift()!;
        status = { active: true, createdAt: next.createdAt, lastUsedAt: null };
        return of(next);
      }),
      deleteShortcutToken: vi.fn(() => {
        status = { active: false, createdAt: null, lastUsedAt: null };
        return of(undefined);
      }),
    };
    await TestBed.configureTestingModule({
      imports: [LibraryComponent],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: convertToParamMap({}) } },
        },
        { provide: ApiService, useValue: api },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(LibraryComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const dialog = root.querySelector('dialog.account') as HTMLDialogElement;
    dialog.showModal = vi.fn();
    dialog.close = vi.fn(() => dialog.dispatchEvent(new Event('close')));
    const render = async () => {
      await fixture.whenStable();
      fixture.detectChanges();
    };
    const buttons = (scope: ParentNode = dialog) =>
      [...scope.querySelectorAll('button')] as HTMLButtonElement[];
    const button = (label: string, scope: ParentNode = dialog) =>
      buttons(scope).find(
        (candidate) =>
          candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label,
      );
    const click = async (label: string, scope: ParentNode = dialog) => {
      const target = button(label, scope);
      expect(target, `button "${label}"`).toBeDefined();
      target!.click();
      await render();
    };
    const open = async () => {
      await click('Daniel', root.querySelector('.masthead')!);
    };
    const text = () => dialog.textContent?.replace(/\s+/g, ' ') ?? '';
    return { fixture, api, root, dialog, render, button, click, open, text };
  }

  it('opens from the display name, which is the masthead’s only account control', async () => {
    const { root, dialog, button, open, text, api } = await setup();
    const masthead = root.querySelector('.masthead')!;
    const name = button('Daniel', masthead)!;
    expect(name.getAttribute('aria-haspopup')).toBe('dialog');
    expect(button('Sign out', masthead)).toBeUndefined();
    expect(masthead.querySelector('.dev-chip')).toBeNull();

    await open();
    expect(dialog.showModal).toHaveBeenCalled();
    expect(api.shortcutToken).toHaveBeenCalledTimes(1);
    expect(text()).toContain('daniel@example.test');
    expect(text()).toContain(
      'Share a PDF from Safari or Files straight into a new draft on this iPad.',
    );
    expect(button('Set up on this iPad')).toBeDefined();
    expect(button('Replace')).toBeUndefined();
    expect(button('Sign out')).toBeDefined();
  });

  it('keeps the Dev chip and offers no Sign out in development', async () => {
    const { root, button, open } = await setup({ development: true });
    expect(root.querySelector('.masthead .dev-chip')?.textContent).toContain('Dev');
    await open();
    expect(button('Sign out')).toBeUndefined();
    expect(button('Set up on this iPad')).toBeDefined();
  });

  it('shows a new token once, then only its dates after closing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 1, 12));
    const { dialog, api, click, open, text, button, render } = await setup({
      created: [
        {
          token: TOKEN,
          createdAt: new Date(2026, 9, 1, 9).toISOString(),
        },
      ],
    });
    await open();
    await click('Set up on this iPad');
    expect(api.createShortcutToken).toHaveBeenCalledTimes(1);
    expect(dialog.querySelector('.shortcut-token code')?.textContent).toBe(TOKEN);
    // The signed template Noted serves; Shortcuts asks for the token on import.
    const template = dialog.querySelector('.shortcut-steps a') as HTMLAnchorElement;
    expect(template.textContent).toBe('Get the Shortcut');
    expect(template.getAttribute('href')).toBe('/send-to-noted.shortcut');
    expect(template.hasAttribute('download')).toBe(true);
    expect(template.target).toBe('');
    expect(text()).toContain(
      'Tap Add Shortcut, then open it in Shortcuts and paste this into the first text box:',
    );
    expect(text()).toContain('Tap Done. Share any PDF with Send to Noted.');
    expect(text()).toContain(
      'You won’t see this token again. If you lose it, come back and tap Replace.',
    );
    expect(button('Copy')).toBeDefined();

    await click('Close');
    expect(dialog.close).toHaveBeenCalled();
    await open();
    await render();
    expect(text()).not.toContain(TOKEN);
    expect(dialog.querySelector('.shortcut-token')).toBeNull();
    expect(text()).toContain('Set up on 1 Oct 2026 · last used never');
    expect(button('Replace')).toBeDefined();
    expect(button('Turn off')).toBeDefined();
  });

  it('offers the Shortcut again for a second device once set up', async () => {
    const { dialog, open, text } = await setup({
      token: { active: true, createdAt: '2026-10-01T09:00:00Z', lastUsedAt: null },
    });
    await open();
    const again = dialog.querySelector('.shortcut-again a') as HTMLAnchorElement;
    expect(again.textContent).toBe('Get the Shortcut again');
    expect(again.getAttribute('href')).toBe('/send-to-noted.shortcut');
    expect(again.hasAttribute('download')).toBe(true);
    expect(text()).toContain('You’ll need your token; if you don’t have it, tap Replace.');
    expect(dialog.querySelector('.shortcut-token')).toBeNull();
  });

  it('discards the token when the dialog closes with Escape', async () => {
    const { dialog, click, open, render, text } = await setup({
      created: [{ token: TOKEN, createdAt: '2026-10-01T09:00:00Z' }],
    });
    await open();
    await click('Set up on this iPad');
    dialog.dispatchEvent(new Event('close'));
    await render();
    expect(text()).not.toContain(TOKEN);
  });

  it('replaces the token only after the inline confirm', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 3, 12));
    const confirmSpy = vi.spyOn(window, 'confirm');
    const { dialog, api, click, open, text, button } = await setup({
      token: {
        active: true,
        createdAt: new Date(2026, 9, 1, 9).toISOString(),
        lastUsedAt: new Date(2026, 9, 2, 20).toISOString(),
      },
      created: [{ token: REPLACEMENT, createdAt: new Date().toISOString() }],
    });
    await open();
    expect(text()).toContain('Set up on 1 Oct 2026 · last used yesterday');

    await click('Replace');
    expect(api.createShortcutToken).not.toHaveBeenCalled();
    expect(text()).toContain(
      'Replace the token? The Shortcut on your iPad stops working until you paste the new one.',
    );
    await click('Cancel');
    expect(dialog.querySelector('.shortcut-confirm')).toBeNull();

    await click('Replace');
    await click('Replace token');
    expect(api.createShortcutToken).toHaveBeenCalledTimes(1);
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(dialog.querySelector('.shortcut-token code')?.textContent).toBe(REPLACEMENT);
    expect(button('Replace')).toBeUndefined();
  });

  it('turns the token off only after the inline confirm', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    const { api, click, open, text, button } = await setup({
      token: { active: true, createdAt: '2026-10-01T09:00:00Z', lastUsedAt: null },
    });
    await open();
    await click('Turn off');
    expect(api.deleteShortcutToken).not.toHaveBeenCalled();
    expect(text()).toContain('Turn off Send to Noted? The Shortcut on your iPad stops working.');
    const confirmBlock = document.querySelector('.shortcut-confirm')!;
    await click('Turn off', confirmBlock);
    expect(api.deleteShortcutToken).toHaveBeenCalledTimes(1);
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(button('Set up on this iPad')).toBeDefined();
    expect(button('Replace')).toBeUndefined();
  });

  it('keeps the dialog usable and says why when a token change fails', async () => {
    const { api, click, open, text, button } = await setup();
    api.createShortcutToken.mockReturnValueOnce(
      throwError(() => new Error('internal server error')),
    );
    await open();
    await click('Set up on this iPad');
    expect(text()).toContain('Internal server error.');
    expect(button('Set up on this iPad')?.disabled).toBe(false);
  });

  it('copies the token, and selects it when the clipboard refuses', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    const { fixture, dialog, open, text, button } = await setup({
      created: [{ token: TOKEN, createdAt: '2026-10-01T09:00:00Z' }],
    });
    const component = fixture.componentInstance;
    const settle = async () => {
      await vi.advanceTimersByTimeAsync(0);
      fixture.detectChanges();
    };
    void open();
    await settle();
    void component.createShortcut();
    await settle();

    button('Copy')!.click();
    await settle();
    expect(writeText).toHaveBeenCalledWith(TOKEN);
    expect(button('Copied')).toBeDefined();
    await vi.advanceTimersByTimeAsync(2000);
    fixture.detectChanges();
    expect(button('Copy')).toBeDefined();

    writeText.mockImplementationOnce(() => Promise.reject(new Error('NotAllowedError')));
    const selection = { removeAllRanges: vi.fn(), selectAllChildren: vi.fn() };
    vi.spyOn(window, 'getSelection').mockReturnValue(selection as unknown as Selection);
    button('Copy')!.click();
    await settle();
    expect(selection.selectAllChildren).toHaveBeenCalledWith(
      dialog.querySelector('.shortcut-token code'),
    );
    expect(text()).toContain('The token is selected. Copy it from the menu.');
    Reflect.deleteProperty(navigator, 'clipboard');
  });
});

describe('lastUsedText', () => {
  afterEach(() => vi.useRealTimers());

  it('names the day of last use', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 3, 0, 30));
    expect(lastUsedText(null)).toBe('never');
    expect(lastUsedText(new Date(2026, 9, 3, 0, 5).toISOString())).toBe('today');
    expect(lastUsedText(new Date(2026, 9, 2, 23, 59).toISOString())).toBe('yesterday');
    const older = new Date(2026, 8, 28, 12).toISOString();
    expect(lastUsedText(older)).toBe('28 Sep 2026');
    expect(formatDay(older)).toBe('28 Sep 2026');
  });
});

describe('listeningUrlError', () => {
  it('accepts empty and absolute HTTP(S) listening URLs', () => {
    expect(listeningUrlError('')).toBe('');
    expect(listeningUrlError('  https://www.youtube.com/watch?v=example  ')).toBe('');
  });

  it('rejects malformed and non-HTTP(S) listening URLs with a clear message', () => {
    expect(listeningUrlError('youtube.com/watch?v=example')).toBe(
      'listening URL must be an http or https URL',
    );
    expect(listeningUrlError('file:///tmp/recording.mp3')).toBe(
      'listening URL must be an http or https URL',
    );
  });
});
