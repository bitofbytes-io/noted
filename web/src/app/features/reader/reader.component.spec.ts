import { describe, expect, it } from 'vitest';
import { pageDeltaForKey } from './reader.utils';

describe('pageDeltaForKey', () => {
  it('maps keyboard and pedal-style navigation keys', () => {
    expect(pageDeltaForKey('PageDown')).toBe(1);
    expect(pageDeltaForKey('ArrowRight')).toBe(1);
    expect(pageDeltaForKey('PageUp')).toBe(-1);
    expect(pageDeltaForKey('Escape')).toBe(0);
  });
});
