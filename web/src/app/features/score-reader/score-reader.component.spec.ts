import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { PracticeTimerService } from '../../core/practice-timer.service';
import { PdfScoreAdapter } from './pdf-score.adapter';
import { ScoreReaderComponent } from './score-reader.component';

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(),
}));

class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
}

describe('ScoreReaderComponent recovery', () => {
  it('offers retry and download when PDF rendering cannot start', async () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      value: FakeResizeObserver,
    });
    vi.spyOn(PdfScoreAdapter.prototype, 'load').mockRejectedValue(
      new Error('PDF worker could not start'),
    );
    const pdfAsset = {
      id: 'pdf-1',
      editionId: 'edition-1',
      assetType: 'pdf',
      originalFilename: 'moonlight.pdf',
      displayName: 'Moonlight score',
      mediaType: 'application/pdf',
      byteSize: 100,
      sha256: 'b'.repeat(64),
      rightsNote: 'Owned copy',
      playbackCapable: false,
      createdAt: '2026-07-18T00:00:00Z',
      contentUrl: '/api/assets/pdf-1/content',
      downloadUrl: '/api/assets/pdf-1/download',
      playbackValidation: { status: 'not_checked', issues: [] },
    } as const;
    await TestBed.configureTestingModule({
      imports: [ScoreReaderComponent],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: {
              paramMap: convertToParamMap({ assetId: 'pdf-1' }),
              queryParamMap: convertToParamMap({ workId: 'work-1' }),
            },
          },
        },
        { provide: ApiService, useValue: { asset: () => of(pdfAsset) } },
        {
          provide: PracticeTimerService,
          useValue: { initialize: vi.fn(), running: () => null, formatElapsed: () => '00:00:00' },
        },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(ScoreReaderComponent);
    fixture.detectChanges();
    await fixture.componentInstance.load();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.reader-error')).toBeTruthy();
    expect(fixture.nativeElement.textContent).toContain('PDF viewer unavailable');
    expect(fixture.nativeElement.querySelector('.reader-error a').getAttribute('href')).toBe(
      pdfAsset.downloadUrl,
    );
    fixture.destroy();
    vi.restoreAllMocks();
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      value: originalResizeObserver,
    });
  });
});
