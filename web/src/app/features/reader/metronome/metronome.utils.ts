export const minBpm = 40;
export const maxBpm = 240;
export const defaultBpm = 100;
export const minBeatsPerBar = 1;
export const maxBeatsPerBar = 12;
export const defaultBeatsPerBar = 4;

/** A gap longer than this starts a new tap-tempo measurement. */
export const tapResetMs = 2000;
const maxTaps = 6;

export interface MetronomeSettings {
  bpm: number;
  beatsPerBar: number;
}

export const defaultMetronomeSettings: MetronomeSettings = {
  bpm: defaultBpm,
  beatsPerBar: defaultBeatsPerBar,
};

export function clampBpm(value: number): number {
  return clampWhole(value, minBpm, maxBpm, defaultBpm);
}

export function clampBeatsPerBar(value: number): number {
  return clampWhole(value, minBeatsPerBar, maxBeatsPerBar, defaultBeatsPerBar);
}

export function beatIntervalSeconds(bpm: number): number {
  return 60 / clampBpm(bpm);
}

/** Records a tap, starting over after a long pause, and keeps only the latest few. */
export function addTap(taps: readonly number[], now: number): number[] {
  const last = taps[taps.length - 1];
  const kept = last === undefined || now - last > tapResetMs || now < last ? [] : taps;
  return [...kept, now].slice(-maxTaps);
}

/** The tempo implied by the average gap between taps; needs at least two. */
export function tapTempoBpm(taps: readonly number[]): number | undefined {
  if (taps.length < 2) return undefined;
  const averageGap = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
  if (!(averageGap > 0)) return undefined;
  return clampBpm(60000 / averageGap);
}

function clampWhole(value: number, minimum: number, maximum: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

const storagePrefix = 'noted.metronome.';

/** Reads the tempo last used with a piece; anything missing or malformed falls back to defaults. */
export function loadMetronomeSettings(
  pieceId: string,
  storage?: Pick<Storage, 'getItem'>,
): MetronomeSettings {
  try {
    // Reading `localStorage` itself throws when the browser blocks storage.
    const source = storage ?? localStorage;
    const saved: unknown = JSON.parse(source.getItem(storagePrefix + pieceId) ?? 'null');
    if (typeof saved !== 'object' || saved === null) return { ...defaultMetronomeSettings };
    const { bpm, beatsPerBar } = saved as Record<string, unknown>;
    return {
      bpm: typeof bpm === 'number' ? clampBpm(bpm) : defaultBpm,
      beatsPerBar:
        typeof beatsPerBar === 'number' ? clampBeatsPerBar(beatsPerBar) : defaultBeatsPerBar,
    };
  } catch {
    return { ...defaultMetronomeSettings };
  }
}

/** Remembers the tempo for a piece in this browser; storage failures are not worth surfacing. */
export function saveMetronomeSettings(
  pieceId: string,
  settings: MetronomeSettings,
  storage?: Pick<Storage, 'setItem'>,
): void {
  try {
    (storage ?? localStorage).setItem(storagePrefix + pieceId, JSON.stringify(settings));
  } catch {
    // Private browsing or a full quota must not interrupt practice.
  }
}
