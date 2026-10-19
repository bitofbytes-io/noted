import vectors from '../../../../testdata/search-fold-vectors.json';
import { fold, searchIndex, searchTerms } from './search';

// The API's foldSearch, searchTerms and searchIndex read the same vectors
// (internal/app/search_test.go).
describe('fold', () => {
  it('has vectors', () => {
    expect(vectors.length).toBeGreaterThan(0);
  });

  for (const { input, folded, terms, indexed } of vectors) {
    it(`folds ${JSON.stringify(input)}`, () => {
      expect(fold(input)).toBe(folded);
      expect(searchTerms(input).join(' ')).toBe(terms);
      expect(searchIndex(input)).toBe(indexed);
    });
  }
});
