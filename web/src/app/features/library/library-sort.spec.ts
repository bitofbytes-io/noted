import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { Subject, of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiService } from '../../core/api.service';
import { Piece, PieceSummary } from '../../core/models';
import { LibraryComponent } from './library.component';
import { TestPiece, testPiece } from './library-testing';

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
