import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { PracticeTimerService } from '../../core/practice-timer.service';
import { ScorePlayerComponent } from './score-player.component';

describe('ScorePlayerComponent controls', () => {
  let component: ScorePlayerComponent;
  let state: any;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.spyOn(ScorePlayerComponent.prototype, 'load').mockResolvedValue();
    await TestBed.configureTestingModule({
      imports: [ScorePlayerComponent],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: {
              paramMap: convertToParamMap({ assetId: 'asset-1' }),
              queryParamMap: convertToParamMap({ workId: 'work-1', measures: '8' }),
            },
          },
        },
        { provide: ApiService, useValue: { asset: () => of({}) } },
        {
          provide: PracticeTimerService,
          useValue: { initialize: vi.fn(), running: () => null, formatElapsed: () => '00:00:00' },
        },
      ],
    }).compileComponents();
    component = TestBed.createComponent(ScorePlayerComponent).componentInstance;
    state = component as any;
    state.shell = { nativeElement: document.createElement('section') };
    state.loading.set(false);
    state.scoreReady.set(true);
    state.playbackReady.set(true);
    state.error.set('');
  });

  afterEach(() => {
    component.ngOnDestroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reveals controls for pointer and keyboard activity, then hides after three seconds', () => {
    component.handlePointerActivity();
    expect(state.controlsVisible()).toBe(true);
    vi.advanceTimersByTime(2999);
    expect(state.controlsVisible()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(state.controlsVisible()).toBe(false);

    component.handleKeyboardActivity(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(state.controlsVisible()).toBe(true);
  });

  it('keeps controls visible while focused, editing a range, loading, or showing an error', () => {
    component.handleFocusIn();
    vi.advanceTimersByTime(5000);
    expect(state.controlsVisible()).toBe(true);

    state.controlsFocused = false;
    component.toggleRangeEditor();
    vi.advanceTimersByTime(5000);
    expect(state.controlsVisible()).toBe(true);
    component.closeRangeEditor();

    state.loading.set(true);
    component.handlePointerActivity();
    vi.advanceTimersByTime(5000);
    expect(state.controlsVisible()).toBe(true);
    state.loading.set(false);
    state.setPlayerError(new Error('broken score'));
    vi.advanceTimersByTime(5000);
    expect(state.controlsVisible()).toBe(true);
  });

  it('does not replace the applied range with an invalid draft', () => {
    state.measureCount = 8;
    state.rangeStart = 2;
    state.rangeEnd = 4;
    component.toggleRangeEditor();
    state.draftRangeStart = 3;
    state.draftRangeEnd = 9;
    component.applyRange();
    expect(state.rangeStart).toBe(2);
    expect(state.rangeEnd).toBe(4);
    expect(state.rangeOpen).toBe(true);
    expect(state.rangeError).toContain('at most 8');
  });

  it('renders the measure editor outside the scrolling toolbar with mobile numeric inputs', () => {
    const fixture = TestBed.createComponent(ScorePlayerComponent);
    const renderedComponent = fixture.componentInstance;
    const renderedState = renderedComponent as any;
    renderedState.loading.set(false);
    renderedState.scoreReady.set(true);
    renderedState.playbackReady.set(true);
    fixture.detectChanges();

    const rangeButton = fixture.nativeElement.querySelector('.range-control') as HTMLButtonElement;
    rangeButton.click();
    fixture.detectChanges();

    const editor = fixture.nativeElement.querySelector('#range-editor') as HTMLFormElement;
    expect(editor).toBeTruthy();
    expect(editor.getAttribute('role')).toBe('dialog');
    expect(editor.closest('.floating-player')).toBeNull();
    expect(editor.querySelectorAll('input[inputmode="numeric"]')).toHaveLength(2);
    expect(rangeButton.getAttribute('aria-expanded')).toBe('true');
    fixture.destroy();
  });

  it('labels and styles loop on and off as distinct pressed states', () => {
    const fixture = TestBed.createComponent(ScorePlayerComponent);
    const renderedState = fixture.componentInstance as any;
    renderedState.loading.set(false);
    renderedState.scoreReady.set(true);
    renderedState.playbackReady.set(true);
    fixture.detectChanges();

    const loopButton = fixture.nativeElement.querySelector('.loop-control') as HTMLButtonElement;
    expect(loopButton.textContent).toContain('Loop On');
    expect(loopButton.getAttribute('aria-pressed')).toBe('true');
    expect(loopButton.getAttribute('aria-label')).toBe('Loop on, turn off');
    expect(loopButton.classList.contains('active')).toBe(true);

    loopButton.click();
    fixture.detectChanges();
    expect(loopButton.textContent).toContain('Loop Off');
    expect(loopButton.getAttribute('aria-pressed')).toBe('false');
    expect(loopButton.getAttribute('aria-label')).toBe('Loop off, turn on');
    expect(loopButton.classList.contains('active')).toBe(false);
    fixture.destroy();
  });

  it('turns a silent playback initialization into a recoverable error after 15 seconds', () => {
    state.playbackReady.set(false);
    state.error.set('');
    state.startPlaybackReadinessWatchdog();
    vi.advanceTimersByTime(14_999);
    expect(state.error()).toBe('');
    vi.advanceTimersByTime(1);
    expect(state.error()).toContain('did not become ready');
    state.markPlaybackReady();
    expect(state.error()).toBe('');
    expect(state.playbackReady()).toBe(true);
  });

  it('does not clear a newer error when playback becomes ready after the timeout', () => {
    state.playbackReady.set(false);
    state.error.set('');
    state.startPlaybackReadinessWatchdog();
    vi.advanceTimersByTime(15_000);
    state.error.set('Practice could not start');

    state.markPlaybackReady();

    expect(state.error()).toBe('Practice could not start');
    expect(state.playbackReady()).toBe(true);
  });
});

describe('ScorePlayerComponent readiness lifecycle', () => {
  const readyAsset = {
    id: 'asset-1',
    editionId: 'edition-1',
    assetType: 'musicxml',
    originalFilename: 'exercise.musicxml',
    displayName: 'Exercise',
    mediaType: 'application/vnd.recordare.musicxml+xml',
    byteSize: 100,
    sha256: 'a'.repeat(64),
    rightsNote: 'CC0',
    playbackCapable: true,
    verificationState: 'verified',
    createdAt: '2026-07-18T00:00:00Z',
    contentUrl: '/api/assets/asset-1/content',
    downloadUrl: '/api/assets/asset-1/download',
    playbackValidation: { status: 'ready', issues: [] },
  } as const;

  async function createReadyPlayer() {
    await TestBed.configureTestingModule({
      imports: [ScorePlayerComponent],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: {
              paramMap: convertToParamMap({ assetId: 'asset-1' }),
              queryParamMap: convertToParamMap({ workId: 'work-1' }),
            },
          },
        },
        { provide: ApiService, useValue: { asset: () => of(readyAsset) } },
        {
          provide: PracticeTimerService,
          useValue: { initialize: vi.fn(), running: () => null, formatElapsed: () => '00:00:00' },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(ScorePlayerComponent);
    const component = fixture.componentInstance;
    const state = component as any;
    state.shell = { nativeElement: document.createElement('section') };
    state.notation = { nativeElement: document.createElement('section') };
    state.viewport = { nativeElement: document.createElement('section') };
    return { component, fixture, state };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('times score loading and playback readiness as separate phases', async () => {
    vi.useFakeTimers();
    const { component, fixture, state } = await createReadyPlayer();
    let callbacks: any;
    state.adapter.load = vi.fn(
      (_url, _notation, _viewport, nextCallbacks) =>
        new Promise<void>((resolve) => {
          callbacks = nextCallbacks;
          setTimeout(() => {
            callbacks.onScoreLoaded(8, 96);
            resolve();
          }, 20_000);
        }),
    );

    const loading = component.load();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(state.error()).toBe('');
    await vi.advanceTimersByTimeAsync(5_000);
    await loading;
    expect(state.scoreReady()).toBe(true);
    expect(state.error()).toBe('');

    await vi.advanceTimersByTimeAsync(15_000);
    expect(state.error()).toContain('did not become ready');
    callbacks.onPlaybackReady();
    expect(state.error()).toBe('');
    expect(state.playbackReady()).toBe(true);
    fixture.destroy();
  });

  it('reports a score-load timeout when alphaTab never emits scoreLoaded', async () => {
    vi.useFakeTimers();
    const { component, fixture, state } = await createReadyPlayer();
    state.adapter.load = vi.fn().mockResolvedValue(undefined);

    await component.load();
    expect(state.error()).toBe('');
    expect(state.scoreReady()).toBe(false);
    expect(state.playbackReadinessTimer).toBeDefined();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(state.error()).toBe('');
    await vi.advanceTimersByTimeAsync(1);
    expect(state.error()).toContain('did not finish loading');
    expect(state.scoreReady()).toBe(false);
    fixture.destroy();
  });
});

describe('ScorePlayerComponent validation gate', () => {
  it('attempts playback for well-formed MusicXML with OCR quality warnings', async () => {
    const reviewAsset = {
      id: 'asset-1',
      editionId: 'edition-1',
      assetType: 'musicxml',
      originalFilename: 'recognized.mxl',
      displayName: 'Moonlight conversion',
      mediaType: 'application/vnd.recordare.musicxml',
      byteSize: 100,
      sha256: 'a'.repeat(64),
      rightsNote: 'Generated by Audiveris',
      playbackCapable: true,
      verificationState: 'unverified_ocr',
      createdAt: '2026-07-18T00:00:00Z',
      contentUrl: '/api/assets/asset-1/content',
      downloadUrl: '/api/assets/asset-1/download',
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
    } as const;
    await TestBed.configureTestingModule({
      imports: [ScorePlayerComponent],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: {
              paramMap: convertToParamMap({ assetId: 'asset-1' }),
              queryParamMap: convertToParamMap({ workId: 'work-1' }),
            },
          },
        },
        { provide: ApiService, useValue: { asset: () => of(reviewAsset) } },
        {
          provide: PracticeTimerService,
          useValue: { initialize: vi.fn(), running: () => null, formatElapsed: () => '00:00:00' },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(ScorePlayerComponent);
    const state = fixture.componentInstance as any;
    state.adapter.load = vi.fn().mockResolvedValue(undefined);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(state.adapter.load).toHaveBeenCalledWith(
      reviewAsset.contentUrl,
      expect.any(HTMLElement),
      expect.any(HTMLElement),
      expect.any(Object),
      false,
    );
    expect(fixture.nativeElement.querySelector('.player-validation.blocked')).toBeNull();
    expect(fixture.nativeElement.querySelector('.floating-player')).toBeTruthy();
    expect(fixture.nativeElement.textContent).toContain('Review recommended');
    expect(fixture.nativeElement.textContent).toContain(
      'Unverified OCR — quality report unavailable; compare against the PDF.',
    );
    const dismiss = fixture.nativeElement.querySelector(
      'button[aria-label="Dismiss review warning"]',
    ) as HTMLButtonElement;
    expect(dismiss).toBeTruthy();
    dismiss.click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.player-validation')).toBeNull();
    expect(fixture.nativeElement.querySelector('.floating-player')).toBeTruthy();
    expect(state.adapter.load).toHaveBeenCalledTimes(1);
    fixture.destroy();
  });

  it('shows the matching output report and marks the worst confidence for each final measure', async () => {
    const reviewAsset = {
      id: 'asset-1',
      editionId: 'edition-1',
      assetType: 'musicxml',
      originalFilename: 'recognized.musicxml',
      mediaType: 'application/vnd.recordare.musicxml+xml',
      byteSize: 100,
      sha256: 'a'.repeat(64),
      rightsNote: 'Generated by the OMR pipeline',
      playbackCapable: true,
      verificationState: 'unverified_ocr',
      derivedFromAssetId: 'pdf-1',
      createdAt: '2026-07-18T00:00:00Z',
      contentUrl: '/api/assets/asset-1/content',
      downloadUrl: '/api/assets/asset-1/download',
      playbackValidation: { status: 'ready', issues: [] },
    } as const;
    const recognitionJobs = vi.fn(() =>
      of({
        items: [
          {
            id: 'newer-job-for-another-output',
            sourceAssetId: 'pdf-1',
            outputAssetId: 'asset-2',
            status: 'succeeded' as const,
            engine: 'noted-omr',
            engineVersion: '1',
            createdAt: '2026-07-18T00:02:00Z',
            updatedAt: '2026-07-18T00:03:00Z',
          },
          {
            id: 'matching-job',
            sourceAssetId: 'pdf-1',
            outputAssetId: 'asset-1',
            status: 'succeeded' as const,
            engine: 'noted-omr',
            engineVersion: '1',
            report: {
              schemaVersion: 1 as const,
              totalMeasures: 3,
              flaggedMeasures: 2,
              correctedMeasures: 1,
              suspectMeasures: 2,
              selectedEngine: 'fusion',
              engines: {
                audiveris: { status: 'succeeded' },
                homr: { status: 'succeeded' },
              },
              measures: [
                {
                  partId: 'P1',
                  number: '2',
                  measureIndex: 2,
                  sourceEngine: 'audiveris',
                  agreement: true,
                  confidence: 'high' as const,
                  corrected: false,
                  issues: [],
                },
                {
                  partId: 'P2',
                  number: '2',
                  measureIndex: 2,
                  sourceEngine: 'homr',
                  agreement: false,
                  confidence: 'medium' as const,
                  corrected: true,
                  issues: ['engine disagreement'],
                },
                {
                  partId: 'P1',
                  number: '3',
                  measureIndex: 3,
                  sourceEngine: 'audiveris',
                  agreement: false,
                  confidence: 'low' as const,
                  corrected: false,
                  issues: ['duration mismatch'],
                },
              ],
              playability: { status: 'passed', measureCount: 3, totalTicks: 5760 },
            },
            createdAt: '2026-07-18T00:00:00Z',
            updatedAt: '2026-07-18T00:01:00Z',
          },
        ],
      }),
    );
    await TestBed.configureTestingModule({
      imports: [ScorePlayerComponent],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: {
              paramMap: convertToParamMap({ assetId: 'asset-1' }),
              queryParamMap: convertToParamMap({ workId: 'work-1', measures: '3' }),
            },
          },
        },
        { provide: ApiService, useValue: { asset: () => of(reviewAsset), recognitionJobs } },
        {
          provide: PracticeTimerService,
          useValue: { initialize: vi.fn(), running: () => null, formatElapsed: () => '00:00:00' },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(ScorePlayerComponent);
    const state = fixture.componentInstance as any;
    state.adapter.load = vi.fn().mockResolvedValue(undefined);
    fixture.detectChanges();

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.nativeElement.textContent).toContain(
        'Unverified OCR — 1 of 3 measures auto-corrected, 2 still suspect.',
      );
    });

    expect(recognitionJobs).toHaveBeenCalledWith('pdf-1');
    const measures = fixture.nativeElement.querySelectorAll(
      '.measure-legend button',
    ) as NodeListOf<HTMLButtonElement>;
    expect(measures.length).toBe(3);
    expect(measures[0].classList.contains('confidence-medium')).toBe(false);
    expect(measures[0].classList.contains('confidence-low')).toBe(false);
    expect(measures[0].getAttribute('aria-label')).toBe('Measure 1');
    expect(measures[1].classList.contains('confidence-medium')).toBe(true);
    expect(measures[1].title).toContain('Medium confidence OCR in measure 2');
    expect(measures[1].getAttribute('aria-label')).toContain('medium confidence OCR');
    expect(measures[2].classList.contains('confidence-low')).toBe(true);
    expect(measures[2].title).toContain('Low confidence OCR in measure 3');
    expect(measures[2].getAttribute('aria-label')).toContain('low confidence OCR');
    fixture.destroy();
  });

  it('does not inherit an OCR report for a corrected replacement asset', async () => {
    const correctedAsset = {
      id: 'corrected-asset',
      editionId: 'edition-1',
      assetType: 'musicxml',
      originalFilename: 'corrected.musicxml',
      mediaType: 'application/vnd.recordare.musicxml+xml',
      byteSize: 100,
      sha256: 'a'.repeat(64),
      rightsNote: 'Learner-corrected score',
      playbackCapable: true,
      verificationState: 'corrected',
      derivedFromAssetId: 'pdf-1',
      replacesAssetId: 'recognized-asset',
      createdAt: '2026-07-18T00:00:00Z',
      contentUrl: '/api/assets/corrected-asset/content',
      downloadUrl: '/api/assets/corrected-asset/download',
      playbackValidation: { status: 'ready', issues: [] },
    } as const;
    const recognitionJobs = vi.fn(() => of({ items: [] }));
    await TestBed.configureTestingModule({
      imports: [ScorePlayerComponent],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: {
              paramMap: convertToParamMap({ assetId: 'corrected-asset' }),
              queryParamMap: convertToParamMap({ workId: 'work-1', measures: '1' }),
            },
          },
        },
        { provide: ApiService, useValue: { asset: () => of(correctedAsset), recognitionJobs } },
        {
          provide: PracticeTimerService,
          useValue: { initialize: vi.fn(), running: () => null, formatElapsed: () => '00:00:00' },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(ScorePlayerComponent);
    const state = fixture.componentInstance as any;
    state.adapter.load = vi.fn().mockResolvedValue(undefined);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(recognitionJobs).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('.player-validation')).toBeNull();
    expect(fixture.nativeElement.querySelector('.confidence-medium')).toBeNull();
    expect(fixture.nativeElement.querySelector('.confidence-low')).toBeNull();
    fixture.destroy();
  });

  it('keeps malformed MusicXML downloadable without initializing playback', async () => {
    const blockedAsset = {
      id: 'asset-1',
      editionId: 'edition-1',
      assetType: 'musicxml',
      originalFilename: 'recognized.mxl',
      displayName: 'Moonlight conversion',
      mediaType: 'application/vnd.recordare.musicxml',
      byteSize: 100,
      sha256: 'a'.repeat(64),
      rightsNote: 'Generated by Audiveris',
      playbackCapable: false,
      verificationState: 'unverified_ocr',
      createdAt: '2026-07-18T00:00:00Z',
      contentUrl: '/api/assets/asset-1/content',
      downloadUrl: '/api/assets/asset-1/download',
      playbackValidation: {
        status: 'blocked',
        issues: [
          {
            code: 'invalid_musicxml',
            message: 'The score is not well-formed MusicXML.',
            count: 1,
          },
        ],
      },
    } as const;
    await TestBed.configureTestingModule({
      imports: [ScorePlayerComponent],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: {
              paramMap: convertToParamMap({ assetId: 'asset-1' }),
              queryParamMap: convertToParamMap({ workId: 'work-1' }),
            },
          },
        },
        { provide: ApiService, useValue: { asset: () => of(blockedAsset) } },
        {
          provide: PracticeTimerService,
          useValue: { initialize: vi.fn(), running: () => null, formatElapsed: () => '00:00:00' },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(ScorePlayerComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.player-validation.blocked')).toBeTruthy();
    expect(fixture.nativeElement.textContent).toContain('not well-formed MusicXML');
    expect(fixture.nativeElement.querySelector('.player-validation a').getAttribute('href')).toBe(
      blockedAsset.downloadUrl,
    );
    expect(fixture.nativeElement.querySelector('.floating-player')).toBeNull();
    const dismiss = fixture.nativeElement.querySelector(
      'button[aria-label="Dismiss correction notice"]',
    ) as HTMLButtonElement;
    expect(dismiss).toBeTruthy();
    dismiss.click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.player-validation')).toBeNull();
    expect(fixture.nativeElement.querySelector('.floating-player')).toBeNull();
    fixture.destroy();
  });
});
