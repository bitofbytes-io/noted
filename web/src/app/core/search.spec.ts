import matches from '../../../../testdata/search-match-vectors.json';
import vectors from '../../../../testdata/search-fold-vectors.json';
import { fold, isKeyTerm, matchesSearchTerm, searchIndex, searchTerms } from './search';

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

describe('musical search matches', () => {
  for (const vector of matches) {
    it(`${vector.query} in ${JSON.stringify(vector.fields)}`, () => {
      const index = searchIndex(...vector.fields);
      expect(searchTerms(vector.query).every((term) => matchesSearchTerm(index, term))).toBe(
        vector.matches,
      );
    });
  }
  it('classifies joined keys for exact suggestions', () => {
    expect(['csharpminor', 'eflatmajor', 'csharp', 'bminor'].every(isKeyTerm)).toBe(true);
    expect(isKeyTerm('chopin')).toBe(false);
  });
});
