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
  });

  afterEach(() => {
    component.ngOnDestroy();
    vi.useRealTimers();
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
});
