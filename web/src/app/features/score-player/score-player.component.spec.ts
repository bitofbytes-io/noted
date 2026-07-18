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
});

describe('ScorePlayerComponent readiness lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts the playback watchdog after score loading rather than before it', async () => {
    vi.useFakeTimers();
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
});

describe('ScorePlayerComponent validation gate', () => {
  it('keeps a blocked conversion downloadable without initializing playback', async () => {
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
            code: 'measure_duration_overflow',
            message: 'Rhythmic content extends beyond the expected measure duration.',
            count: 2,
            measures: ['1', '2'],
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
    expect(fixture.nativeElement.textContent).toContain('Measures 1, 2');
    expect(fixture.nativeElement.querySelector('.player-validation a').getAttribute('href')).toBe(
      blockedAsset.downloadUrl,
    );
    expect(fixture.nativeElement.querySelector('.floating-player')).toBeNull();
    fixture.destroy();
  });
});
