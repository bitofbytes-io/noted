import { describe, expect, it } from 'vitest';
import { isFinePointerMovement, pageDeltaForKey } from './reader.utils';

describe('pageDeltaForKey', () => {
  it('maps keyboard and pedal-style navigation keys', () => {
    expect(pageDeltaForKey('PageDown')).toBe(1);
    expect(pageDeltaForKey('ArrowRight')).toBe(1);
    expect(pageDeltaForKey('PageUp')).toBe(-1);
    expect(pageDeltaForKey('Escape')).toBe(0);
  });
});

describe('isFinePointerMovement', () => {
  it('recognizes genuine mouse and pen movement', () => {
    expect(
      isFinePointerMovement(
        { clientX: 15, clientY: 30 },
        {
          clientX: 20,
          clientY: 30,
          pointerType: 'mouse',
        },
      ),
    ).toBe(true);
    expect(
      isFinePointerMovement(
        { clientX: 20, clientY: 30 },
        {
          clientX: 24,
          clientY: 30,
          pointerType: 'pen',
        },
      ),
    ).toBe(true);
  });

  it('ignores stationary pointermove events and touch panning', () => {
    expect(
      isFinePointerMovement(
        { clientX: 20, clientY: 30 },
        {
          clientX: 20,
          clientY: 30,
          pointerType: 'mouse',
        },
      ),
    ).toBe(false);
    expect(
      isFinePointerMovement(
        { clientX: 20, clientY: 30 },
        {
          clientX: 60,
          clientY: 80,
          pointerType: 'touch',
        },
      ),
    ).toBe(false);
  });
});
