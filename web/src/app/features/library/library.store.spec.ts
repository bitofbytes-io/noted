import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { Observable, Subject, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiService } from '../../core/api.service';
import { testPiece } from './library-testing';
import { LibraryStore } from './library.store';

describe('LibraryStore', () => {
  afterEach(() => TestBed.resetTestingModule());

  function setup(
    preferences: Observable<unknown>,
    pieces = [
      testPiece({ id: 'humoresque', title: 'Humoresque', composer: 'Antonín Dvořák' }),
      testPiece({
        id: 'shelved',
        title: 'Gymnopédie No. 1',
        composer: 'Erik Satie',
        status: 'shelved',
      }),
    ],
  ) {
    const api = {
      preferences: vi.fn(() => preferences),
      savePreferences: vi.fn((value: unknown) => of(value)),
      pieceSummaries: vi.fn(() => of(pieces)),
      continuePiece: vi.fn(() => of(null)),
    };
    TestBed.configureTestingModule({
      providers: [
        LibraryStore,
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: convertToParamMap({}) } },
        },
        { provide: ApiService, useValue: api },
      ],
    });
    return { api, store: TestBed.inject(LibraryStore) };
  }

  it('filters the loaded library as the query changes, without asking the server again', async () => {
    const { api, store } = setup(of({ libraryFilter: 'current', librarySort: 'title' }));
    await vi.waitFor(() => expect(store.loading()).toBe(false));
    expect(store.visible().map((piece) => piece.id)).toEqual(['humoresque']);

    store.query.set('satie');
    expect(store.searching()).toBe(true);
    expect(store.visible().map((piece) => piece.id)).toEqual(['shelved']);
    // Punctuation alone is not a search, so the shelved piece leaves the default view.
    store.query.set(' % ');
    expect(store.searching()).toBe(false);
    expect(store.visible().map((piece) => piece.id)).toEqual(['humoresque']);
    expect(api.pieceSummaries).toHaveBeenCalledTimes(1);
  });

  it('keeps a filter or sort chosen before the remembered ones arrive', async () => {
    const remembered = new Subject<unknown>();
    const { api, store } = setup(remembered);
    await store.chooseSort('title');
    await store.chooseFilter('shelved');
    remembered.next({ libraryFilter: 'favorites', librarySort: 'composer' });
    remembered.complete();
    await vi.waitFor(() => expect(store.loading()).toBe(false));
    expect(store.filter()).toBe('shelved');
    expect(store.sort()).toBe('title');
    expect(api.savePreferences.mock.calls).toEqual([
      [{ librarySort: 'title' }],
      [{ libraryFilter: 'shelved' }],
    ]);
  });

  it('saves rapid filter choices one at a time, ending on the latest', async () => {
    const { api, store } = setup(of({ libraryFilter: 'current', librarySort: 'title' }));
    await vi.waitFor(() => expect(store.loading()).toBe(false));
    const inFlight = new Subject<unknown>();
    api.savePreferences.mockImplementationOnce(() => inFlight);

    const first = store.chooseFilter('shelved');
    await vi.waitFor(() => expect(api.savePreferences).toHaveBeenCalledTimes(1));
    const second = store.chooseFilter('all');
    const third = store.chooseFilter('favorites');
    await Promise.resolve();
    expect(api.savePreferences).toHaveBeenCalledTimes(1);

    inFlight.next({ libraryFilter: 'shelved' });
    inFlight.complete();
    await Promise.all([first, second, third]);
    expect(api.savePreferences.mock.calls).toEqual([
      [{ libraryFilter: 'shelved' }],
      [{ libraryFilter: 'favorites' }],
    ]);
    expect(store.filter()).toBe('favorites');
  });
});
