import { describe, expect, it } from 'vitest';
import {
  halfTurnFromPosition,
  halfTurnPosition,
  lastHalfTurnPosition,
  loadSpreadPreference,
  nextSpreadPreference,
  pageDeltaForKey,
  saveSpreadPreference,
  spreadActive,
  spreadStartPage,
  trackFinePointerMovement,
} from './reader.utils';

describe('half-turn helpers', () => {
  it('maps pages and half steps to positions and back', () => {
    expect(halfTurnPosition(1, false)).toBe(0);
    expect(halfTurnPosition(1, true)).toBe(1);
    expect(halfTurnPosition(3, false)).toBe(4);
    expect(halfTurnFromPosition(5)).toEqual({ page: 3, turned: true });
    expect(halfTurnFromPosition(4)).toEqual({ page: 3, turned: false });
    expect(lastHalfTurnPosition(3)).toBe(4);
    expect(lastHalfTurnPosition(1)).toBe(0);
  });

  it('round-trips a stored half-turn choice', () => {
    const store = new Map<string, string>();
    saveSpreadPreference('half', { setItem: (key, value) => void store.set(key, value) });
    expect(loadSpreadPreference({ getItem: (key) => store.get(key) ?? null })).toBe('half');
  });
});

describe('spread helpers', () => {
  it('spreads only in landscape wide enough, unless the choice forces it', () => {
    expect(spreadActive('auto', 1366, 1024, 4)).toBe(true);
    expect(spreadActive('auto', 1024, 1366, 4)).toBe(false);
    expect(spreadActive('auto', 899, 500, 4)).toBe(false);
    expect(spreadActive('single', 1366, 1024, 4)).toBe(false);
    expect(spreadActive('spread', 1024, 1366, 4)).toBe(true);
    expect(spreadActive('spread', 1366, 1024, 1)).toBe(false);
    expect(spreadActive('half', 1366, 1024, 4)).toBe(false);
  });

  it('starts every spread on an odd page', () => {
    expect([1, 2, 3, 4, 5].map(spreadStartPage)).toEqual([1, 1, 3, 3, 5]);
  });

  it('cycles auto, single, spread, half turn', () => {
    expect(nextSpreadPreference('auto')).toBe('single');
    expect(nextSpreadPreference('single')).toBe('spread');
    expect(nextSpreadPreference('spread')).toBe('half');
    expect(nextSpreadPreference('half')).toBe('auto');
  });

  it('falls back to auto for a missing, unknown or unreadable choice', () => {
    expect(loadSpreadPreference({ getItem: () => null })).toBe('auto');
    expect(loadSpreadPreference({ getItem: () => 'wide' })).toBe('auto');
    expect(
      loadSpreadPreference({
        getItem: () => {
          throw new Error('blocked');
        },
      }),
    ).toBe('auto');
  });

  it('round-trips the choice and ignores storage that refuses writes', () => {
    const store = new Map<string, string>();
    saveSpreadPreference('spread', { setItem: (key, value) => void store.set(key, value) });
    expect(loadSpreadPreference({ getItem: (key) => store.get(key) ?? null })).toBe('spread');
    expect(() =>
      saveSpreadPreference('single', {
        setItem: () => {
          throw new Error('quota');
        },
      }),
    ).not.toThrow();
  });
});

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
