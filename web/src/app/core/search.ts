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

/**
 * The opus and catalogue abbreviations that join the number after them, mapped
 * to the form search keeps: "Op. 28" and "opus 28" are op28, "K. 545" and
 * "KV 545" k545, and "No. 4" and "Nr. 4" no4.
 */
const CATALOGUES = new Map(
  Object.entries({
    op: 'op',
    opus: 'op',
    no: 'no',
    nr: 'no',
    bwv: 'bwv',
    k: 'k',
    kv: 'k',
    hob: 'hob',
    d: 'd',
    l: 'l',
    s: 's',
    hwv: 'hwv',
    rv: 'rv',
    bb: 'bb',
    woo: 'woo',
    sz: 'sz',
  }),
);

/**
 * The German note names that name a key before dur or moll: cis-moll is C♯
 * minor, Es-Dur E♭ major, h-moll B minor and b-moll B♭ minor.
 */
const GERMAN_KEYS = new Map(
  Object.entries({
    c: 'c',
    d: 'd',
    e: 'e',
    f: 'f',
    g: 'g',
    a: 'a',
    h: 'b',
    b: 'b flat',
    cis: 'c sharp',
    dis: 'd sharp',
    eis: 'e sharp',
    fis: 'f sharp',
    gis: 'g sharp',
    ais: 'a sharp',
    his: 'b sharp',
    ces: 'c flat',
    des: 'd flat',
    es: 'e flat',
    fes: 'f flat',
    ges: 'g flat',
    as: 'a flat',
  }),
);

const GERMAN_MODES = new Map(Object.entries({ dur: 'major', moll: 'minor' }));

const CATALOGUE_NUMBER = /^[0-9]+[a-z]?$/;
const GLUED_CATALOGUE = /^([a-z]+)([0-9]+[a-z]?)$/;
/** "Op. 28/4": a short number straight after an opus is its number within it. */
const OPUS_PART = /^[0-9]{1,3}$/;
const ROMAN_NUMERAL = /^[ivxl]+$/;
const ENGLISH_FLAT = /^[a-g]b$/;

/**
 * The words search matches for a text: its fold, with catalogue numbers and
 * keys written one way however they were typed. "Op. 28 No. 4" and "op28/4"
 * are both op28 no4, "KV 545" is k545, "Hob. XVI:52" hobxvi52, and "cis-moll",
 * "C# minor" and "c-sharp minor" are all c sharp minor. Each word of a search
 * is one of these terms. It is the API's searchTerms (internal/app/search.go);
 * both are tested against testdata/search-fold-vectors.json.
 *
 * A search keeps a bare number after an opus as typed: while "op 10 1833" is
 * typed, "op 10 18" must still find Op. 10 (1833). The stored text has both
 * forms of "op28/4", so the search "op28 4" still finds it.
 */
export function searchTerms(text: string): string[] {
  return catalogueTerms(text, false);
}

/**
 * searchTerms, with a 1–3 digit number straight after an opus read as its
 * number within it ("Op. 28/4" is op28 no4) when opusParts.
 */
export function catalogueTerms(text: string, opusParts: boolean): string[] {
  const words: string[] = [];
  for (const word of fold(text).split(' ').filter(Boolean)) {
    const parts = GLUED_CATALOGUE.exec(word);
    if (parts && CATALOGUES.has(parts[1])) words.push(parts[1], parts[2]);
    else words.push(word);
  }
  const at = (i: number) => words[i] ?? '';
  const terms: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const next = at(i + 1);
    const catalogue = CATALOGUES.get(word);
    if (catalogue === 'hob' && ROMAN_NUMERAL.test(next) && CATALOGUE_NUMBER.test(at(i + 2))) {
      terms.push(catalogue + next + at(i + 2));
      i += 2;
    } else if (catalogue && CATALOGUE_NUMBER.test(next)) {
      terms.push(catalogue + next);
      i++;
      if (opusParts && catalogue === 'op' && OPUS_PART.test(at(i + 1))) {
        terms.push('no' + at(i + 1));
        i++;
      }
    } else if (GERMAN_KEYS.has(word) && GERMAN_MODES.has(next)) {
      terms.push(...`${GERMAN_KEYS.get(word)} ${GERMAN_MODES.get(next)}`.split(' '));
      i++;
    } else if (ENGLISH_FLAT.test(word) && (next === 'major' || next === 'minor')) {
      // "Bb major" is B♭ major.
      terms.push(word[0], 'flat', next);
      i++;
    } else {
      terms.push(word);
    }
  }
  return terms;
}

/**
 * The search text stored for a text: its fold, then any of its catalogue
 * terms the fold lacks, opus parts included, so "Prelude Op.28/4" is stored as
 * "prelude op 28 4 op28 no4". It is the API's searchIndex.
 */
export function searchIndex(text: string): string {
  const folded = fold(text);
  const seen = new Set(folded.split(' '));
  let index = folded;
  for (const term of catalogueTerms(text, true)) {
    if (!seen.has(term)) {
      seen.add(term);
      index += ` ${term}`;
    }
  }
  return index;
}
