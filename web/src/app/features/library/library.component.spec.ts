import { describe, expect, it } from 'vitest';
import { titleFromFilename } from './library.utils';

describe('titleFromFilename', () => {
  it('turns a scan filename into an editable title', () => {
    expect(titleFromFilename('bach_wtc-prelude-01.PDF')).toBe('bach wtc prelude 01');
  });
});
