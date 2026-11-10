import { beatIntervalSeconds, clampBeatsPerBar, clampBpm } from './metronome.utils';

/** The slice of Web Audio the metronome needs, so tests can supply a fake clock. */
export type MetronomeAudioState = 'suspended' | 'running' | 'closed' | 'interrupted';

export interface MetronomeAudioContext {
  readonly currentTime: number;
  /** `running` is the only state in which clicks are actually heard. */
  readonly state: MetronomeAudioState;
  readonly destination: unknown;
  resume(): Promise<void>;
  close(): Promise<void>;
  createOscillator(): MetronomeOscillator;
  createGain(): MetronomeGain;
  addEventListener(type: 'statechange', listener: () => void): void;
  removeEventListener(type: 'statechange', listener: () => void): void;
}

export interface MetronomeOscillator {
  frequency: { value: number };
  connect(destination: unknown): unknown;
  start(when: number): void;
  stop(when: number): void;
}

export interface MetronomeGain {
  gain: {
    setValueAtTime(value: number, when: number): unknown;
    exponentialRampToValueAtTime(value: number, when: number): unknown;
  };
  connect(destination: unknown): unknown;
}

export interface MetronomeTimers {
  setTimeout(handler: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

/** Wakes often enough to keep a short window of clicks queued ahead of the audio clock. */
export const schedulerIntervalMs = 25;
export const scheduleAheadSeconds = 0.12;
const startDelaySeconds = 0.06;
const clickSeconds = 0.05;
/** A beat later than this when the scheduler reaches it is skipped rather than played late. */
const maxLateSeconds = 0.05;
const accentHz = 1320;
const beatHz = 880;

export function createBrowserAudioContext(): MetronomeAudioContext {
  const AudioContextClass: typeof AudioContext | undefined =
    globalThis.AudioContext ??
    (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) throw new Error('Web Audio is unavailable.');
  return new AudioContextClass() as MetronomeAudioContext;
}

const browserTimers: MetronomeTimers = {
  setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms) as unknown as number,
  clearTimeout: (id) => globalThis.clearTimeout(id),
};

/**
 * Schedules clicks on the AudioContext clock. The timer only refills a short lookahead window,
 * so a late or throttled timer delays no click that is already queued; the audio hardware
 * plays each one at its exact time.
 */
export class MetronomeEngine {
  private context?: MetronomeAudioContext;
  private timer?: number;
  private nextBeatTime = 0;
  private beatIndex = 0;
  private bpm = 100;
  private beatsPerBar = 4;
  private pendingBeats: { time: number; beat: number }[] = [];
  /** A fresh context stays `suspended` until `resume()`; only a later drop-out is silence. */
  private heardRunning = false;

  /** Called near the moment each beat sounds, with its zero-based position in the bar. */
  onBeat?: (beat: number) => void;

  /**
   * Called when sound will not play: the device refused to start, or a running context was
   * interrupted or suspended while the page was still showing it as ticking.
   */
  onFailure?: () => void;

  constructor(
    private readonly createContext: () => MetronomeAudioContext = createBrowserAudioContext,
    private readonly timers: MetronomeTimers = browserTimers,
  ) {}

  get running(): boolean {
    return this.context !== undefined;
  }

  /**
   * Must be called from a user gesture so iOS Safari lets the audio context run. Returns false
   * when audio is unavailable.
   */
  start(bpm: number, beatsPerBar: number): boolean {
    if (this.context) return true;
    let context: MetronomeAudioContext;
    try {
      context = this.createContext();
    } catch {
      return false;
    }
    this.bpm = clampBpm(bpm);
    this.beatsPerBar = clampBeatsPerBar(beatsPerBar);
    this.heardRunning = false;
    this.context = context;
    context.addEventListener('statechange', this.onStateChange);
    void context
      .resume()
      .then(() => {
        if (this.context !== context) return;
        this.noteRunning(context);
        // `resume()` can settle on a context the platform has already interrupted.
        if (this.contextIsSilent(context.state)) this.fail(context);
      })
      .catch(() => {
        // The device refused to start: don't leave the controls claiming silent ticking.
        if (this.context !== context) return;
        this.fail(context);
      });
    // `resume()` may already have moved the context to `running` before the promise settles.
    this.noteRunning(context);
    this.beatIndex = 0;
    this.pendingBeats = [];
    this.nextBeatTime = context.currentTime + startDelaySeconds;
    this.tick();
    return true;
  }

  stop(): void {
    const context = this.context;
    if (!context) return;
    this.context = undefined;
    this.heardRunning = false;
    context.removeEventListener('statechange', this.onStateChange);
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
    this.pendingBeats = [];
    void context.close().catch(() => undefined);
  }

  setTempo(bpm: number): void {
    this.bpm = clampBpm(bpm);
  }

  setBeatsPerBar(beatsPerBar: number): void {
    this.beatsPerBar = clampBeatsPerBar(beatsPerBar);
  }

  private readonly onStateChange = (): void => {
    const context = this.context;
    if (!context) return;
    this.noteRunning(context);
    // An interruption freezes the audio clock while this timer would keep refilling it.
    if (this.contextIsSilent(context.state)) this.fail(context);
  };

  private noteRunning(context: MetronomeAudioContext): void {
    if (context.state === 'running') this.heardRunning = true;
  }

  /** `suspended` before the first `running` is normal startup, not a drop-out. */
  private contextIsSilent(state: MetronomeAudioState): boolean {
    switch (state) {
      case 'running':
        return false;
      case 'suspended':
        return this.heardRunning;
      case 'interrupted':
      case 'closed':
        return true;
      default: {
        const unexpected: never = state;
        void unexpected;
        return false;
      }
    }
  }

  private fail(context: MetronomeAudioContext): void {
    if (this.context !== context) return;
    this.stop();
    this.onFailure?.();
  }

  private readonly tick = (): void => {
    const context = this.context;
    if (!context) return;
    if (this.contextIsSilent(context.state)) {
      this.fail(context);
      return;
    }
    while (this.nextBeatTime < context.currentTime + scheduleAheadSeconds) {
      const beat = this.beatIndex % this.beatsPerBar;
      // After a stall, play on from the next pulse instead of bursting out the missed ones.
      if (this.nextBeatTime >= context.currentTime - maxLateSeconds) {
        this.scheduleClick(context, this.nextBeatTime, beat === 0);
        this.pendingBeats.push({ time: this.nextBeatTime, beat });
      }
      this.nextBeatTime += beatIntervalSeconds(this.bpm);
      this.beatIndex = (beat + 1) % this.beatsPerBar;
    }
    while (this.pendingBeats.length && this.pendingBeats[0].time <= context.currentTime) {
      const { beat } = this.pendingBeats.shift()!;
      this.onBeat?.(beat);
    }
    this.timer = this.timers.setTimeout(this.tick, schedulerIntervalMs);
  };

  private scheduleClick(context: MetronomeAudioContext, when: number, accent: boolean): void {
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    oscillator.frequency.value = accent ? accentHz : beatHz;
    envelope.gain.setValueAtTime(accent ? 1 : 0.7, when);
    envelope.gain.exponentialRampToValueAtTime(0.001, when + clickSeconds);
    oscillator.connect(envelope);
    envelope.connect(context.destination);
    oscillator.start(when);
    oscillator.stop(when + clickSeconds);
  }
}
