import vectors from '../../../../testdata/search-fold-vectors.json';
import { fold } from './search';

// The API's foldSearch reads the same vectors (internal/app/search_test.go).
describe('fold', () => {
  it('has vectors', () => {
    expect(vectors.length).toBeGreaterThan(0);
  });

  for (const { input, folded } of vectors) {
    it(`folds ${JSON.stringify(input)}`, () => {
      expect(fold(input)).toBe(folded);
    });
  }
});
