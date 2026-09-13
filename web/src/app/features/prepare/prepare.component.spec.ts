import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { Observable, of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiService } from '../../core/api.service';
import { ImportDraft } from '../../core/models';
import { PrepareComponent } from './prepare.component';

describe('PrepareComponent', () => {
  const draft: ImportDraft = {
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
  let fixture: ComponentFixture<PrepareComponent>;
  let api: {
    importDraft: ReturnType<typeof vi.fn>;
    deleteImport: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    api = {
      importDraft: vi.fn(() => of(structuredClone(draft))),
      deleteImport: vi.fn((): Observable<void> => of(undefined)),
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
    fixture = TestBed.createComponent(PrepareComponent);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  it('discards a draft even when an in-flight autosave fails', async () => {
    const component = fixture.componentInstance;
    const router = TestBed.inject(Router);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.spyOn(router, 'navigate').mockResolvedValue(true);

    let rejectSave!: (reason: Error) => void;
    const pendingSave = new Promise<void>((_resolve, reject) => {
      rejectSave = reject;
    });
    Reflect.set(component, 'pendingSave', pendingSave);

    const discard = component.discard();
    rejectSave(new Error('autosave failed'));
    await discard;

    expect(api.deleteImport).toHaveBeenCalledWith(draft.id);
    expect(router.navigate).toHaveBeenCalledWith(['/']);
    expect(component.error()).toBe('');
    expect(component.busy()).toBe(false);
  });
});
