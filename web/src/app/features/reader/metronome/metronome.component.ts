import {
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  OnInit,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { LucideMinus, LucidePause, LucidePlay, LucidePlus } from '@lucide/angular';
import { MetronomeEngine } from './metronome-engine';
import {
  addTap,
  clampBeatsPerBar,
  clampBpm,
  loadMetronomeSettings,
  maxBeatsPerBar,
  maxBpm,
  minBeatsPerBar,
  minBpm,
  saveMetronomeSettings,
  tapTempoBpm,
} from './metronome.utils';

/** Tempo controls for the reader. Ticks run on the Web Audio clock, never on UI timers. */
@Component({
  selector: 'app-metronome',
  imports: [LucideMinus, LucidePause, LucidePlay, LucidePlus],
  templateUrl: './metronome.component.html',
  styleUrl: './metronome.component.scss',
})
export class MetronomeComponent implements OnInit, OnDestroy {
  readonly pieceId = input.required<string>();
  /** Reports when ticking starts or stops so the reader can show it while the panel is closed. */
  readonly runningChange = output<boolean>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly engine = new MetronomeEngine();
  private taps: number[] = [];
  protected readonly minBpm = minBpm;
  protected readonly maxBpm = maxBpm;
  protected readonly minBeatsPerBar = minBeatsPerBar;
  protected readonly maxBeatsPerBar = maxBeatsPerBar;
  protected readonly bpm = signal(100);
  protected readonly beatsPerBar = signal(4);
  protected readonly running = signal(false);
  protected readonly activeBeat = signal(-1);
  protected readonly unavailable = signal(false);
  protected readonly beats = computed(() =>
    Array.from({ length: this.beatsPerBar() }, (_, index) => index),
  );

  ngOnInit(): void {
    const saved = loadMetronomeSettings(this.pieceId());
    this.bpm.set(saved.bpm);
    this.beatsPerBar.set(saved.beatsPerBar);
    this.engine.onBeat = (beat) => this.activeBeat.set(beat);
  }

  ngOnDestroy(): void {
    this.stopTicking();
  }

  /** Background tabs throttle timers, which would let the click queue run dry. */
  @HostListener('document:visibilitychange')
  onVisibilityChange(): void {
    if (document.visibilityState === 'hidden') this.stopTicking();
  }

  toggle(): void {
    if (this.running()) {
      this.stopTicking();
      return;
    }
    if (!this.engine.start(this.bpm(), this.beatsPerBar())) {
      this.unavailable.set(true);
      return;
    }
    this.unavailable.set(false);
    this.running.set(true);
    this.runningChange.emit(true);
  }

  adjustBpm(delta: number): void {
    this.setBpm(this.bpm() + delta);
  }

  changeBpm(event: Event): void {
    this.setBpm(Number((event.target as HTMLInputElement).value));
  }

  adjustBeats(delta: number): void {
    const beatsPerBar = clampBeatsPerBar(this.beatsPerBar() + delta);
    this.beatsPerBar.set(beatsPerBar);
    this.engine.setBeatsPerBar(beatsPerBar);
    this.remember();
  }

  tap(): void {
    this.taps = addTap(this.taps, performance.now());
    const bpm = tapTempoBpm(this.taps);
    if (bpm !== undefined) this.setBpm(bpm);
  }

  /**
   * Hands keyboard focus back to the page after a pointer press, so a Bluetooth page-turn pedal
   * (which sends Space, Enter or arrow keys) turns the page instead of re-pressing a button.
   */
  releaseFocus(): void {
    const active = document.activeElement;
    if (active instanceof HTMLElement && this.host.nativeElement.contains(active)) {
      setTimeout(() => active.blur());
    }
  }

  private setBpm(value: number): void {
    const bpm = clampBpm(value);
    this.bpm.set(bpm);
    this.engine.setTempo(bpm);
    this.remember();
  }

  private stopTicking(): void {
    this.engine.stop();
    this.activeBeat.set(-1);
    if (this.running()) {
      this.running.set(false);
      this.runningChange.emit(false);
    }
  }

  private remember(): void {
    saveMetronomeSettings(this.pieceId(), {
      bpm: this.bpm(),
      beatsPerBar: this.beatsPerBar(),
    });
  }
}
