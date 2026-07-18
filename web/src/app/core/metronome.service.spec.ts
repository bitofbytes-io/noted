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
  type: OscillatorType = 'sine';
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
  static oscillators: FakeOscillator[] = [];
  readonly destination = new FakeNode();
  private readonly createdAt = Date.now();
  get currentTime(): number {
    return (Date.now() - this.createdAt) / 1000;
  }
  resume = vi.fn(async () => undefined);
  close = vi.fn(async () => undefined);
  createOscillator(): OscillatorNode {
    const oscillator = new FakeOscillator();
    FakeAudioContext.oscillators.push(oscillator);
    return oscillator as unknown as OscillatorNode;
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
    FakeAudioContext.oscillators = [];
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

  it('re-anchors the next audio and visual beat when tempo changes', async () => {
    const service = TestBed.inject(MetronomeService);
    service.setBpm(60);
    await service.start();
    await vi.advanceTimersByTimeAsync(200);
    service.setBpm(120);
    await vi.advanceTimersByTimeAsync(1500);

    expect(FakeAudioContext.starts.slice(0, 4)).toEqual([0.05, 0.7, 1.2, 1.7]);
    expect(service.lastBeat()).toMatchObject({ number: 4, bpm: 120, side: 'right' });
    service.stop();
  });

  it('cycles over the selected number of beats and restarts at beat one after a meter change', async () => {
    const service = TestBed.inject(MetronomeService);
    service.setBpm(120);
    service.setBeatsPerBar(3);
    await service.start();
    await vi.advanceTimersByTimeAsync(700);
    expect(service.lastBeat()?.number).toBe(2);

    service.setBeatsPerBar(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(service.lastBeat()?.number).toBe(1);
    expect(service.beatsPerBar()).toBe(2);
    service.stop();
  });

  it('uses distinct synthesized profiles for each click sound', async () => {
    const expected: Array<[Parameters<MetronomeService['setSound']>[0], OscillatorType, number]> = [
      ['classic', 'square', 1320],
      ['woodblock', 'triangle', 920],
      ['soft_tick', 'sine', 720],
    ];
    for (const [sound, wave, frequency] of expected) {
      const service = TestBed.inject(MetronomeService);
      service.setSound(sound);
      await service.start();
      const oscillator = FakeAudioContext.oscillators.at(-1);
      expect(oscillator?.type).toBe(wave);
      expect(oscillator?.frequency.value).toBe(frequency);
      service.stop();
    }
  });
});
