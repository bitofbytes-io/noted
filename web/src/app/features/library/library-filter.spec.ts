import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { Subject, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { ApiService } from '../../core/api.service';
import { Piece } from '../../core/models';
import { LibraryComponent } from './library.component';
import { TestPiece, testPiece } from './library-testing';

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
