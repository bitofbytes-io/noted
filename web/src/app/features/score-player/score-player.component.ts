import {
  AfterViewInit,
  Component,
  ElementRef,
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

@Component({
  selector: 'app-score-player',
  imports: [FormsModule, RouterLink],
  templateUrl: './score-player.component.html',
  styleUrl: './score-player.component.scss',
})
export class ScorePlayerComponent implements AfterViewInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  @ViewChild('notation', { static: true }) private notation!: ElementRef<HTMLElement>;
  @ViewChild('viewport', { static: true }) private viewport!: ElementRef<HTMLElement>;
  protected readonly asset = signal<Asset | null>(null);
  protected readonly loading = signal(true);
  protected readonly scoreReady = signal(false);
  protected readonly playbackReady = signal(false);
  protected readonly playing = signal(false);
  protected readonly error = signal('');
  protected readonly workId = this.route.snapshot.queryParamMap.get('workId') ?? '';
  protected measureCount = Number(this.route.snapshot.queryParamMap.get('measures')) || 1;
  protected bpm = 96;
  protected rangeStart = 1;
  protected rangeEnd = this.measureCount;
  protected rangeOpen = false;
  protected rangeError = '';
  protected looping = true;
  protected controlsHidden = false;
  private readonly adapter = new NotationPlaybackAdapter();

  constructor(
    private readonly api: ApiService,
    protected readonly timer: PracticeTimerService,
  ) {}

  ngAfterViewInit(): void {
    void this.load();
    void this.timer.initialize();
  }

  ngOnDestroy(): void {
    this.adapter.dispose();
  }

  async load(): Promise<void> {
    const assetId = this.route.snapshot.paramMap.get('assetId') ?? '';
    try {
      const asset = await firstValueFrom(this.api.asset(assetId));
      if (!asset.playbackCapable || asset.assetType !== 'musicxml') {
        throw new Error(
          'This score has no structured playback representation. Open its PDF instead.',
        );
      }
      this.asset.set(asset);
      await this.adapter.load(
        asset.contentUrl,
        this.notation.nativeElement,
        this.viewport.nativeElement,
        {
          onScoreLoaded: (measureCount, originalBpm) => {
            this.measureCount = measureCount;
            this.rangeEnd = measureCount;
            this.bpm = Math.round(originalBpm);
            this.adapter.setRange(1, measureCount);
            this.adapter.setLooping(this.looping);
            this.scoreReady.set(true);
          },
          onPlaybackReady: () => this.playbackReady.set(true),
          onPlayingChanged: (playing) => this.playing.set(playing),
          onError: (error) => this.error.set(errorMessage(error)),
        },
      );
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.loading.set(false);
    }
  }

  updateBpm(): void {
    this.bpm = Math.min(240, Math.max(30, Math.round(this.bpm || 96)));
    this.adapter.setBpm(this.bpm);
  }

  applyRange(): void {
    this.rangeError = validateMeasureRange(this.rangeStart, this.rangeEnd, this.measureCount);
    if (this.rangeError) return;
    this.adapter.setRange(this.rangeStart, this.rangeEnd);
    this.rangeOpen = false;
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
}
