import { describe, expect, it, vi } from 'vitest';
import {
  MetronomeAudioContext,
  MetronomeEngine,
  MetronomeTimers,
  schedulerIntervalMs,
} from './metronome-engine';

interface ScheduledClick {
  when: number;
  hz: number;
}

/** A hand-cranked audio clock and timer queue, so scheduling can be checked deterministically. */
function fakeAudio(options: { resumeFails?: boolean } = {}) {
  const clicks: ScheduledClick[] = [];
  let now = 0;
  let closed = false;
  const context: MetronomeAudioContext = {
    get currentTime() {
      return now;
    },
    destination: {},
    resume: () =>
      options.resumeFails ? Promise.reject(new Error('no device')) : Promise.resolve(),
    close: () => {
      closed = true;
      return Promise.resolve();
    },
    createOscillator: () => {
      const click: Partial<ScheduledClick> = {};
      const oscillator = {
        frequency: {
          set value(hz: number) {
            click.hz = hz;
          },
          get value() {
            return click.hz ?? 0;
          },
        },
        connect: () => undefined,
        start: (when: number) => {
          click.when = when;
          clicks.push(click as ScheduledClick);
        },
        stop: () => undefined,
      };
      return oscillator;
    },
    createGain: () => ({
      gain: { setValueAtTime: () => undefined, exponentialRampToValueAtTime: () => undefined },
      connect: () => undefined,
    }),
  };

  let pending: { id: number; handler: () => void } | undefined;
  let nextId = 1;
  const timers: MetronomeTimers = {
    setTimeout: (handler) => {
      pending = { id: nextId++, handler };
      return pending.id;
    },
    clearTimeout: (id) => {
      if (pending?.id === id) pending = undefined;
    },
  };

  return {
    clicks,
    context,
    timers,
    get closed() {
      return closed;
    },
    get hasPendingTimer() {
      return pending !== undefined;
    },
    /** Stalls the page: the audio clock runs on, but the scheduler wakes only once, afterwards. */
    stall(seconds: number) {
      now += seconds;
      const timer = pending;
      pending = undefined;
      timer?.handler();
    },
    /** Advances the audio clock in timer-sized steps, firing the scheduler each time. */
    advance(seconds: number, jitter = 0) {
      const end = now + seconds;
      while (now < end) {
        now = Math.min(end, now + schedulerIntervalMs / 1000 + jitter);
        const timer = pending;
        pending = undefined;
        timer?.handler();
      }
    },
  };
}

describe('MetronomeEngine', () => {
  it('schedules clicks on the audio clock at exact beat intervals', () => {
    const audio = fakeAudio();
    const engine = new MetronomeEngine(() => audio.context, audio.timers);
    expect(engine.start(120, 4)).toBe(true);
    audio.advance(4);

    const times = audio.clicks.map((click) => click.when);
    expect(times.length).toBeGreaterThanOrEqual(8);
    for (let index = 1; index < times.length; index++) {
      expect(times[index] - times[index - 1]).toBeCloseTo(0.5, 10);
    }
    engine.stop();
  });

  it('keeps time even when the scheduling timer runs late', () => {
    const audio = fakeAudio();
    const engine = new MetronomeEngine(() => audio.context, audio.timers);
    engine.start(180, 4);
    audio.advance(5, 0.03);

    const times = audio.clicks.map((click) => click.when);
    for (let index = 1; index < times.length; index++) {
      expect(times[index] - times[index - 1]).toBeCloseTo(60 / 180, 10);
    }
    engine.stop();
  });

  it('queues each click ahead of the clock rather than at the moment it sounds', () => {
    const audio = fakeAudio();
    const engine = new MetronomeEngine(() => audio.context, audio.timers);
    engine.start(100, 4);
    expect(audio.clicks[0].when).toBeGreaterThan(audio.context.currentTime);
    engine.stop();
  });

  it('accents the first beat of each bar', () => {
    const audio = fakeAudio();
    const engine = new MetronomeEngine(() => audio.context, audio.timers);
    engine.start(240, 3);
    audio.advance(3);

    const pitches = audio.clicks.map((click) => click.hz);
    const accent = pitches[0];
    expect(pitches.slice(0, 7)).toEqual([accent, 880, 880, accent, 880, 880, accent]);
    expect(accent).toBeGreaterThan(880);
    engine.stop();
  });

  it('reports the beat in the bar as it sounds', () => {
    const audio = fakeAudio();
    const engine = new MetronomeEngine(() => audio.context, audio.timers);
    const beats: number[] = [];
    engine.onBeat = (beat) => beats.push(beat);
    engine.start(120, 4);
    audio.advance(3);
    expect(beats.slice(0, 6)).toEqual([0, 1, 2, 3, 0, 1]);
    engine.stop();
  });

  it('follows tempo changes from the next beat on', () => {
    const audio = fakeAudio();
    const engine = new MetronomeEngine(() => audio.context, audio.timers);
    engine.start(60, 4);
    audio.advance(2);
    engine.setTempo(120);
    audio.advance(4);

    const times = audio.clicks.map((click) => click.when);
    const gaps = times.slice(1).map((time, index) => time - times[index]);
    expect(gaps[0]).toBeCloseTo(1, 10);
    expect(gaps[gaps.length - 1]).toBeCloseTo(0.5, 10);
    engine.stop();
  });

  it('follows beats-per-bar changes without losing the pulse', () => {
    const audio = fakeAudio();
    const engine = new MetronomeEngine(() => audio.context, audio.timers);
    const beats: number[] = [];
    engine.onBeat = (beat) => beats.push(beat);
    engine.start(240, 4);
    audio.advance(1);
    engine.setBeatsPerBar(2);
    audio.advance(2);
    expect(Math.max(...beats.slice(-6))).toBeLessThan(2);
    engine.stop();
  });

  it('stops scheduling and releases the audio context on stop', () => {
    const audio = fakeAudio();
    const engine = new MetronomeEngine(() => audio.context, audio.timers);
    engine.start(120, 4);
    audio.advance(1);
    const scheduled = audio.clicks.length;

    engine.stop();
    expect(engine.running).toBe(false);
    expect(audio.closed).toBe(true);
    expect(audio.hasPendingTimer).toBe(false);
    audio.advance(2);
    expect(audio.clicks.length).toBe(scheduled);
  });

  it('can start again after stopping', () => {
    const audio = fakeAudio();
    const engine = new MetronomeEngine(() => audio.context, audio.timers);
    engine.start(120, 4);
    engine.stop();
    expect(engine.start(120, 4)).toBe(true);
    expect(engine.running).toBe(true);
    engine.stop();
  });

  it('reports failure when Web Audio is unavailable', () => {
    const engine = new MetronomeEngine(() => {
      throw new Error('no audio');
    });
    expect(engine.start(120, 4)).toBe(false);
    expect(engine.running).toBe(false);
  });

  it('skips beats missed during a stall and resumes on the pulse', () => {
    const audio = fakeAudio();
    const engine = new MetronomeEngine(() => audio.context, audio.timers);
    const beats: number[] = [];
    engine.onBeat = (beat) => beats.push(beat);
    engine.start(120, 4);
    const before = audio.clicks.length;

    audio.stall(2);
    audio.advance(0.2);

    const resumed = audio.clicks.slice(before);
    expect(resumed.map((click) => click.when)).toEqual([expect.closeTo(2.06, 10)]);
    expect(beats).toEqual([0, 0]);
    engine.stop();
  });

  it('stops and reports when the audio device refuses to start', async () => {
    const audio = fakeAudio({ resumeFails: true });
    const engine = new MetronomeEngine(() => audio.context, audio.timers);
    const failed = vi.fn();
    engine.onFailure = failed;

    expect(engine.start(120, 4)).toBe(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(failed).toHaveBeenCalledTimes(1);
    expect(engine.running).toBe(false);
    expect(audio.closed).toBe(true);
  });

  it('never uses setInterval', () => {
    const interval = vi.spyOn(globalThis, 'setInterval');
    const audio = fakeAudio();
    const engine = new MetronomeEngine(() => audio.context, audio.timers);
    engine.start(120, 4);
    audio.advance(1);
    engine.stop();
    expect(interval).not.toHaveBeenCalled();
    interval.mockRestore();
  });
});
