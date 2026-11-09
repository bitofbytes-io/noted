import { describe, expect, it, vi } from 'vitest';
import {
  addTap,
  beatIntervalSeconds,
  clampBeatsPerBar,
  clampBpm,
  defaultMetronomeSettings,
  loadMetronomeSettings,
  saveMetronomeSettings,
  tapResetMs,
  tapTempoBpm,
} from './metronome.utils';

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
}

describe('metronome tempo', () => {
  it('keeps BPM whole and within 40-240', () => {
    expect(clampBpm(10)).toBe(40);
    expect(clampBpm(999)).toBe(240);
    expect(clampBpm(100.6)).toBe(101);
    expect(clampBpm(Number.NaN)).toBe(100);
  });

  it('keeps beats per bar between 1 and 12', () => {
    expect(clampBeatsPerBar(0)).toBe(1);
    expect(clampBeatsPerBar(40)).toBe(12);
    expect(clampBeatsPerBar(3.4)).toBe(3);
  });

  it('turns BPM into a beat interval', () => {
    expect(beatIntervalSeconds(60)).toBe(1);
    expect(beatIntervalSeconds(120)).toBe(0.5);
    expect(beatIntervalSeconds(1000)).toBe(0.25);
  });
});

describe('tap tempo', () => {
  function tapAt(times: number[]): number[] {
    return times.reduce<number[]>((taps, time) => addTap(taps, time), []);
  }

  it('needs two taps before suggesting a tempo', () => {
    expect(tapTempoBpm(tapAt([1000]))).toBeUndefined();
    expect(tapTempoBpm(tapAt([1000, 1500]))).toBe(120);
  });

  it('averages the gaps between recent taps', () => {
    expect(tapTempoBpm(tapAt([0, 500, 1000, 1500]))).toBe(120);
    expect(tapTempoBpm(tapAt([0, 480, 1020, 1500]))).toBe(120);
  });

  it('starts over after a long pause', () => {
    const taps = tapAt([0, 500, 1000, 1000 + tapResetMs + 1]);
    expect(taps).toEqual([1000 + tapResetMs + 1]);
    expect(tapTempoBpm(taps)).toBeUndefined();
  });

  it('keeps only the latest taps so a drifting tempo can follow', () => {
    const slow = Array.from({ length: 6 }, (_, index) => index * 1000);
    const fast = Array.from({ length: 6 }, (_, index) => 5000 + (index + 1) * 500);
    expect(tapTempoBpm(tapAt([...slow, ...fast]))).toBe(120);
  });

  it('clamps extreme tapping to the supported range', () => {
    expect(tapTempoBpm(tapAt([0, 50]))).toBe(240);
    expect(tapTempoBpm(tapAt([0, 1900]))).toBe(40);
  });

  it('ignores taps that arrive out of order or at the same instant', () => {
    expect(tapTempoBpm(tapAt([500, 100]))).toBeUndefined();
    expect(tapTempoBpm([700, 700])).toBeUndefined();
  });
});

describe('remembered metronome settings', () => {
  it('starts from defaults for a piece with nothing saved', () => {
    expect(loadMetronomeSettings('piece-1', memoryStorage())).toEqual(defaultMetronomeSettings);
  });

  it('remembers the last tempo for each piece separately', () => {
    const storage = memoryStorage();
    saveMetronomeSettings('piece-1', { bpm: 72, beatsPerBar: 3 }, storage);
    saveMetronomeSettings('piece-2', { bpm: 168, beatsPerBar: 6 }, storage);
    expect(loadMetronomeSettings('piece-1', storage)).toEqual({ bpm: 72, beatsPerBar: 3 });
    expect(loadMetronomeSettings('piece-2', storage)).toEqual({ bpm: 168, beatsPerBar: 6 });
    expect(loadMetronomeSettings('piece-3', storage)).toEqual(defaultMetronomeSettings);
  });

  it('repairs malformed or out-of-range saved values', () => {
    const key = 'noted.metronome.piece-1';
    expect(loadMetronomeSettings('piece-1', memoryStorage({ [key]: 'not json' }))).toEqual(
      defaultMetronomeSettings,
    );
    expect(loadMetronomeSettings('piece-1', memoryStorage({ [key]: '"text"' }))).toEqual(
      defaultMetronomeSettings,
    );
    expect(
      loadMetronomeSettings(
        'piece-1',
        memoryStorage({ [key]: JSON.stringify({ bpm: 9000, beatsPerBar: 'four' }) }),
      ),
    ).toEqual({ bpm: 240, beatsPerBar: 4 });
  });

  it('survives a browser that blocks access to localStorage itself', () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(loadMetronomeSettings('piece-1')).toEqual(defaultMetronomeSettings);
    expect(() => saveMetronomeSettings('piece-1', { bpm: 90, beatsPerBar: 4 })).not.toThrow();
    vi.restoreAllMocks();
  });

  it('survives storage that throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('full');
      },
    };
    expect(loadMetronomeSettings('piece-1', broken)).toEqual(defaultMetronomeSettings);
    expect(() =>
      saveMetronomeSettings('piece-1', { bpm: 90, beatsPerBar: 4 }, broken),
    ).not.toThrow();
  });
});
