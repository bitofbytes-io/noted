/**
 * Letters that keep no combining mark to strip, and the accidentals, which
 * become words so "C#" finds "C♯".
 */
const LEFTOVERS: Record<string, string> = {
  ø: 'o',
  ł: 'l',
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  đ: 'd',
  ð: 'd',
  þ: 'th',
  ı: 'i',
  ς: 'σ',
  '♯': ' sharp ',
  '#': ' sharp ',
  '♭': ' flat ',
};
const LEFTOVER = new RegExp(`[${Object.keys(LEFTOVERS).join('')}]`, 'gu');

/**
 * The library's search form of a text: without accents, lower case, with every
 * run of other characters a single space, so "Dvořák: Op.101/7" folds to
 * "dvorak op 101 7". It is the API's foldSearch (internal/app/search.go); both
 * are tested against testdata/search-fold-vectors.json.
 */
export function fold(text: string): string {
  return text
    .normalize('NFKD')
    .toLowerCase()
    .replace(LEFTOVER, (letter) => LEFTOVERS[letter] ?? letter)
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
