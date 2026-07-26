import { describe, expect, it } from 'vitest';
import { pageDeltaForKey, trackFinePointerMovement } from './reader.utils';

describe('pageDeltaForKey', () => {
  it('maps keyboard and pedal-style navigation keys', () => {
    expect(pageDeltaForKey('PageDown')).toBe(1);
    expect(pageDeltaForKey('ArrowRight')).toBe(1);
    expect(pageDeltaForKey('PageUp')).toBe(-1);
    expect(pageDeltaForKey('Escape')).toBe(0);
  });
});

describe('trackFinePointerMovement', () => {
  it('recognizes genuine mouse and pen movement', () => {
    expect(
      trackFinePointerMovement(
        { clientX: 15, clientY: 30, pointerType: 'mouse' },
        {
          clientX: 20,
          clientY: 30,
          pointerType: 'mouse',
        },
      ).moved,
    ).toBe(true);
    expect(
      trackFinePointerMovement(
        { clientX: 20, clientY: 30, pointerType: 'pen' },
        {
          clientX: 24,
          clientY: 30,
          pointerType: 'pen',
        },
      ).moved,
    ).toBe(true);
  });

  it('ignores stationary pointermove events and touch panning', () => {
    expect(
      trackFinePointerMovement(
        { clientX: 20, clientY: 30, pointerType: 'mouse' },
        {
          clientX: 20,
          clientY: 30,
          pointerType: 'mouse',
        },
      ).moved,
    ).toBe(false);
    expect(
      trackFinePointerMovement(
        { clientX: 20, clientY: 30, pointerType: 'mouse' },
        {
          clientX: 60,
          clientY: 80,
          pointerType: 'touch',
        },
      ),
    ).toEqual({ baseline: undefined, moved: false });
  });

  it('accumulates successive sub-threshold moves until they qualify', () => {
    let baseline = trackFinePointerMovement(undefined, {
      clientX: 20,
      clientY: 30,
      pointerType: 'mouse',
    }).baseline;

    for (const clientX of [21, 22]) {
      const tracking = trackFinePointerMovement(baseline, {
        clientX,
        clientY: 30,
        pointerType: 'mouse',
      });
      expect(tracking.moved).toBe(false);
      expect(tracking.baseline?.clientX).toBe(20);
      baseline = tracking.baseline;
    }

    const tracking = trackFinePointerMovement(baseline, {
      clientX: 23,
      clientY: 30,
      pointerType: 'mouse',
    });
    expect(tracking.moved).toBe(true);
    expect(tracking.baseline?.clientX).toBe(23);
  });

  it('does not carry a touch or different fine-pointer baseline across modalities', () => {
    const touchTracking = trackFinePointerMovement(
      { clientX: 20, clientY: 30, pointerType: 'mouse' },
      { clientX: 120, clientY: 130, pointerType: 'touch' },
    );
    expect(touchTracking).toEqual({ baseline: undefined, moved: false });

    const firstMouseTracking = trackFinePointerMovement(touchTracking.baseline, {
      clientX: 120,
      clientY: 130,
      pointerType: 'mouse',
    });
    expect(firstMouseTracking.moved).toBe(false);

    const penTracking = trackFinePointerMovement(firstMouseTracking.baseline, {
      clientX: 220,
      clientY: 230,
      pointerType: 'pen',
    });
    expect(penTracking.moved).toBe(false);
    expect(penTracking.baseline).toEqual({
      clientX: 220,
      clientY: 230,
      pointerType: 'pen',
    });
  });
});
