import { positionForMeasure } from './playback-sync';

describe('positionForMeasure', () => {
  const anchors = [
    { measureNumber: 5, positionMs: 40_000 },
    { measureNumber: 1, positionMs: 0 },
    { measureNumber: 9, positionMs: 80_000 },
  ];

  it('uses exact anchors and interpolates between them', () => {
    expect(positionForMeasure(anchors, 5)).toBe(40_000);
    expect(positionForMeasure(anchors, 3)).toBe(20_000);
    expect(positionForMeasure(anchors, 7)).toBe(60_000);
  });

  it('extrapolates at the ends without returning a negative position', () => {
    expect(positionForMeasure(anchors, 11)).toBe(100_000);
    expect(positionForMeasure(anchors, 0)).toBe(0);
  });

  it('degrades to the only anchor and handles no anchors', () => {
    expect(positionForMeasure([{ measureNumber: 4, positionMs: 12_000 }], 9)).toBe(12_000);
    expect(positionForMeasure([], 1)).toBeNull();
  });
});
