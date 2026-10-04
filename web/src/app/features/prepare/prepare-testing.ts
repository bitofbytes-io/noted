// Shared TestBed setup for the Prepare specs. Not part of the application bundle.
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { Observable, of } from 'rxjs';
import { vi } from 'vitest';
import { ApiService } from '../../core/api.service';
import { ImportDraft, IMSLPSearch, Piece } from '../../core/models';
import { PrepareComponent } from './prepare.component';

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

export interface PrepareApiMock {
  importDraft: ReturnType<typeof vi.fn>;
  deleteImport: ReturnType<typeof vi.fn>;
  updateImport: ReturnType<typeof vi.fn>;
  finalizeImport: ReturnType<typeof vi.fn>;
  searchIMSLP: ReturnType<typeof vi.fn>;
}

/** Renders Prepare for `draft` against a mocked API; window.open is stubbed. */
export async function createPrepareFixture(): Promise<{
  fixture: ComponentFixture<PrepareComponent>;
  api: PrepareApiMock;
  openWindow: ReturnType<typeof vi.spyOn>;
}> {
  const openWindow = vi.spyOn(window, 'open').mockReturnValue(null);
  const api: PrepareApiMock = {
    importDraft: vi.fn(() => of(structuredClone(draft))),
    deleteImport: vi.fn((): Observable<void> => of(undefined)),
    updateImport: vi.fn((value: ImportDraft) => of(value)),
    finalizeImport: vi.fn(() => of({ id: 'piece-one', pdf: {} } as unknown as Piece)),
    searchIMSLP: vi.fn((): Observable<IMSLPSearch> => of({ status: 'ready', results: [] })),
  };
  await TestBed.configureTestingModule({
    imports: [PrepareComponent],
    providers: [
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
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(PrepareComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  return { fixture, api, openWindow };
}
