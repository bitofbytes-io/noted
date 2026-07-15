import { validateMeasureRange } from './notation-playback.adapter';

describe('measure range validation', () => {
  it('accepts an inclusive range that exists in the score', () => {
    expect(validateMeasureRange(2, 7, 8)).toBe('');
  });

  it('rejects invalid start, ordering, and missing end measures', () => {
    expect(validateMeasureRange(0, 4, 8)).toContain('at least 1');
    expect(validateMeasureRange(5, 4, 8)).toContain('after the start');
    expect(validateMeasureRange(1, 9, 8)).toContain('at most 8');
  });
});
