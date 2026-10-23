import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { Subject, of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiService } from '../../core/api.service';
import {
  MAX_PREPARED_PAGES,
  Piece,
  PieceSummary,
  Session,
  ShortcutToken,
  ShortcutTokenCreated,
} from '../../core/models';
import { LibraryComponent } from './library.component';
import { formatDay, lastUsedText, listeningUrlError, playedText, summaryOf } from './library.utils';

/** A test piece that is both a whole piece and its library row. */
type TestPiece = Piece & PieceSummary;

function testPiece(fields: Partial<Piece> & Pick<Piece, 'id' | 'title'>): TestPiece {
  const piece = {
    composer: '',
    favorite: false,
    status: 'playing',
    sourceUrl: '',
    listeningUrl: '',
    notes: '',
    aliases: '',
    opus: '',
    musicKey: '',
    createdAt: '2026-10-01T09:00:00Z',
    updatedAt: '2026-10-01T09:00:00Z',
    pdf: null,
    lastPlayedAt: null,
    ...fields,
  } as Piece;
  return { ...piece, searchText: summaryOf(piece).searchText };
}

describe('LibraryComponent', () => {
  it('lets a newer load replace an older one still running', async () => {
    const stale = new Subject<PieceSummary[]>();
    const latest = new Subject<PieceSummary[]>();
    const api = {
      session: vi.fn(() => of({ authenticated: true, authMode: 'development', development: true })),
      imports: vi.fn(() => of([])),
      preferences: vi.fn(() => of({ libraryFilter: 'current' })),
      pieceSummaries: vi.fn().mockReturnValueOnce(stale).mockReturnValueOnce(latest),
      continuePiece: vi.fn(() => of(null)),
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
    expect(stale.observed).toBe(true);

    const latestLoad = component.load();
    expect(stale.observed).toBe(false);
    const latestPiece = testPiece({ id: 'latest', title: 'Latest result' });
    latest.next([latestPiece]);
    latest.complete();
    await latestLoad;

    stale.next([testPiece({ id: 'stale', title: 'Stale result' })]);
    stale.complete();
    expect(Reflect.get(component, 'visible')()).toEqual([latestPiece]);
    fixture.destroy();
  });

  it('filters the loaded library as the search is typed, without asking the server', async () => {
    const pieces = [
      testPiece({ id: 'humoresque', title: 'Humoresque', composer: 'Antonín Dvořák' }),
      testPiece({ id: 'nocturne', title: 'Nocturne in C♯ minor', composer: 'Frédéric Chopin' }),
      testPiece({
        id: 'prelude',
        title: 'Prelude Op. 28 No. 4',
        composer: 'Frédéric Chopin',
        notes: 'Keep the left hand quiet',
      }),
      testPiece({
        id: 'shelved',
        title: 'Gymnopédie No. 1',
        composer: 'Erik Satie',
        status: 'shelved',
      }),
    ];
    const api = {
      session: vi.fn(() => of({ authenticated: true, authMode: 'development', development: true })),
      imports: vi.fn(() => of([])),
      preferences: vi.fn(() => of({ libraryFilter: 'current', librarySort: 'title' })),
      pieceSummaries: vi.fn(() => of(pieces)),
      continuePiece: vi.fn(() => of(null)),
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
    const input = root.querySelector('.search input') as HTMLInputElement;
    const type = (text: string) => {
      input.value = text;
      input.dispatchEvent(new Event('input'));
      fixture.detectChanges();
      return [...root.querySelectorAll('.piece-row h2')].map((h) => h.textContent);
    };

    expect(type('')).toEqual(['Humoresque', 'Nocturne in C♯ minor', 'Prelude Op. 28 No. 4']);
    // Accents fold away, and every word must match, in any field.
    expect(type('dvorak')).toEqual(['Humoresque']);
    expect(type('chopin c#')).toEqual(['Nocturne in C♯ minor']);
    // Notes are searched through the search text the server folded.
    expect(type('left hand')).toEqual(['Prelude Op. 28 No. 4']);
    // A search never hides a shelved piece.
    expect(type('satie')).toEqual(['Gymnopédie No. 1']);
    expect(root.querySelector('.results-count p')?.textContent?.replace(/\s+/g, ' ')).toContain(
      '1 piece matching “satie”',
    );
    expect(type('chopin waltz')).toEqual([]);
    expect(root.querySelector('.empty-state h2')?.textContent).toBe('No matching pieces');
    // Whole terms outrank prefixes, even a title prefix; remaining matches further in.
    expect(type('no')).toEqual([
      'Gymnopédie No. 1',
      'Prelude Op. 28 No. 4',
      'Nocturne in C♯ minor',
    ]);
    expect(api.pieceSummaries).toHaveBeenCalledTimes(1);
    fixture.destroy();
  });

  it('adds or replaces a PDF only through Prepare, and explains the page limit', async () => {
    const api = {
      session: vi.fn(() => of({ authenticated: true, authMode: 'development', development: true })),
      imports: vi.fn(() => of([])),
      preferences: vi.fn(() => of({ libraryFilter: 'current' })),
      pieceSummaries: vi.fn(() => of([])),
      continuePiece: vi.fn(() => of(null)),
      piece: vi.fn(),
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
      testPiece({
        id: `piece-${pageCount ?? 'none'}`,
        title: 'Score',
        pdf:
          pageCount === null
            ? null
            : ({ pageCount, contentUrl: '/api/pieces/x/pdf' } as Piece['pdf']),
      });
    const render = () => {
      fixture.componentRef.changeDetectorRef.markForCheck();
      fixture.detectChanges();
    };
    // The details form reads the whole piece first.
    const openEdit = async (whole: TestPiece) => {
      api.piece.mockReturnValueOnce(of(whole));
      await component.openEdit(whole);
      expect(api.piece).toHaveBeenLastCalledWith(whole.id);
    };
    const actions = () =>
      [...fixture.nativeElement.querySelectorAll('.pdf-actions button, .pdf-actions a')].map(
        (action) => action.textContent.trim(),
      );
    const prepareButton = () =>
      fixture.nativeElement.querySelector('.pdf-actions button') as HTMLButtonElement;

    expect(fixture.nativeElement.querySelector('input[type="file"]')).toBeNull();

    await openEdit(piece(null));
    render();
    expect(actions()).toEqual(['Add PDF']);
    prepareButton().click();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(api.createImport).toHaveBeenLastCalledWith('piece-none');
    expect(navigate).toHaveBeenLastCalledWith(['/prepare', 'draft-1'], {
      queryParams: { source: 'all' },
    });

    await openEdit(piece(MAX_PREPARED_PAGES));
    render();
    expect(actions()).toEqual(['Edit or replace PDF', 'Download current PDF']);
    expect(fixture.nativeElement.querySelector('#edit-pages-limit')).toBeNull();
    prepareButton().click();
    await vi.waitFor(() =>
      expect(api.createImport).toHaveBeenLastCalledWith(`piece-${MAX_PREPARED_PAGES}`),
    );

    api.createImport.mockClear();
    await openEdit(piece(MAX_PREPARED_PAGES + 1));
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
    const saved = testPiece({
      id: 'sonata',
      title: 'Piano Sonata No. 14',
      composer: 'Ludwig van Beethoven',
      notes: 'Pedal through each bar',
      sourceUrl: 'https://example.test/sonata',
    });
    const api = {
      session: vi.fn(() => of({ authenticated: true, authMode: 'development', development: true })),
      imports: vi.fn(() => of([])),
      preferences: vi.fn(() => of({ libraryFilter: 'current' })),
      pieceSummaries: vi.fn(() => of([saved])),
      continuePiece: vi.fn(() => of(null)),
      piece: vi.fn(() =>
        of({ ...saved, aliases: 'Moonlight', opus: 'Op. 27 No. 2', musicKey: 'C♯ minor' }),
      ),
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

    // A library row has no notes or source; the form reads them from the whole piece.
    await component.openEdit(saved);
    expect(api.piece).toHaveBeenCalledWith('sonata');
    // The form fills itself once the whole piece arrives, with no change detection forced here.
    await fixture.whenStable();
    expect(aliasesInput().value).toBe('Moonlight');
    const opusInput = fixture.nativeElement.querySelector('input[name="opus"]') as HTMLInputElement;
    const keyInput = fixture.nativeElement.querySelector(
      'input[name="musicKey"]',
    ) as HTMLInputElement;
    expect(opusInput.value).toBe('Op. 27 No. 2');
    expect(keyInput.value).toBe('C♯ minor');
    opusInput.value = '';
    opusInput.dispatchEvent(new Event('input'));
    keyInput.value = 'D minor';
    keyInput.dispatchEvent(new Event('input'));
    expect(
      (fixture.nativeElement.querySelector('textarea[name="notes"]') as HTMLTextAreaElement).value,
    ).toBe('Pedal through each bar');
    expect(fixture.nativeElement.querySelector('.editor-head h2').textContent).toBe(
      'Piano Sonata No. 14',
    );
    expect(Reflect.get(component, 'form').notes).toBe('Pedal through each bar');
    expect(Reflect.get(component, 'form').sourceUrl).toBe('https://example.test/sonata');
    aliasesInput().value = 'Moonlight Sonata';
    aliasesInput().dispatchEvent(new Event('input'));
    await component.save();
    expect(api.updatePiece).toHaveBeenCalledWith(
      'sonata',
      expect.objectContaining({
        aliases: 'Moonlight Sonata',
        notes: 'Pedal through each bar',
        opus: '',
        musicKey: 'D minor',
      }),
    );
    // Saving reloads the library from the server.
    expect(api.pieceSummaries).toHaveBeenCalledTimes(2);

    component.openCreate();
    expect(Reflect.get(component, 'form').aliases).toBe('');
    fixture.destroy();
  });

  it('treats a search of punctuation alone as no search', async () => {
    // The default view is empty, but the binder holds a shelved piece.
    const shelved = testPiece({ id: 'shelved', title: 'Shelved', status: 'shelved' });
    const api = {
      session: vi.fn(() => of({ authenticated: true, authMode: 'development', development: true })),
      imports: vi.fn(() => of([])),
      preferences: vi.fn(() => of({ libraryFilter: 'current' })),
      pieceSummaries: vi.fn(() => of([shelved])),
      continuePiece: vi.fn(() => of(null)),
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

    const query = Reflect.get(component, 'query');
    query.set(' % ');
    expect(Reflect.get(component, 'onlyShelved')()).toBe(true);
    expect(Reflect.get(component, 'visible')()).toEqual([]);
    await fixture.whenStable();
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.results-count p')?.textContent).not.toContain('matching');
    expect(root.querySelector('.empty-state h2')?.textContent).toBe(
      'Nothing in Learning or Playing',
    );

    query.set('Dvořák');
    expect(Reflect.get(component, 'onlyShelved')()).toBe(false);
    fixture.destroy();
  });
});

describe('LibraryComponent status and filter', () => {
  const row = (id: string, status: Piece['status'], favorite = false) =>
    testPiece({ id, title: `Piece ${id}`, status, favorite });

  /** `rows` is the whole library, which the component filters itself. */
  async function setup(libraryFilter: string, rows: TestPiece[]) {
    const api = {
      session: vi.fn(() => of({ authenticated: true, authMode: 'development', development: true })),
      imports: vi.fn(() => of([])),
      preferences: vi.fn(() => of({ libraryFilter })),
      savePreferences: vi.fn((preferences: unknown) => of(preferences)),
      pieceSummaries: vi.fn(() => of(rows)),
      continuePiece: vi.fn(() => of(null)),
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

  it('opens on the remembered filter and remembers a new choice from the menu', async () => {
    const { fixture, api, root, render, titles } = await setup('favorites', [
      row('a', 'shelved', true),
      row('b', 'playing'),
      row('c', 'shelved'),
    ]);
    const button = () => root.querySelector('.filter-menu .menu-button') as HTMLButtonElement;
    const options = () =>
      [...root.querySelectorAll('.filter-menu .menu-options button')] as HTMLElement[];
    expect(titles()).toEqual(['Piece a']);
    // The button shows only the choice; assistive technology hears "Show: Favorites".
    expect(button().textContent?.trim()).toBe('Show: Favorites');
    expect(button().querySelector('.sr-only')?.textContent).toBe('Show: ');
    expect(root.querySelector('.search-row select')).toBeNull();

    button().click();
    await render();
    expect(root.querySelector('.filter-menu [role="menu"]')?.getAttribute('aria-label')).toBe(
      'Show',
    );
    expect(options().map((option) => option.textContent?.trim())).toEqual([
      'Learning & Playing',
      'All',
      'Favorites',
      'Learning',
      'Playing',
      'Shelved',
    ]);
    const checked = options().filter((option) => option.getAttribute('aria-checked') === 'true');
    expect(checked.map((option) => option.textContent?.trim())).toEqual(['Favorites']);
    expect(checked[0].querySelector('svg')).not.toBeNull();
    await vi.waitFor(() => expect(document.activeElement).toBe(checked[0]));

    options()[5].click();
    await render();
    expect(options()).toEqual([]);
    expect(button().textContent?.trim()).toBe('Show: Shelved');
    expect(document.activeElement).toBe(button());
    expect(api.savePreferences).toHaveBeenCalledWith({ libraryFilter: 'shelved' });
    // The library filters what it loaded; it does not ask the server again.
    expect(titles()).toEqual(['Piece a', 'Piece c']);
    expect(api.pieceSummaries).toHaveBeenCalledTimes(1);

    // Choosing the current filter again does not save.
    await fixture.componentInstance.chooseFilter('shelved');
    expect(api.savePreferences).toHaveBeenCalledTimes(1);
    fixture.destroy();
  });

  it('opens one menu at a time', async () => {
    const { fixture, root, render } = await setup('current', [row('a', 'playing')]);
    const menus = () => [...root.querySelectorAll('[role="menu"]')].map((menu) => menu.id);
    (root.querySelector('.filter-menu .menu-button') as HTMLButtonElement).click();
    await render();
    expect(menus().length).toBe(1);
    const filterMenu = menus()[0];
    (root.querySelector('.sort-menu .menu-button') as HTMLButtonElement).click();
    await render();
    expect(menus().length).toBe(1);
    expect(menus()[0]).not.toBe(filterMenu);
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
    const inFlight = new Subject<TestPiece>();
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
    const { fixture, root } = await setup('current', [row('a', 'shelved')]);
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
    testPiece({
      id,
      title: `Piece ${id}`,
      composer: 'Claude Debussy',
      pdf: pdf ? ({ pageCount: 2, contentUrl: `/api/pieces/${id}/pdf` } as Piece['pdf']) : null,
      lastPlayedAt,
    });

  /** `rows` is the whole library; `offered` is the piece the server offers to continue. */
  async function setup(librarySort: string, rows: TestPiece[], offered: TestPiece | null = null) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const api = {
      session: vi.fn(() => of({ authenticated: true, authMode: 'development', development: true })),
      imports: vi.fn(() => of([])),
      preferences: vi.fn(() => of({ libraryFilter: 'current', librarySort })),
      savePreferences: vi.fn((preferences: unknown) => of(preferences)),
      pieceSummaries: vi.fn(() => of(rows)),
      continuePiece: vi.fn(() => of(offered)),
      updatePiece: vi.fn((id: string, change: Partial<Piece>) =>
        of({ ...[offered, ...rows].find((piece) => piece?.id === id)!, ...change }),
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
    const sortButton = () => root.querySelector('.sort-menu .menu-button') as HTMLButtonElement;
    const options = () =>
      [...root.querySelectorAll('.sort-menu .menu-options button')] as HTMLElement[];
    const listed = () =>
      [...root.querySelectorAll('.piece-list:not([aria-label]) .piece-row')].map((article) => ({
        title: article.querySelector('h2')?.textContent,
        note: article.querySelector('.piece-note')?.textContent ?? '',
      }));
    const continued = () => root.querySelector('.continue-row h2')?.textContent ?? null;
    return { fixture, api, root, render, sortButton, options, listed, continued };
  }

  it('opens on the remembered sort and remembers a new one from the menu', async () => {
    const { fixture, api, render, sortButton, options, listed } = await setup('composer', [
      row('a', null),
      testPiece({ ...row('b', daysAgo(2)), composer: 'Johann Sebastian Bach' }),
    ]);
    expect(listed().map((piece) => piece.title)).toEqual(['Piece b', 'Piece a']);
    expect(sortButton().textContent).toContain('Sort: Composer');
    expect(options()).toEqual([]);

    sortButton().click();
    await render();
    expect(sortButton().getAttribute('aria-expanded')).toBe('true');
    const words = (option: HTMLElement) =>
      [...option.querySelectorAll('.menu-option > *')].map((part) => part.textContent?.trim());
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
    // Never played first, sorted here without asking the server again.
    expect(listed().map((piece) => piece.title)).toEqual(['Piece a', 'Piece b']);
    expect(api.pieceSummaries).toHaveBeenCalledTimes(1);
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
      'Not played yet',
      'Played 15 Oct 2026',
      'Played today',
      'No PDF yet',
    ]);
    await fixture.componentInstance.chooseSort('recent');
    await render();
    expect(listed().map((piece) => piece.note)).toEqual([
      'Played today',
      'Played 15 Oct 2026',
      'Not played yet',
      'No PDF yet',
    ]);
    fixture.destroy();
  });

  it('keeps Title order after a piece was just opened, with Learning & Playing on', async () => {
    const piece = (
      id: string,
      title: string,
      composer: string,
      lastPlayedAt: string | null,
      status: TestPiece['status'] = 'playing',
    ) => testPiece({ ...row(id, lastPlayedAt), title, composer, status });
    // Waltz sorts last by title and was opened just now. Sonata and Prelude
    // were played earlier, so a last-opened order would put Waltz first.
    const waltz = piece('waltz', 'Waltz in A-flat major', 'Frédéric Chopin', daysAgo(0));
    const { fixture, root, render, sortButton, listed, continued } = await setup(
      'title',
      [
        piece(
          'sonata',
          'Sonata Quasi Una Fantasia',
          'Ludwig van Beethoven',
          daysAgo(2),
          'learning',
        ),
        piece('allegro', 'Allegro from Six Light Keyboard Pieces', 'Johann Nepomuk Hummel', null),
        waltz,
        piece('prelude', 'Prelude', 'Frédéric Chopin', daysAgo(3)),
      ],
      waltz,
    );
    expect(sortButton().textContent).toContain('Sort: Title');
    expect(root.querySelector('.filter-menu .menu-button')?.textContent).toContain(
      'Learning & Playing',
    );
    expect(continued()).toBeNull();
    expect(listed().map((row) => row.title)).toEqual([
      'Allegro from Six Light Keyboard Pieces',
      'Prelude',
      'Sonata Quasi Una Fantasia',
      'Waltz in A-flat major',
    ]);

    await fixture.componentInstance.chooseSort('composer');
    await render();
    expect(continued()).toBeNull();
    expect(listed().map((row) => row.title)).toEqual([
      'Sonata Quasi Una Fantasia',
      'Prelude',
      'Waltz in A-flat major',
      'Allegro from Six Light Keyboard Pieces',
    ]);

    await fixture.componentInstance.chooseSort('fresh');
    await render();
    expect(continued()).toBeNull();
    expect(listed().map((row) => row.title)).toEqual([
      'Allegro from Six Light Keyboard Pieces',
      'Prelude',
      'Sonata Quasi Una Fantasia',
      'Waltz in A-flat major',
    ]);

    await fixture.componentInstance.chooseSort('recent');
    await render();
    expect(sortButton().textContent).toContain('Sort: Recently played');
    expect(continued()).toBe('Waltz in A-flat major');
    expect(listed().map((row) => row.title)).toEqual([
      'Sonata Quasi Una Fantasia',
      'Prelude',
      'Allegro from Six Light Keyboard Pieces',
    ]);
    fixture.destroy();
  });

  it('offers Continue with the usual row actions, and lists the piece only once', async () => {
    const b = testPiece({ ...row('b', daysAgo(1)), listeningUrl: 'https://example.test/b' });
    const rows = [row('a', daysAgo(3)), b, row('c', null)];
    const { fixture, api, root, render, listed, continued } = await setup('title', rows, b);
    // Title keeps the piece where it sorts. Continue belongs to Recently played.
    expect(continued()).toBeNull();
    expect(listed().map((piece) => piece.title)).toEqual(['Piece a', 'Piece b', 'Piece c']);
    await fixture.componentInstance.chooseSort('recent');
    await render();
    expect(continued()).toBe('Piece b');
    expect(root.querySelector('.continue-row .piece-note')?.textContent?.trim()).toBe(
      'Continue, played yesterday',
    );
    // Listen, status, favorite and edit, as on any row, and no extra button.
    const actions = [...root.querySelectorAll('.continue-row .row-actions > *')];
    expect(actions.map((action) => action.getAttribute('aria-label') ?? action.className)).toEqual([
      'Listen to Piece b in a new tab',
      'row-status',
      'Add to favorites',
      'Edit details',
    ]);
    expect(root.querySelector('.continue-row .btn-secondary')).toBeNull();
    // The list below leaves it out, so Recently played shows it once.
    expect(listed().map((piece) => piece.title)).toEqual(['Piece a', 'Piece c']);
    expect(root.querySelector('.results-count p')?.textContent).toContain('3 pieces');
    expect(
      root.querySelector('section[aria-label="Continue playing"] .continue-row'),
    ).not.toBeNull();

    // While searching there is no Continue, so the piece shows in the results.
    Reflect.get(fixture.componentInstance, 'query').set('piece');
    await render();
    expect(continued()).toBeNull();
    expect(listed().map((piece) => piece.title)).toEqual(['Piece b', 'Piece a', 'Piece c']);
    // Clearing the search brings Continue back without asking the server again.
    Reflect.get(fixture.componentInstance, 'query').set('');
    await render();
    expect(continued()).toBe('Piece b');
    expect(api.continuePiece).toHaveBeenCalledTimes(1);
    fixture.destroy();
  });

  it('continues a piece from outside the filter, and keeps it there when its status changes', async () => {
    // Learning & Playing lists only "a"; the shelved "s" was played yesterday.
    const shelved = testPiece({ ...row('s', daysAgo(1)), status: 'shelved' });
    const { fixture, api, root, render, sortButton, listed, continued } = await setup(
      'title',
      [row('a', daysAgo(3)), shelved],
      shelved,
    );
    // Title and Learning & Playing leave the shelved piece out of the list.
    expect(continued()).toBeNull();
    expect(listed().map((piece) => piece.title)).toEqual(['Piece a']);
    expect(root.querySelector('.results-count p')?.textContent).toContain('1 piece');
    await fixture.componentInstance.chooseSort('recent');
    await render();
    expect(sortButton().textContent).toContain('Sort: Recently played');
    expect(continued()).toBe('Piece s');
    expect(listed().map((piece) => piece.title)).toEqual(['Piece a']);

    const status = () =>
      root.querySelector('.continue-row .row-status select') as HTMLSelectElement;
    expect(status().value).toBe('shelved');
    status().value = 'learning';
    status().dispatchEvent(new Event('change'));
    await render();
    expect(api.updatePiece).toHaveBeenLastCalledWith('s', { status: 'learning' });
    expect(continued()).toBe('Piece s');
    expect(status().value).toBe('learning');

    // Back to Shelved: it no longer fits the filter, but Continue spans the library.
    status().value = 'shelved';
    status().dispatchEvent(new Event('change'));
    await render();
    expect(continued()).toBe('Piece s');
    expect(status().value).toBe('shelved');

    (root.querySelector('.continue-row [aria-label="Add to favorites"]') as HTMLElement).click();
    await render();
    expect(api.updatePiece).toHaveBeenLastCalledWith('s', { favorite: true });
    expect(root.querySelector('.continue-row .filled-heart')).not.toBeNull();
    fixture.destroy();
  });

  it('lists the library as usual when Continue is unavailable', async () => {
    const { fixture, api, listed, continued } = await setup('recent', [row('a', daysAgo(1))]);
    api.continuePiece.mockImplementation(() => throwError(() => new Error('offline')));
    await fixture.componentInstance.load();
    expect(continued()).toBeNull();
    expect(listed().map((piece) => piece.title)).toEqual(['Piece a']);
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
      pieceSummaries: vi.fn(() => of([row('a', null)])),
      continuePiece: vi.fn(() => of(null)),
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
    expect(Reflect.get(component, 'filter')()).toBe('shelved');
    expect(Reflect.get(component, 'sort')()).toBe('title');
    fixture.destroy();
  });

  it('still lists when the shown filter or sort is chosen early and the preferences fail', async () => {
    const remembered = new Subject<unknown>();
    const api = {
      session: vi.fn(() => of({ authenticated: true, authMode: 'development', development: true })),
      imports: vi.fn(() => of([])),
      preferences: vi.fn(() => remembered),
      savePreferences: vi.fn((preferences: unknown) => of(preferences)),
      pieceSummaries: vi.fn(() => of([row('a', null)])),
      continuePiece: vi.fn(() => of(null)),
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
    await component.chooseFilter('current');
    await component.chooseSort('title');
    // The library has loaded, but waits on the remembered filter and sort to list.
    expect(api.pieceSummaries).toHaveBeenCalledTimes(1);
    expect(Reflect.get(component, 'loading')()).toBe(true);
    remembered.error(new Error('offline'));
    await fixture.whenStable();
    expect(Reflect.get(component, 'loading')()).toBe(false);
    expect(Reflect.get(component, 'visible')().map((piece: PieceSummary) => piece.id)).toEqual([
      'a',
    ]);
    fixture.destroy();
  });

  it('applies the remembered sort when only the filter was chosen early', async () => {
    const remembered = new Subject<unknown>();
    const api = {
      session: vi.fn(() => of({ authenticated: true, authMode: 'development', development: true })),
      imports: vi.fn(() => of([])),
      preferences: vi.fn(() => remembered),
      savePreferences: vi.fn((preferences: unknown) => of(preferences)),
      pieceSummaries: vi.fn(() => of([row('a', null)])),
      continuePiece: vi.fn(() => of(null)),
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
    await component.chooseFilter('all');
    remembered.next({ libraryFilter: 'favorites', librarySort: 'composer' });
    remembered.complete();
    await fixture.whenStable();
    expect(Reflect.get(component, 'filter')()).toBe('all');
    expect(Reflect.get(component, 'sort')()).toBe('composer');
    expect(api.savePreferences.mock.calls).toEqual([[{ libraryFilter: 'all' }]]);
    fixture.destroy();
  });

  it('leaves Continue out when the server offers none', async () => {
    const { fixture, listed, continued } = await setup('recent', [row('a', daysAgo(15))]);
    expect(continued()).toBeNull();
    expect(listed().map((piece) => piece.title)).toEqual(['Piece a']);
    fixture.destroy();
  });
});

describe('LibraryComponent address and keys', () => {
  afterEach(() => {
    sessionStorage.clear();
    (document.activeElement as HTMLElement | null)?.blur();
    document.getSelection()?.removeAllRanges();
  });

  const pieces = [
    testPiece({
      id: 'humoresque',
      title: 'Humoresque',
      composer: 'Antonín Dvořák',
      pdf: { pageCount: 3, contentUrl: '/api/pieces/humoresque/pdf' } as Piece['pdf'],
    }),
    testPiece({ id: 'nocturne', title: 'Nocturne in C♯ minor', composer: 'Frédéric Chopin' }),
    testPiece({ id: 'prelude', title: 'Prelude Op. 28 No. 4', composer: 'Frédéric Chopin' }),
  ];

  async function setup(
    params: Record<string, string>,
    remembered: object,
    extras: { session?: Session; suggestions?: PieceSummary[] } = {},
  ) {
    const api = {
      session: vi.fn(() =>
        of(
          extras.session ?? {
            authenticated: true,
            authMode: 'development',
            development: true,
          },
        ),
      ),
      imports: vi.fn(() => of([])),
      preferences: vi.fn(() => of(remembered)),
      savePreferences: vi.fn((preferences: unknown) => of(preferences)),
      pieceSummaries: vi.fn(() => of(pieces)),
      continuePiece: vi.fn(() => of(null)),
      piece: vi.fn((id: string) => of(pieces.find((piece) => piece.id === id)!)),
      suggestPieces: vi.fn(() => of(extras.suggestions ?? [])),
      logout: vi.fn(() => of(undefined)),
    };
    await TestBed.configureTestingModule({
      imports: [LibraryComponent],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: convertToParamMap(params) } },
        },
        { provide: ApiService, useValue: api },
      ],
    }).compileComponents();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const fixture = TestBed.createComponent(LibraryComponent);
    const root = fixture.nativeElement as HTMLElement;
    for (const dialog of root.querySelectorAll('dialog')) {
      dialog.showModal = vi.fn();
      dialog.close = vi.fn();
    }
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const input = root.querySelector('.search input') as HTMLInputElement;
    const render = async () => {
      await fixture.whenStable();
      fixture.detectChanges();
    };
    const type = async (text: string) => {
      input.value = text;
      input.dispatchEvent(new Event('input'));
      await render();
    };
    const rows = () => [...root.querySelectorAll<HTMLElement>('.piece-row')];
    const titles = () => rows().map((row) => row.querySelector('h2')?.textContent);
    const press = async (target: Element, key: string) => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      await render();
      return event;
    };
    return { fixture, api, navigate, root, input, render, type, rows, titles, press };
  }

  /** The navigations that rewrote the library's own address. */
  const addressWrites = (navigate: { mock: { calls: unknown[][] } }) =>
    navigate.mock.calls.filter(([commands]) => (commands as unknown[]).length === 0);

  it('opens on the search, filter and sort in the address over the remembered ones', async () => {
    const { fixture, api, navigate, root, input, titles } = await setup(
      { q: 'chopin', show: 'all', sort: 'composer' },
      { libraryFilter: 'favorites', librarySort: 'recent' },
    );
    expect(input.value).toBe('chopin');
    expect(titles()).toEqual(['Nocturne in C♯ minor', 'Prelude Op. 28 No. 4']);
    expect(root.querySelector('.filter-menu .menu-button')?.textContent).toContain('All');
    expect(root.querySelector('.sort-menu .menu-button')?.textContent).toContain('Composer');
    // The address already says so, and nothing is remembered for the next visit.
    expect(addressWrites(navigate)).toEqual([]);
    expect(api.savePreferences).not.toHaveBeenCalled();
    fixture.destroy();
  });

  it('keeps a remembered filter and sort out of the address until this tab chooses them', async () => {
    const { fixture, api, navigate, type, titles } = await setup(
      { show: 'nonsense' },
      { libraryFilter: 'all', librarySort: 'composer' },
    );
    expect(titles()).toEqual(['Nocturne in C♯ minor', 'Prelude Op. 28 No. 4', 'Humoresque']);
    // The unknown show value is dropped, and the saved filter and sort are not written in its place.
    expect(navigate).toHaveBeenLastCalledWith([], { queryParams: {}, replaceUrl: true });

    await type('dvorak');
    expect(titles()).toEqual(['Humoresque']);
    expect(navigate).toHaveBeenLastCalledWith([], {
      queryParams: { q: 'dvorak' },
      replaceUrl: true,
    });
    // The reader returns to the search, and to a filter or sort only once this tab chose it.
    expect(JSON.parse(sessionStorage.getItem('noted.libraryQuery')!)).toEqual({ q: 'dvorak' });
    const writes = addressWrites(navigate).length;
    await type('dvorak');
    expect(addressWrites(navigate).length).toBe(writes);
    expect(api.savePreferences).not.toHaveBeenCalled();

    await fixture.componentInstance.chooseSort('recent');
    fixture.detectChanges();
    expect(navigate).toHaveBeenLastCalledWith([], {
      queryParams: { q: 'dvorak', sort: 'recent' },
      replaceUrl: true,
    });
    await fixture.componentInstance.chooseFilter('favorites');
    fixture.detectChanges();
    expect(navigate).toHaveBeenLastCalledWith([], {
      queryParams: { q: 'dvorak', show: 'favorites', sort: 'recent' },
      replaceUrl: true,
    });
    fixture.destroy();
  });

  it('keeps a chosen default filter in the address when saving it fails', async () => {
    const { fixture, api, navigate } = await setup(
      {},
      { libraryFilter: 'all', librarySort: 'title' },
    );
    api.savePreferences.mockReturnValueOnce(throwError(() => new Error('offline')));
    await fixture.componentInstance.chooseFilter('current');
    fixture.detectChanges();
    expect(api.savePreferences).toHaveBeenCalledWith({ libraryFilter: 'current' });
    expect(navigate).toHaveBeenLastCalledWith([], {
      queryParams: { show: 'current' },
      replaceUrl: true,
    });
    fixture.destroy();
  });

  it('leaves out a filter and sort that are both the defaults and the remembered ones', async () => {
    const { fixture, navigate, type } = await setup(
      {},
      { libraryFilter: 'current', librarySort: 'title' },
    );
    expect(addressWrites(navigate)).toEqual([]);
    await type('nocturne');
    expect(navigate).toHaveBeenLastCalledWith([], {
      queryParams: { q: 'nocturne' },
      replaceUrl: true,
    });
    await type('');
    expect(navigate).toHaveBeenLastCalledWith([], { queryParams: {}, replaceUrl: true });
    fixture.destroy();
  });

  it('remembers the filter shown from the address when it is chosen from the menu', async () => {
    const { fixture, api, navigate } = await setup(
      { show: 'current' },
      { libraryFilter: 'all', librarySort: 'title' },
    );
    // Without it the library would open on All.
    expect(addressWrites(navigate)).toEqual([]);
    await fixture.componentInstance.chooseFilter('current');
    expect(api.savePreferences).toHaveBeenCalledWith({ libraryFilter: 'current' });
    fixture.detectChanges();
    expect(navigate).toHaveBeenLastCalledWith([], { queryParams: {}, replaceUrl: true });
    fixture.destroy();
  });

  it('drops details=new from the address but keeps the search', async () => {
    const { fixture, navigate, root } = await setup(
      { details: 'new', q: 'bach' },
      { libraryFilter: 'current', librarySort: 'title' },
    );
    expect((root.querySelector('dialog.editor') as HTMLDialogElement).showModal).toHaveBeenCalled();
    expect(addressWrites(navigate)).toEqual([
      [[], { queryParams: { q: 'bach' }, replaceUrl: true }],
    ]);
    fixture.destroy();
  });

  it('marks what matches the search in the title and composer, as search folds it', async () => {
    const { fixture, root, type } = await setup({}, { libraryFilter: 'current' });
    const marks = () => [...root.querySelectorAll('.piece-row mark')].map((m) => m.textContent);
    expect(marks()).toEqual([]);
    await type('dvor');
    expect(marks()).toEqual(['Dvoř']);
    expect(root.querySelector('.piece-row p')?.textContent?.trim()).toBe('Antonín Dvořák');
    await type('c# noc');
    expect(marks()).toEqual(['Noc', 'C♯']);
    expect(root.querySelector('.piece-row h2')?.textContent).toBe('Nocturne in C♯ minor');
    fixture.destroy();
  });

  it('goes to the search with /, opens the first result with Enter, and clears with Escape', async () => {
    const { fixture, navigate, root, input, render, type, press } = await setup(
      {},
      { libraryFilter: 'current' },
    );
    const event = await press(document.body, '/');
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input);
    // A "/" typed into a field is just a slash.
    expect((await press(input, '/')).defaultPrevented).toBe(false);

    // Without a search, Enter opens nothing.
    await press(input, 'Enter');
    expect(navigate).not.toHaveBeenCalledWith(['/reader', 'humoresque']);
    await type('humor');
    await press(input, 'Enter');
    expect(navigate).toHaveBeenLastCalledWith(['/reader', 'humoresque']);

    // The field empties at once, before the view updates, so a letter typed next starts afresh.
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(input.value).toBe('');
    await render();
    expect(root.querySelectorAll('.piece-row').length).toBe(3);
    fixture.destroy();
  });

  it('moves between rows with the arrow keys, and back to the search', async () => {
    const { fixture, input, type, rows, press } = await setup({}, { libraryFilter: 'current' });
    input.focus();
    await press(input, 'ArrowDown');
    expect(document.activeElement).toBe(rows()[0]);
    await press(rows()[0], 'ArrowDown');
    expect(document.activeElement).toBe(rows()[1]);
    await press(rows()[1], 'ArrowDown');
    await press(rows()[2], 'ArrowDown');
    expect(document.activeElement).toBe(rows()[2]);
    await press(rows()[2], 'ArrowUp');
    expect(document.activeElement).toBe(rows()[1]);
    await press(rows()[1], 'ArrowUp');
    await press(rows()[0], 'ArrowUp');
    expect(document.activeElement).toBe(input);

    await type('chopin');
    await press(input, 'ArrowDown');
    await press(rows()[0], 'Escape');
    expect(input.value).toBe('');
    expect(document.activeElement).toBe(input);
    fixture.destroy();
  });

  it('opens the first similar match with Enter or Down when nothing matches exactly', async () => {
    const similar = testPiece({
      id: 'similar',
      title: 'Italian Concerto',
      composer: 'J. S. Bach',
      pdf: { pageCount: 8, contentUrl: '/api/pieces/similar/pdf' } as Piece['pdf'],
    });
    const { fixture, api, navigate, root, input, type, press } = await setup(
      {},
      { libraryFilter: 'current' },
      {
        session: {
          authenticated: true,
          authMode: 'development',
          development: true,
          user: { id: 'u1', email: 'daniel@example.test', displayName: 'Daniel' },
        },
        suggestions: [similar],
      },
    );
    await type('bachh');
    expect(root.querySelectorAll('.piece-row').length).toBe(0);
    await vi.waitFor(() => expect(root.querySelector('.suggestion')).not.toBeNull());
    expect(api.suggestPieces).toHaveBeenCalled();

    const suggestion = root.querySelector('.suggestion') as HTMLButtonElement;
    await press(input, 'ArrowDown');
    expect(document.activeElement).toBe(suggestion);
    input.focus();
    await press(input, 'Enter');
    expect(navigate).toHaveBeenLastCalledWith(['/reader', 'similar']);
    fixture.destroy();
  });

  it('forgets the library address when signing out', async () => {
    const { fixture, api } = await setup({ q: 'bach' }, { libraryFilter: 'current' });
    sessionStorage.setItem('noted.libraryQuery', JSON.stringify({ q: 'bach' }));
    const replace = vi.fn();
    const location = vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      replace,
    } as Location);
    await fixture.componentInstance.logout();
    expect(api.logout).toHaveBeenCalled();
    expect(sessionStorage.getItem('noted.libraryQuery')).toBeNull();
    expect(replace).toHaveBeenCalledWith('/');
    location.mockRestore();
    fixture.destroy();
  });
});

describe('playedText', () => {
  it('names the day the piece was last played', () => {
    const now = new Date(2026, 9, 3, 0, 30);
    expect(playedText(null, now)).toBe('Not played yet');
    expect(playedText(new Date(2026, 9, 3, 0, 5).toISOString(), now)).toBe('Played today');
    expect(playedText(new Date(2026, 9, 2, 23).toISOString(), now)).toBe('Played yesterday');
    expect(playedText(new Date(2026, 8, 28, 12).toISOString(), now)).toBe('Played 28 Sep 2026');
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
      pieceSummaries: vi.fn(() => of([])),
      continuePiece: vi.fn(() => of(null)),
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
