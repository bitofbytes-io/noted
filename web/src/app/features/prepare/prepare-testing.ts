// Shared TestBed setup for the Prepare specs. Not part of the application bundle.
import { Type } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { Observable, of } from 'rxjs';
import { vi } from 'vitest';
import { ApiService } from '../../core/api.service';
import { ImportAsset, ImportDraft, IMSLPSearch, Piece } from '../../core/models';
import { ImslpPanelHost } from './prepare-imslp';
import { PrepareComponent } from './prepare.component';
import { PrepareStore } from './prepare.store';

export const draft: ImportDraft = {
  id: '1b06330f-cee6-4cbd-a9e5-bcbad612a997',
  pieceId: null,
  revision: 1,
  metadata: {
    title: 'Draft score',
    composer: '',
    favorite: false,
    sourceUrl: '',
    listeningUrl: '',
    notes: '',
  },
  manifest: { version: 1, pages: [] },
  initialManifest: { version: 1, pages: [] },
  sources: [],
  finalized: false,
  updatedAt: '2026-09-13T20:00:00Z',
  maxFileBytes: 50 * 1024 * 1024,
};

export const photo: ImportAsset = {
  id: 'photo',
  filename: 'page.jpg',
  mime: 'image/jpeg',
  size: 100,
  checksum: 'photo-checksum',
  pageCount: 1,
  width: 1000,
  height: 1400,
};

export const pdfSource: ImportAsset = {
  id: 'pdf',
  filename: 'score.pdf',
  mime: 'application/pdf',
  size: 100,
  checksum: 'pdf-checksum',
  pageCount: 1,
  width: 612,
  height: 792,
};

export interface PrepareApiMock {
  importDraft: ReturnType<typeof vi.fn>;
  deleteImport: ReturnType<typeof vi.fn>;
  updateImport: ReturnType<typeof vi.fn>;
  finalizeImport: ReturnType<typeof vi.fn>;
  searchIMSLP: ReturnType<typeof vi.fn>;
}

function prepareApiMock(): PrepareApiMock {
  return {
    importDraft: vi.fn(() => of(structuredClone(draft))),
    deleteImport: vi.fn((): Observable<void> => of(undefined)),
    updateImport: vi.fn((value: ImportDraft) => of(value)),
    finalizeImport: vi.fn(() => of({ id: 'piece-one', pdf: {} } as unknown as Piece)),
    searchIMSLP: vi.fn((): Observable<IMSLPSearch> => of({ status: 'ready', results: [] })),
  };
}

function prepareProviders(api: PrepareApiMock) {
  return [
    provideRouter([]),
    {
      provide: ActivatedRoute,
      useValue: {
        snapshot: {
          paramMap: convertToParamMap({ draftId: draft.id }),
          queryParamMap: convertToParamMap({}),
        },
      },
    },
    { provide: ApiService, useValue: api },
  ];
}

/**
 * Renders one Prepare child component on its own, against a store holding `state`
 * on top of the blank `draft`. The page's file inputs are not rendered, so tests
 * that click a picker button replace `store.views.fileInputs` with a spy.
 */
export async function createPrepareChild<T>(
  type: Type<T>,
  state: (store: PrepareStore) => void = () => {},
): Promise<{ fixture: ComponentFixture<T>; store: PrepareStore; api: PrepareApiMock }> {
  const api = prepareApiMock();
  await TestBed.configureTestingModule({
    imports: [type],
    providers: [
      ...prepareProviders(api),
      PrepareStore,
      { provide: ImslpPanelHost, useExisting: PrepareStore },
    ],
  }).compileComponents();
  const store = TestBed.inject(PrepareStore);
  await store.ready;
  state(store);
  const fixture = TestBed.createComponent(type);
  fixture.detectChanges();
  return { fixture, store, api };
}

/** Renders Prepare for `draft` against a mocked API; window.open is stubbed. */
export async function createPrepareFixture(): Promise<{
  fixture: ComponentFixture<PrepareComponent>;
  store: PrepareStore;
  api: PrepareApiMock;
  openWindow: ReturnType<typeof vi.spyOn>;
}> {
  const openWindow = vi.spyOn(window, 'open').mockReturnValue(null);
  const api = prepareApiMock();
  await TestBed.configureTestingModule({
    imports: [PrepareComponent],
    providers: prepareProviders(api),
  }).compileComponents();
  const fixture = TestBed.createComponent(PrepareComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  const store = fixture.debugElement.injector.get(PrepareStore);
  return { fixture, store, api, openWindow };
}
