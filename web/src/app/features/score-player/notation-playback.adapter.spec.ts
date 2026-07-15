import * as alphaTab from '@coderline/alphatab';
import { playerCursorSettings, validateMeasureRange } from './notation-playback.adapter';

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

describe('playback cursor settings', () => {
  it('enables the cursor, beat/note highlighting, and off-screen scrolling', () => {
    expect(playerCursorSettings(false)).toMatchObject({
      enableCursor: true,
      enableAnimatedBeatCursor: true,
      enableElementHighlighting: true,
      scrollMode: alphaTab.ScrollMode.OffScreen,
    });
  });

  it('keeps a stepped cursor while reduced motion is requested', () => {
    expect(playerCursorSettings(true)).toMatchObject({
      enableCursor: true,
      enableAnimatedBeatCursor: false,
      enableElementHighlighting: true,
      scrollSpeed: 0,
    });
  });
});
