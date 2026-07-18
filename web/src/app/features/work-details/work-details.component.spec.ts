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

  it('keeps quality reports and project links attached to their exact derived outputs', async () => {
    const work = {
      id: 'work-1',
      title: 'Moonlight Sonata',
      composer: 'Beethoven',
      learnerState: { status: 'Learning', isFavorite: false, tags: [] },
      movements: [{ id: 'movement-1', sequenceNumber: 1, title: 'Adagio', measureCount: 65 }],
      editions: [
        {
          id: 'edition-1',
          name: 'Owned edition',
          rightsNote: 'Personal copy',
          assets: [
            {
              id: 'pdf-1',
              editionId: 'edition-1',
              assetType: 'pdf',
              originalFilename: 'moonlight.pdf',
              mediaType: 'application/pdf',
              byteSize: 500,
              sha256: 'b'.repeat(64),
              rightsNote: 'Owned copy',
              playbackCapable: false,
              createdAt: '2026-07-18T00:00:00Z',
              contentUrl: '/api/assets/pdf-1/content',
              downloadUrl: '/api/assets/pdf-1/download',
              playbackValidation: { status: 'not_checked', issues: [] },
            },
            {
              id: 'xml-old',
              editionId: 'edition-1',
              assetType: 'musicxml',
              originalFilename: 'recognized-old.mxl',
              mediaType: 'application/vnd.recordare.musicxml',
              byteSize: 15000,
              sha256: 'a'.repeat(64),
              rightsNote: 'Generated by the OMR pipeline',
              playbackCapable: true,
              verificationState: 'unverified_ocr',
              derivedFromAssetId: 'pdf-1',
              createdAt: '2026-07-18T00:01:00Z',
              contentUrl: '/api/assets/xml-old/content',
              downloadUrl: '/api/assets/xml-old/download',
              playbackValidation: {
                status: 'needs_review',
                issues: [
                  {
                    code: 'measure_duration_overflow',
                    message: 'Rhythmic content extends beyond the expected measure duration.',
                    count: 51,
                  },
                ],
              },
            },
            {
              id: 'xml-new',
              editionId: 'edition-1',
              assetType: 'musicxml',
              originalFilename: 'recognized-new.mxl',
              mediaType: 'application/vnd.recordare.musicxml',
              byteSize: 16000,
              sha256: 'c'.repeat(64),
              rightsNote: 'Generated by the OMR pipeline',
              playbackCapable: true,
              verificationState: 'unverified_ocr',
              derivedFromAssetId: 'pdf-1',
              createdAt: '2026-07-18T00:02:00Z',
              contentUrl: '/api/assets/xml-new/content',
              downloadUrl: '/api/assets/xml-new/download',
              playbackValidation: { status: 'ready', issues: [] },
            },
            {
              id: 'xml-corrected',
              editionId: 'edition-1',
              assetType: 'musicxml',
              originalFilename: 'corrected.musicxml',
              mediaType: 'application/vnd.recordare.musicxml+xml',
              byteSize: 17000,
              sha256: 'd'.repeat(64),
              rightsNote: 'Learner-corrected score',
              playbackCapable: true,
              verificationState: 'corrected',
              derivedFromAssetId: 'pdf-1',
              replacesAssetId: 'xml-new',
              createdAt: '2026-07-18T00:03:00Z',
              contentUrl: '/api/assets/xml-corrected/content',
              downloadUrl: '/api/assets/xml-corrected/download',
              playbackValidation: { status: 'ready', issues: [] },
            },
          ],
        },
      ],
      practiceSummary: { totalSeconds: 0, sessionCount: 0 },
    };
    const timer = {
      running: signal(null),
      busy: signal(false),
      initialize: async () => undefined,
      formatElapsed: () => '00:00:00',
      start: async () => undefined,
      stop: async () => undefined,
    };
    await TestBed.configureTestingModule({
      imports: [WorkDetailsComponent],
      providers: [
        provideRouter([]),
        { provide: PracticeTimerService, useValue: timer },
        {
          provide: ApiService,
          useValue: {
            work: () => of(work),
            tags: () => of({ items: [] }),
            recognitionJobs: () =>
              of({
                items: [
                  {
                    id: 'job-new',
                    sourceAssetId: 'pdf-1',
                    outputAssetId: 'xml-new',
                    status: 'succeeded',
                    engine: 'noted-omr',
                    engineVersion: '1',
                    projectDownloadUrl: '/api/recognition-jobs/job-new/project',
                    report: {
                      schemaVersion: 1,
                      totalMeasures: 65,
                      flaggedMeasures: 7,
                      correctedMeasures: 5,
                      suspectMeasures: 2,
                      selectedEngine: 'fusion',
                      engines: { audiveris: { status: 'succeeded' } },
                      measures: [
                        {
                          partId: 'P1',
                          number: '1',
                          measureIndex: 1,
                          sourceEngine: 'fusion',
                          agreement: true,
                          confidence: 'high',
                          corrected: false,
                          issues: [],
                        },
                      ],
                      playability: { status: 'passed', measureCount: 65 },
                    },
                    createdAt: '2026-07-18T00:00:00Z',
                    updatedAt: '2026-07-18T00:01:00Z',
                  },
                  {
                    id: 'job-old',
                    sourceAssetId: 'pdf-1',
                    outputAssetId: 'xml-old',
                    status: 'succeeded',
                    engine: 'noted-omr',
                    engineVersion: '1',
                    projectDownloadUrl: '/api/recognition-jobs/job-old/project',
                    report: {
                      schemaVersion: 1,
                      totalMeasures: 65,
                      flaggedMeasures: 14,
                      correctedMeasures: 8,
                      suspectMeasures: 6,
                      selectedEngine: 'audiveris',
                      engines: { audiveris: { status: 'succeeded' } },
                      measures: [
                        {
                          partId: 'P1',
                          number: '1',
                          measureIndex: 1,
                          sourceEngine: 'audiveris',
                          agreement: false,
                          confidence: 'medium',
                          corrected: false,
                          issues: ['engine disagreement'],
                        },
                      ],
                      playability: { status: 'passed', measureCount: 65 },
                    },
                    createdAt: '2026-07-17T00:00:00Z',
                    updatedAt: '2026-07-17T00:01:00Z',
                  },
                ],
              }),
          },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(WorkDetailsComponent);
    fixture.detectChanges();

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.nativeElement.textContent).toContain(
        'Unverified OCR — 5 of 65 measures auto-corrected, 2 still suspect',
      );
    });

    const rows = fixture.nativeElement.querySelectorAll('.asset-row') as NodeListOf<HTMLElement>;
    expect(rows.length).toBe(4);
    expect(rows[1].textContent).toContain('Play');
    expect(rows[1].textContent).toContain('Download OMR');
    expect(rows[1].textContent).toContain(
      'Unverified OCR — 8 of 65 measures auto-corrected, 6 still suspect',
    );
    expect(
      rows[1].querySelector('a[href="/api/recognition-jobs/job-old/project"]')?.textContent?.trim(),
    ).toBe('Download OMR');
    expect(rows[2].textContent).toContain(
      'Unverified OCR — 5 of 65 measures auto-corrected, 2 still suspect',
    );
    expect(
      rows[2].querySelector('a[href="/api/recognition-jobs/job-new/project"]')?.textContent?.trim(),
    ).toBe('Download OMR');
    expect(rows[3].textContent).toContain('Corrected score');
    expect(rows[3].textContent).not.toContain('Unverified OCR');
    expect(rows[3].textContent).not.toContain('Download OMR');

    const state = fixture.componentInstance as any;
    expect(state.recognitionJobs()['pdf-1'].id).toBe('job-new');
    expect(Object.keys(state.recognitionJobsByOutputAssetId()).sort()).toEqual([
      'xml-new',
      'xml-old',
    ]);
  });
});
