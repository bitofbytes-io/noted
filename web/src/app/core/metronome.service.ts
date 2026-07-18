import { Injectable, signal } from '@angular/core';
import { MetronomeSound } from './models';

export type PendulumSide = 'center' | 'left' | 'right';

export interface MetronomeBeat {
  number: 1 | 2 | 3 | 4;
  audioTime: number;
  bpm: number;
  accented: boolean;
  side: Exclude<PendulumSide, 'center'>;
}

interface SoundProfile {
  wave: OscillatorType;
  regularFrequency: number;
  accentFrequency: number;
  regularGain: number;
  accentGain: number;
  duration: number;
}

const SOUND_PROFILES: Record<MetronomeSound, SoundProfile> = {
  classic: {
    wave: 'square',
    regularFrequency: 880,
    accentFrequency: 1320,
    regularGain: 0.13,
    accentGain: 0.22,
    duration: 0.045,
  },
  woodblock: {
    wave: 'triangle',
    regularFrequency: 620,
    accentFrequency: 920,
    regularGain: 0.2,
    accentGain: 0.3,
    duration: 0.07,
  },
  soft_tick: {
    wave: 'sine',
    regularFrequency: 520,
    accentFrequency: 720,
    regularGain: 0.08,
    accentGain: 0.12,
    duration: 0.035,
  },
};

const LOOK_AHEAD_SECONDS = 0.1;
const SCHEDULER_INTERVAL_MS = 25;
const START_DELAY_SECONDS = 0.05;

@Injectable({ providedIn: 'root' })
export class MetronomeService {
  readonly running = signal(false);
  readonly bpm = signal(96);
  readonly accent = signal(true);
  readonly beatsPerBar = signal<1 | 2 | 3 | 4>(4);
  readonly sound = signal<MetronomeSound>('classic');
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
    this.cancelScheduledBeats();
    this.beat.set(0);
    this.side.set('center');
    this.lastBeat.set(null);
    void this.context?.close();
    this.context = undefined;
  }

  private cancelScheduledBeats(): void {
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
  }

  setBpm(value: number): void {
    const bpm = Math.min(240, Math.max(30, Math.round(value || 96)));
    this.bpm.set(bpm);
    const context = this.context;
    if (!context || !this.running()) return;

    this.cancelScheduledBeats();
    const lastBeat = this.lastBeat();
    this.nextBeatNumber = lastBeat
      ? (((lastBeat.number % this.beatsPerBar()) + 1) as 1 | 2 | 3 | 4)
      : 1;
    this.nextSide = lastBeat?.side === 'left' ? 'right' : 'left';
    this.nextBeatTime = context.currentTime + 60 / bpm;
    this.scheduleAhead();
  }

  setAccent(value: boolean): void {
    this.accent.set(value);
  }

  setBeatsPerBar(value: number): void {
    const beats = Math.min(4, Math.max(1, Math.round(value || 4))) as 1 | 2 | 3 | 4;
    this.beatsPerBar.set(beats);
    const context = this.context;
    if (!context || !this.running()) return;
    this.cancelScheduledBeats();
    this.nextBeatNumber = 1;
    this.nextBeatTime = context.currentTime + START_DELAY_SECONDS;
    this.beat.set(0);
    this.lastBeat.set(null);
    this.scheduleAhead();
  }

  setSound(value: MetronomeSound): void {
    this.sound.set(value in SOUND_PROFILES ? value : 'classic');
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
    this.nextBeatNumber = ((this.nextBeatNumber % this.beatsPerBar()) + 1) as 1 | 2 | 3 | 4;
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
    const profile = SOUND_PROFILES[this.sound()];
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = profile.wave;
    oscillator.frequency.value = accented ? profile.accentFrequency : profile.regularFrequency;
    gain.gain.setValueAtTime(accented ? profile.accentGain : profile.regularGain, audioTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioTime + profile.duration);
    oscillator.connect(gain).connect(context.destination);
    oscillator.onended = () => this.scheduledOscillators.delete(oscillator);
    this.scheduledOscillators.add(oscillator);
    oscillator.start(audioTime);
    oscillator.stop(audioTime + profile.duration + 0.005);

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
