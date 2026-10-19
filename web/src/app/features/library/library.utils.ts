import { fold } from '../../core/search';
import { LibraryFilter, LibrarySort, Piece, PieceSummary } from '../../core/models';

/** What the library shows: the search as typed, the filter and the sort. */
export interface LibraryView {
  query: string;
  filter: LibraryFilter;
  sort: LibrarySort;
}

/**
 * The pieces the library shows, in order. Every folded word of the search must
 * appear in a piece's search text, as on the server. While searching, a title
 * that starts with the search comes first, then pieces where every word starts
 * a word, then the rest, each group in the chosen sort.
 */
export function filterAndSort(pieces: readonly PieceSummary[], view: LibraryView): PieceSummary[] {
  const query = fold(view.query);
  const words = query ? query.split(' ') : [];
  const shown = pieces.filter(
    (piece) =>
      inFilter(piece, view.filter, words.length > 0) &&
      words.every((word) => piece.searchText.includes(word)),
  );
  const order = ORDERS[view.sort];
  if (!words.length) return shown.sort(order);
  const ranks = new Map(shown.map((piece) => [piece.id, matchRank(piece, query, words)]));
  return shown.sort((a, b) => ranks.get(a.id)! - ranks.get(b.id)! || order(a, b));
}

/** Whether the piece belongs under the filter. A search never hides a shelved piece. */
export function inFilter(piece: PieceSummary, filter: LibraryFilter, searching: boolean): boolean {
  switch (filter) {
    case 'current':
      return piece.status !== 'shelved' || searching;
    case 'all':
      return true;
    case 'favorites':
      return piece.favorite;
    default:
      return piece.status === filter;
  }
}

function matchRank(piece: PieceSummary, query: string, words: string[]): number {
  if (fold(piece.title).startsWith(query)) return 0;
  const text = ` ${piece.searchText}`;
  return words.every((word) => text.includes(` ${word}`)) ? 1 : 2;
}

/** The server's loose collation: case, accents and width are ignored. */
const collator = new Intl.Collator('und', { sensitivity: 'base' });

type Order = (a: PieceSummary, b: PieceSummary) => number;

function titleOrder(a: PieceSummary, b: PieceSummary): number {
  return (
    collator.compare(a.title, b.title) ||
    collator.compare(a.composer, b.composer) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** Newest first, with a missing time last. */
function newestFirst(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null || b === null) return a === null ? 1 : -1;
  return Date.parse(b) - Date.parse(a);
}

/** The library's sorts, as the API orders them (internal/app/service.go). */
const ORDERS: Record<LibrarySort, Order> = {
  title: titleOrder,
  composer: (a, b) => composerOrder(a.composer, b.composer) || titleOrder(a, b),
  recent: (a, b) => newestFirst(a.lastPlayedAt, b.lastPlayedAt) || titleOrder(a, b),
  added: (a, b) => newestFirst(a.createdAt, b.createdAt) || titleOrder(a, b),
  // Never played first, then the longest unplayed; pieces without a PDF last.
  fresh: (a, b) =>
    Number(!a.pdf) - Number(!b.pdf) ||
    -newestFirst(a.lastPlayedAt, b.lastPlayedAt) ||
    titleOrder(a, b),
};

/**
 * By composer surname, then the composer's full name, so C. P. E. Bach and
 * J. S. Bach stay apart; pieces without a composer go last. It is the API's
 * sortByComposer (internal/app/composer_sort.go).
 */
export function composerOrder(a: string, b: string): number {
  const aSurname = composerSurname(a);
  const bSurname = composerSurname(b);
  if (!aSurname !== !bSurname) return aSurname ? -1 : 1;
  return collator.compare(aSurname, bSurname) || collator.compare(a.trim(), b.trim());
}

/** "(arr. Liszt)" or "[attrib.]" says nothing about whose piece it is. */
const COMPOSER_ASIDES = /\([^)]*\)|\[[^\]]*\]/g;
/** Of "Rodgers & Hammerstein" or "Lennon/McCartney", the first name files the piece. */
const COMPOSER_JOINS = /\s+(?:&|and)\s+|\s*[/;+]\s*/i;
/** Name suffixes that come after a surname, compared without their dot. */
const COMPOSER_SUFFIXES = ['jr', 'sr', 'ii', 'iii', 'iv'];

/**
 * The surname a piece is filed under: the last word of the first composer
 * named, or what comes before a comma ("Bach, J. S."), skipping suffixes such
 * as "Jr." and asides in brackets; empty without a composer. It is the API's
 * composerSurname; both are tested against testdata/composer-surname-vectors.json.
 */
export function composerSurname(composer: string): string {
  let name = composer.replace(COMPOSER_ASIDES, ' ').trim().split(COMPOSER_JOINS)[0];
  const comma = name.indexOf(',');
  if (comma >= 0) {
    if (!isComposerSuffix(name.slice(comma + 1))) {
      // "Bach, Johann Sebastian": the surname comes first.
      const head = words(name.slice(0, comma));
      if (head.length) return head.join(' ');
    } else {
      // "Harry Connick, Jr."
      name = name.slice(0, comma);
    }
  }
  const named = words(name);
  while (named.length > 1 && isComposerSuffix(named[named.length - 1])) named.pop();
  return named.length ? named[named.length - 1].replace(/^[.,]+|[.,]+$/g, '') : '';
}

function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

function isComposerSuffix(word: string): boolean {
  return COMPOSER_SUFFIXES.includes(word.replace(/^[ .,]+|[ .,]+$/g, '').toLowerCase());
}

/** A saved piece as a library row; its search text is the server's fold of the same fields. */
export function summaryOf(piece: Piece): PieceSummary {
  return {
    id: piece.id,
    title: piece.title,
    composer: piece.composer,
    aliases: piece.aliases,
    favorite: piece.favorite,
    status: piece.status,
    listeningUrl: piece.listeningUrl,
    pdf: piece.pdf && { pageCount: piece.pdf.pageCount, contentUrl: piece.pdf.contentUrl },
    lastPlayedAt: piece.lastPlayedAt,
    createdAt: piece.createdAt,
    searchText: fold(`${piece.title} ${piece.composer} ${piece.aliases} ${piece.notes}`),
  };
}

export function listeningUrlError(value: string): string {
  const candidate = value.trim();
  if (!candidate) return '';
  if (candidate.length > 2000) return 'listening URL must be at most 2000 characters';
  try {
    const parsed = new URL(candidate);
    if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname) return '';
  } catch {
    // The shared validation message below is more useful than the browser's parser error.
  }
  return 'listening URL must be an http or https URL';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "1 Oct 2026" in the viewer's time zone: the account dialog's date style. */
export function formatDay(iso: string): string {
  const date = new Date(iso);
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

/** When a shortcut token was last used, by calendar day in the viewer's time zone. */
export function lastUsedText(iso: string | null, now = new Date()): string {
  if (!iso) return 'never';
  const used = new Date(iso);
  const day = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((day(now) - day(used)) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return formatDay(iso);
}

/** "Played yesterday": when the reader last saved the piece, in the shortcut's day wording. */
export function playedText(lastPlayedAt: string | null, now = new Date()): string {
  return lastPlayedAt ? `Played ${lastUsedText(lastPlayedAt, now)}` : 'Not played yet';
}
