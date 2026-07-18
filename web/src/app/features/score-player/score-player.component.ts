import {
  AfterViewInit,
  Component,
  ElementRef,
  HostListener,
  inject,
  OnDestroy,
  signal,
  ViewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService, errorMessage } from '../../core/api.service';
import { Asset } from '../../core/models';
import { PracticeTimerService } from '../../core/practice-timer.service';
import { NotationPlaybackAdapter, validateMeasureRange } from './notation-playback.adapter';

const playbackReadinessError =
  'The playback engine did not become ready. Retry the player or download the score.';

@Component({
  selector: 'app-score-player',
  imports: [FormsModule, RouterLink],
  templateUrl: './score-player.component.html',
  styleUrl: './score-player.component.scss',
})
export class ScorePlayerComponent implements AfterViewInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  @ViewChild('shell', { static: true }) private shell!: ElementRef<HTMLElement>;
  @ViewChild('notation', { static: true }) private notation!: ElementRef<HTMLElement>;
  @ViewChild('viewport', { static: true }) private viewport!: ElementRef<HTMLElement>;
  protected readonly asset = signal<Asset | null>(null);
  protected readonly loading = signal(true);
  protected readonly scoreReady = signal(false);
  protected readonly playbackReady = signal(false);
  protected readonly playing = signal(false);
  protected readonly error = signal('');
  protected readonly validationMessage = signal('');
  protected readonly validationBlocked = signal(false);
  protected readonly workId = this.route.snapshot.queryParamMap.get('workId') ?? '';
  protected measureCount = Number(this.route.snapshot.queryParamMap.get('measures')) || 1;
  protected bpm = 96;
  protected zoom = 100;
  protected rangeStart = 1;
  protected rangeEnd = this.measureCount;
  protected draftRangeStart = this.rangeStart;
  protected draftRangeEnd = this.rangeEnd;
  protected rangeOpen = false;
  protected rangeError = '';
  protected looping = true;
  protected readonly controlsVisible = signal(true);
  protected readonly reducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  private readonly adapter = new NotationPlaybackAdapter();
  private controlsFocused = false;
  private controlsTimer?: ReturnType<typeof setTimeout>;
  private playbackReadinessTimer?: ReturnType<typeof setTimeout>;
  private playbackReadinessTimedOut = false;

  constructor(
    private readonly api: ApiService,
    protected readonly timer: PracticeTimerService,
  ) {}

  ngAfterViewInit(): void {
    void this.load();
    void this.timer.initialize();
  }

  ngOnDestroy(): void {
    this.clearControlsTimer();
    this.clearPlaybackReadinessTimer();
    this.adapter.dispose();
  }

  @HostListener('window:keydown', ['$event'])
  handleKeyboardActivity(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.rangeOpen) this.closeRangeEditor();
    this.revealControls();
  }

  handlePointerActivity(): void {
    this.revealControls();
  }

  handleFocusIn(): void {
    this.controlsFocused = true;
    this.controlsVisible.set(true);
    this.clearControlsTimer();
  }

  handleFocusOut(event: FocusEvent): void {
    const next = event.relatedTarget;
    if (next instanceof Node && this.shell.nativeElement.contains(next)) return;
    this.controlsFocused = false;
    this.scheduleControlsHide();
  }

  revealControls(): void {
    this.controlsVisible.set(true);
    this.scheduleControlsHide();
  }

  async load(): Promise<void> {
    const assetId = this.route.snapshot.paramMap.get('assetId') ?? '';
    this.clearPlaybackReadinessTimer();
    this.adapter.dispose();
    this.loading.set(true);
    this.error.set('');
    this.validationMessage.set('');
    this.validationBlocked.set(false);
    this.scoreReady.set(false);
    this.playbackReady.set(false);
    this.playbackReadinessTimedOut = false;
    try {
      const asset = await firstValueFrom(this.api.asset(assetId));
      this.asset.set(asset);
      if (asset.assetType !== 'musicxml') {
        throw new Error(
          'This score has no structured playback representation. Open its PDF instead.',
        );
      }
      const validation = asset.playbackValidation;
      if (
        !validation ||
        validation.status === 'not_checked' ||
        validation.status === 'blocked' ||
        !asset.playbackCapable
      ) {
        this.validationBlocked.set(true);
        this.validationMessage.set(this.playbackValidationMessage(asset));
        return;
      }
      if (validation.status === 'needs_review') {
        this.validationMessage.set(this.playbackValidationMessage(asset));
      }
      await this.adapter.load(
        asset.contentUrl,
        this.notation.nativeElement,
        this.viewport.nativeElement,
        {
          onScoreLoaded: (measureCount, originalBpm) => {
            this.measureCount = measureCount;
            this.rangeEnd = measureCount;
            this.draftRangeStart = 1;
            this.draftRangeEnd = measureCount;
            this.bpm = Math.round(originalBpm);
            this.adapter.setRange(1, measureCount);
            this.adapter.setLooping(this.looping);
            this.scoreReady.set(true);
            if (!this.playbackReady()) this.startPlaybackReadinessWatchdog();
            this.scheduleControlsHide();
          },
          onPlaybackReady: () => {
            this.markPlaybackReady();
          },
          onPlayingChanged: (playing) => this.playing.set(playing),
          onError: (error) => this.setPlayerError(error),
        },
        this.reducedMotion,
      );
    } catch (error) {
      this.clearPlaybackReadinessTimer();
      this.setPlayerError(error);
    } finally {
      this.loading.set(false);
      this.scheduleControlsHide();
    }
  }

  retry(): void {
    void this.load();
  }

  updateBpm(): void {
    this.bpm = Math.min(240, Math.max(30, Math.round(this.bpm || 96)));
    this.adapter.setBpm(this.bpm);
  }

  changeZoom(delta: number): void {
    this.zoom = Math.min(200, Math.max(75, this.zoom + delta));
    this.adapter.setZoom(this.zoom);
  }

  applyRange(): void {
    this.rangeError = validateMeasureRange(
      this.draftRangeStart,
      this.draftRangeEnd,
      this.measureCount,
    );
    if (this.rangeError) return;
    this.rangeStart = this.draftRangeStart;
    this.rangeEnd = this.draftRangeEnd;
    this.adapter.setRange(this.rangeStart, this.rangeEnd);
    this.rangeOpen = false;
    this.scheduleControlsHide();
  }

  toggleRangeEditor(): void {
    if (this.rangeOpen) {
      this.closeRangeEditor();
      return;
    }
    this.draftRangeStart = this.rangeStart;
    this.draftRangeEnd = this.rangeEnd;
    this.rangeError = '';
    this.rangeOpen = true;
    this.controlsVisible.set(true);
    this.clearControlsTimer();
  }

  closeRangeEditor(): void {
    this.rangeOpen = false;
    this.rangeError = '';
    this.draftRangeStart = this.rangeStart;
    this.draftRangeEnd = this.rangeEnd;
    this.scheduleControlsHide();
  }

  selectMeasure(number: number): void {
    this.rangeStart = number;
    this.rangeEnd = number;
    this.draftRangeStart = number;
    this.draftRangeEnd = number;
    this.rangeError = '';
    this.adapter.setRange(number, number);
    this.scheduleControlsHide();
  }

  toggleLoop(): void {
    this.looping = !this.looping;
    this.adapter.setLooping(this.looping);
  }

  playPause(): void {
    this.adapter.playPause();
  }

  restart(): void {
    this.adapter.restart();
  }

  measureNumbers(): number[] {
    return Array.from({ length: this.measureCount }, (_, index) => index + 1);
  }

  async startPractice(): Promise<void> {
    if (!this.workId) return;
    try {
      await this.timer.start({
        workId: this.workId,
        scoreAssetId: this.asset()?.id,
        startMeasure: this.rangeStart,
        endMeasure: this.rangeEnd,
        startingBpm: this.bpm,
      });
    } catch (error) {
      this.error.set(errorMessage(error));
    }
  }

  private setPlayerError(error: unknown, readinessTimeout = false): void {
    this.clearPlaybackReadinessTimer();
    this.playbackReadinessTimedOut = readinessTimeout;
    this.error.set(errorMessage(error));
    this.controlsVisible.set(true);
    this.clearControlsTimer();
  }

  private playbackValidationMessage(asset: Asset): string {
    if (asset.playbackValidation?.status === 'not_checked') {
      return 'This score is waiting for playback validation. Download it now or try again after validation completes.';
    }
    const issues = asset.playbackValidation?.issues ?? [];
    if (!issues.length) return 'This score needs correction before playback.';
    return issues
      .map((issue) => {
        const measures = issue.measures?.length ? ` Measures ${issue.measures.join(', ')}.` : '';
        return `${issue.message}${measures}`;
      })
      .join(' ');
  }

  private scheduleControlsHide(): void {
    this.clearControlsTimer();
    if (this.controlsMustStayVisible()) {
      this.controlsVisible.set(true);
      return;
    }
    this.controlsTimer = setTimeout(() => {
      if (!this.controlsMustStayVisible()) this.controlsVisible.set(false);
    }, 3000);
  }

  private controlsMustStayVisible(): boolean {
    return (
      this.loading() ||
      !this.scoreReady() ||
      !this.playbackReady() ||
      Boolean(this.error()) ||
      this.controlsFocused ||
      this.rangeOpen
    );
  }

  private clearControlsTimer(): void {
    if (this.controlsTimer) clearTimeout(this.controlsTimer);
    this.controlsTimer = undefined;
  }

  private clearPlaybackReadinessTimer(): void {
    if (this.playbackReadinessTimer) clearTimeout(this.playbackReadinessTimer);
    this.playbackReadinessTimer = undefined;
  }

  private markPlaybackReady(): void {
    this.clearPlaybackReadinessTimer();
    if (this.playbackReadinessTimedOut && this.error() === playbackReadinessError) {
      this.error.set('');
    }
    this.playbackReadinessTimedOut = false;
    this.playbackReady.set(true);
    this.scheduleControlsHide();
  }

  private startPlaybackReadinessWatchdog(): void {
    this.clearPlaybackReadinessTimer();
    this.playbackReadinessTimer = setTimeout(() => {
      if (!this.playbackReady() && !this.error()) {
        this.setPlayerError(new Error(playbackReadinessError), true);
      }
    }, 15_000);
  }
}
