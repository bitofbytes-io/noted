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
  return foldLetters(text).trim();
}

/** fold without the trim: every run of other characters is still one space. */
function foldLetters(text: string): string {
  return text
    .replace(/[nN][°º]/gu, 'no ')
    .normalize('NFKD')
    .toLowerCase()
    .replace(LEFTOVER, (letter) => LEFTOVERS[letter] ?? letter)
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ');
}

/**
 * A text folded one character at a time, with where in the text each folded
 * character came from, so a match in the fold can be marked in the text as
 * written: "Dvořák" folds to "dvorak", and its "r" came from the "ř".
 */
export interface FoldedText {
  folded: string;
  /** For each folded character, the start and end of its character in the text. */
  starts: number[];
  ends: number[];
}

export function foldWithOffsets(text: string): FoldedText {
  const result: FoldedText = { folded: '', starts: [], ends: [] };
  let at = 0;
  for (const letter of text) {
    const end = at + letter.length;
    const folded = foldLetters(letter);
    // A combining mark folds away; it belongs to the letter before it.
    if (!folded && result.ends.length) result.ends[result.ends.length - 1] = end;
    result.folded += folded;
    for (let i = 0; i < folded.length; i++) {
      result.starts.push(at);
      result.ends.push(end);
    }
    at = end;
  }
  return result;
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
 * "C# minor" and "c-sharp minor" are all csharpminor. Each word of a search
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
  const shortAllowed: boolean[] = [];
  const normalized = text
    .replace(/[nN][°º]/gu, 'no ')
    .normalize('NFKD')
    .toLowerCase()
    .replace(LEFTOVER, (letter) => LEFTOVERS[letter] ?? letter);
  for (const match of normalized.matchAll(/[\p{L}\p{N}\p{M}]+/gu)) {
    const word = fold(match[0]);
    const allowed =
      !normalized.slice(0, match.index).trim() ||
      normalized.slice(match.index + match[0].length).startsWith('.');
    const parts = GLUED_CATALOGUE.exec(word);
    if (parts && CATALOGUES.has(parts[1]) && (!shortCatalogue(parts[1]) || allowed)) {
      words.push(parts[1], parts[2]);
      shortAllowed.push(allowed, false);
    } else {
      words.push(word);
      shortAllowed.push(allowed);
    }
  }
  const at = (i: number) => words[i] ?? '';
  const terms: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const next = at(i + 1);
    const catalogue = shortCatalogue(word) && !shortAllowed[i] ? undefined : CATALOGUES.get(word);
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
      terms.push(GERMAN_KEYS.get(word)!.replaceAll(' ', '') + GERMAN_MODES.get(next));
      i++;
    } else if (ENGLISH_FLAT.test(word)) {
      let mode = '';
      if (next === 'major' || next === 'minor') {
        mode = next;
        i++;
      }
      terms.push(word[0] + 'flat' + mode);
    } else if (/^[a-g]$/.test(word) && (next === 'sharp' || next === 'flat')) {
      let key = word + next;
      i++;
      if (['major', 'minor', 'm'].includes(at(i + 1))) {
        key += at(i + 1) === 'm' ? 'minor' : at(i + 1);
        i++;
      }
      terms.push(key);
    } else if (/^[a-g]$/.test(word) && (next === 'major' || next === 'minor')) {
      terms.push(word + next);
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
export function searchIndex(...fields: string[]): string {
  let index = fields.map(fold).filter(Boolean).join(' ');
  const seen = new Set(index.split(' '));
  for (const field of fields) {
    for (const term of catalogueTerms(field, true)) {
      if (!seen.has(term)) {
        seen.add(term);
        index += `${index ? ' ' : ''}${term}`;
      }
    }
  }
  return index;
}

function shortCatalogue(word: string): boolean {
  return ['s', 'd', 'l'].includes(word);
}

export function isKeyTerm(term: string): boolean {
  return /^[a-g](?:sharp|flat)?(?:major|minor)$|^[a-g](?:sharp|flat)$/.test(term);
}

export function matchesSearchTerm(index: string, term: string): boolean {
  if (!isKeyTerm(term)) return index.includes(term);
  return index
    .split(' ')
    .some((word) => word === term || (!/(?:major|minor)$/.test(term) && word.startsWith(term)));
}

export function exactTermRank(index: string, terms: string[]): number {
  const words = new Set(index.split(' '));
  return terms.filter((term) => !words.has(term)).length;
}
