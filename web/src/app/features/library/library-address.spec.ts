import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiService } from '../../core/api.service';
import { Piece, PieceSummary, Session } from '../../core/models';
import { LibraryComponent } from './library.component';
import { testPiece } from './library-testing';

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
