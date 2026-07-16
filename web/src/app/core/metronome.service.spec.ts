import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MetronomeService } from './metronome.service';

class FakeAudioParam {
  value = 0;
  setValueAtTime = vi.fn();
  exponentialRampToValueAtTime = vi.fn();
}

class FakeNode {
  connect(): this {
    return this;
  }
}

class FakeOscillator extends FakeNode {
  frequency = new FakeAudioParam();
  onended: (() => void) | null = null;
  start = vi.fn((time?: number) => FakeAudioContext.starts.push(time ?? 0));
  stop = vi.fn();
}

class FakeGain extends FakeNode {
  gain = new FakeAudioParam();
}

class FakeAudioContext {
  static starts: number[] = [];
  readonly destination = new FakeNode();
  private readonly createdAt = Date.now();
  get currentTime(): number {
    return (Date.now() - this.createdAt) / 1000;
  }
  resume = vi.fn(async () => undefined);
  close = vi.fn(async () => undefined);
  createOscillator(): OscillatorNode {
    return new FakeOscillator() as unknown as OscillatorNode;
  }
  createGain(): GainNode {
    return new FakeGain() as unknown as GainNode;
  }
}

describe('MetronomeService', () => {
  let originalAudioContext: typeof AudioContext;

  beforeEach(() => {
    vi.useFakeTimers();
    FakeAudioContext.starts = [];
    originalAudioContext = globalThis.AudioContext;
    Object.defineProperty(globalThis, 'AudioContext', {
      configurable: true,
      value: FakeAudioContext,
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'AudioContext', {
      configurable: true,
      value: originalAudioContext,
    });
    vi.useRealTimers();
  });

  it('uses exact audio-clock intervals and keeps the visual beat in the same pattern', async () => {
    const service = TestBed.inject(MetronomeService);
    service.setBpm(96);
    await service.start();
    await vi.advanceTimersByTimeAsync(2000);

    expect(FakeAudioContext.starts.slice(0, 4)).toEqual([0.05, 0.675, 1.3, 1.925]);
    expect(service.beat()).toBe(4);
    expect(service.lastBeat()?.side).toBe('right');
    service.stop();
    expect(service.beat()).toBe(0);
    expect(service.side()).toBe('center');
  });

  it('applies a tempo change to the next unscheduled interval', async () => {
    const service = TestBed.inject(MetronomeService);
    service.setBpm(60);
    await service.start();
    await vi.advanceTimersByTimeAsync(200);
    service.setBpm(120);
    await vi.advanceTimersByTimeAsync(1500);

    expect(FakeAudioContext.starts.slice(0, 3)).toEqual([0.05, 1.05, 1.55]);
    service.stop();
  });
});
