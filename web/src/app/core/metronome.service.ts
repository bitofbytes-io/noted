import { Injectable, signal } from '@angular/core';

export type PendulumSide = 'center' | 'left' | 'right';

export interface MetronomeBeat {
  number: 1 | 2 | 3 | 4;
  audioTime: number;
  bpm: number;
  accented: boolean;
  side: Exclude<PendulumSide, 'center'>;
}

const LOOK_AHEAD_SECONDS = 0.1;
const SCHEDULER_INTERVAL_MS = 25;
const START_DELAY_SECONDS = 0.05;

@Injectable({ providedIn: 'root' })
export class MetronomeService {
  readonly running = signal(false);
  readonly bpm = signal(96);
  readonly accent = signal(true);
  readonly beat = signal(0);
  readonly side = signal<PendulumSide>('center');
  readonly lastBeat = signal<MetronomeBeat | null>(null);

  private context?: AudioContext;
  private scheduler?: ReturnType<typeof setInterval>;
  private nextBeatTime = 0;
  private nextBeatNumber: 1 | 2 | 3 | 4 = 1;
  private nextSide: Exclude<PendulumSide, 'center'> = 'left';
  private readonly visualTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly scheduledOscillators = new Set<OscillatorNode>();

  async start(): Promise<void> {
    if (this.running()) return;
    this.context = new AudioContext();
    await this.context.resume();
    this.nextBeatNumber = 1;
    this.nextSide = 'left';
    this.nextBeatTime = this.context.currentTime + START_DELAY_SECONDS;
    this.side.set('left');
    this.running.set(true);
    this.scheduleAhead();
    this.scheduler = setInterval(() => this.scheduleAhead(), SCHEDULER_INTERVAL_MS);
  }

  stop(): void {
    this.running.set(false);
    if (this.scheduler) clearInterval(this.scheduler);
    this.scheduler = undefined;
    for (const timer of this.visualTimers) clearTimeout(timer);
    this.visualTimers.clear();
    for (const oscillator of this.scheduledOscillators) {
      try {
        oscillator.stop();
      } catch {
        // An oscillator that has already ended cannot be stopped twice.
      }
    }
    this.scheduledOscillators.clear();
    this.beat.set(0);
    this.side.set('center');
    this.lastBeat.set(null);
    void this.context?.close();
    this.context = undefined;
  }

  setBpm(value: number): void {
    this.bpm.set(Math.min(240, Math.max(30, Math.round(value || 96))));
  }

  setAccent(value: boolean): void {
    this.accent.set(value);
  }

  private scheduleAhead(): void {
    const context = this.context;
    if (!context || !this.running()) return;

    const beatDuration = () => 60 / this.bpm();
    while (this.nextBeatTime < context.currentTime - beatDuration()) {
      this.advance(beatDuration());
    }
    while (this.nextBeatTime <= context.currentTime + LOOK_AHEAD_SECONDS) {
      this.scheduleClick(
        context,
        this.nextBeatTime,
        this.nextBeatNumber,
        this.nextSide,
        this.bpm(),
      );
      this.advance(beatDuration());
    }
  }

  private advance(duration: number): void {
    this.nextBeatTime += duration;
    this.nextBeatNumber = ((this.nextBeatNumber % 4) + 1) as 1 | 2 | 3 | 4;
    this.nextSide = this.nextSide === 'left' ? 'right' : 'left';
  }

  private scheduleClick(
    context: AudioContext,
    audioTime: number,
    number: 1 | 2 | 3 | 4,
    side: Exclude<PendulumSide, 'center'>,
    bpm: number,
  ): void {
    const accented = this.accent() && number === 1;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = accented ? 1320 : 880;
    gain.gain.setValueAtTime(accented ? 0.28 : 0.16, audioTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioTime + 0.045);
    oscillator.connect(gain).connect(context.destination);
    oscillator.onended = () => this.scheduledOscillators.delete(oscillator);
    this.scheduledOscillators.add(oscillator);
    oscillator.start(audioTime);
    oscillator.stop(audioTime + 0.05);

    const delay = Math.max(0, (audioTime - context.currentTime) * 1000);
    const timer = setTimeout(() => {
      this.visualTimers.delete(timer);
      if (!this.running() || this.context !== context) return;
      const event: MetronomeBeat = { number, audioTime, bpm, accented, side };
      this.beat.set(number);
      this.side.set(side);
      this.lastBeat.set(event);
    }, delay);
    this.visualTimers.add(timer);
  }
}
