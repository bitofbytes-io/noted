import { signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { PracticeTimerService } from '../../core/practice-timer.service';
import { hasApiErrorCode, WorkDetailsComponent } from './work-details.component';

describe('WorkDetailsComponent delete conflicts', () => {
  it('archives only for the matching in-use error', () => {
    const inUse = new HttpErrorResponse({
      status: 409,
      error: { error: { code: 'asset_in_use' } },
    });
    const serverFailure = new HttpErrorResponse({
      status: 500,
      error: { error: { code: 'internal_error' } },
    });

    expect(hasApiErrorCode(inUse, 'asset_in_use')).toBe(true);
    expect(hasApiErrorCode(inUse, 'edition_in_use')).toBe(false);
    expect(hasApiErrorCode(serverFailure, 'asset_in_use')).toBe(false);
  });
});

describe('WorkDetailsComponent capability states', () => {
  it('keeps PDF-only editions readable and shows provenance', async () => {
    const work = {
      id: 'work-1',
      title: 'Private Score',
      composer: 'Composer',
      learnerState: { status: 'Learning', isFavorite: false, tags: [] },
      movements: [{ id: 'movement-1', sequenceNumber: 1, title: 'Movement', measureCount: 8 }],
      editions: [
        {
          id: 'edition-1',
          name: 'Owned edition',
          rightsNote: 'Personal lawfully owned copy',
          assets: [
            {
              id: 'pdf-1',
              editionId: 'edition-1',
              assetType: 'pdf',
              originalFilename: 'score.pdf',
              mediaType: 'application/pdf',
              byteSize: 500,
              sha256: 'b'.repeat(64),
              rightsNote: 'Owned copy',
              playbackCapable: false,
              createdAt: '2026-07-13T00:00:00Z',
              contentUrl: '/api/assets/pdf-1/content',
              downloadUrl: '/api/assets/pdf-1/download',
              playbackValidation: { status: 'not_checked', issues: [] },
            },
          ],
        },
      ],
      practiceSummary: { totalSeconds: 0, sessionCount: 0 },
    };
    let timerStartInput: { workId?: string; movementId?: string | null } | undefined;
    const timer = {
      running: signal(null),
      busy: signal(false),
      initialize: async () => undefined,
      formatElapsed: () => '00:00:00',
      start: async (input: { workId?: string; movementId?: string | null }) => {
        timerStartInput = input;
        return undefined;
      },
      stop: async () => undefined,
    };
    await TestBed.configureTestingModule({
      imports: [WorkDetailsComponent],
      providers: [
        provideRouter([]),
        { provide: PracticeTimerService, useValue: timer },
        {
          provide: ApiService,
          useValue: { work: () => of(work), tags: () => of({ items: [] }) },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(WorkDetailsComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('Private Score');
    expect(text).toContain('Personal lawfully owned copy');
    expect(text).toContain('Read');
    const assetActions = Array.from(
      fixture.nativeElement.querySelectorAll('.asset-row a') as NodeListOf<Element>,
    ).map((node) => node.textContent?.trim());
    expect(assetActions).toEqual(['score.pdf', 'Read', 'Download']);
    const upload = fixture.nativeElement.querySelector('#upload-file') as HTMLInputElement;
    expect(upload.accept).toContain('.mxl');
    await fixture.componentInstance.startPractice();
    expect(Object.keys(timerStartInput ?? {})).toEqual(['workId']);
    expect(timerStartInput?.movementId).toBeUndefined();
  });
});
