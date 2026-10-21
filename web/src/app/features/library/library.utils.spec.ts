import { describe, expect, it } from 'vitest';
import vectors from '../../../../../testdata/composer-surname-vectors.json';
import { Piece, PieceSummary } from '../../core/models';
import { LibraryView, composerSurname, filterAndSort, summaryOf } from './library.utils';

// The API's composerSurname reads the same vectors (internal/app/composer_sort_test.go).
describe('composerSurname', () => {
  it('has vectors', () => {
    expect(vectors.length).toBeGreaterThan(0);
  });

  for (const { composer, surname } of vectors) {
    it(`files ${JSON.stringify(composer)} under ${JSON.stringify(surname)}`, () => {
      expect(composerSurname(composer)).toBe(surname);
    });
  }
});

function summary(fields: Partial<Piece> & Pick<Piece, 'title'>): PieceSummary {
  return summaryOf({
    id: fields.title,
    composer: '',
    favorite: false,
    status: 'playing',
    sourceUrl: '',
    listeningUrl: '',
    notes: '',
    aliases: '',
    opus: '',
    musicKey: '',
    createdAt: '2026-10-01T09:00:00Z',
    updatedAt: '2026-10-01T09:00:00Z',
    pdf: { pageCount: 1, contentUrl: '' } as Piece['pdf'],
    lastPlayedAt: null,
    ...fields,
  } as Piece);
}

const titles = (pieces: PieceSummary[]) => pieces.map((piece) => piece.title);
const view = (fields: Partial<LibraryView>): LibraryView => ({
  query: '',
  filter: 'all',
  sort: 'title',
  ...fields,
});

describe('filterAndSort', () => {
  it('orders by composer surname like the API, keeping title order within a composer', () => {
    const pieces = [
      summary({ title: 'Arabesque No. 1', composer: 'Claude Debussy' }),
      summary({ title: 'Clair de lune', composer: 'Claude Debussy' }),
      summary({ title: 'Exercise' }),
      summary({ title: 'Goldberg Variations', composer: 'Johann Sebastian Bach' }),
      summary({ title: 'Humoresque', composer: 'antonín dvořák' }),
      summary({ title: 'Maple Leaf Rag', composer: 'Scott Joplin' }),
      summary({ title: 'Nocturne Op. 9 No. 2', composer: 'Frédéric Chopin' }),
      summary({ title: 'Prelude in C major', composer: 'Bach, Johann Sebastian' }),
      summary({ title: 'Solfeggietto', composer: 'C. P. E. Bach' }),
      summary({ title: 'Ännchen', composer: 'Émile Waldteufel' }),
    ].reverse();
    // The same order as TestSortByComposer in internal/app/composer_sort_test.go.
    expect(titles(filterAndSort(pieces, view({ sort: 'composer' })))).toEqual([
      'Prelude in C major',
      'Solfeggietto',
      'Goldberg Variations',
      'Nocturne Op. 9 No. 2',
      'Arabesque No. 1',
      'Clair de lune',
      'Humoresque',
      'Maple Leaf Rag',
      'Ännchen',
      'Exercise',
    ]);
  });

  it('orders by title ignoring case and accents, then by the played and added times', () => {
    const pieces = [
      summary({
        title: 'b',
        createdAt: '2026-10-03T09:00:00Z',
        lastPlayedAt: '2026-10-10T09:00:00Z',
      }),
      summary({ title: 'Ä', createdAt: '2026-10-01T09:00:00Z', lastPlayedAt: null }),
      summary({ title: 'c', createdAt: '2026-10-02T09:00:00Z', pdf: null }),
      summary({
        title: 'D',
        createdAt: '2026-10-02T09:00:00Z',
        lastPlayedAt: '2026-10-12T09:00:00.123456Z',
      }),
    ];
    expect(titles(filterAndSort(pieces, view({ sort: 'title' })))).toEqual(['Ä', 'b', 'c', 'D']);
    expect(titles(filterAndSort(pieces, view({ sort: 'recent' })))).toEqual(['D', 'b', 'Ä', 'c']);
    expect(titles(filterAndSort(pieces, view({ sort: 'added' })))).toEqual(['b', 'c', 'D', 'Ä']);
    // Never played first, then the longest unplayed; no PDF last.
    expect(titles(filterAndSort(pieces, view({ sort: 'fresh' })))).toEqual(['Ä', 'b', 'D', 'c']);
  });

  it('filters by status and favorite, and a search never hides a shelved piece', () => {
    const pieces = [
      summary({ title: 'Learning', status: 'learning' }),
      summary({ title: 'Playing', status: 'playing', favorite: true }),
      summary({ title: 'Shelved', status: 'shelved' }),
    ];
    const shown = (fields: Partial<LibraryView>) => titles(filterAndSort(pieces, view(fields)));
    expect(shown({ filter: 'current' })).toEqual(['Learning', 'Playing']);
    expect(shown({ filter: 'all' })).toEqual(['Learning', 'Playing', 'Shelved']);
    expect(shown({ filter: 'favorites' })).toEqual(['Playing']);
    expect(shown({ filter: 'shelved' })).toEqual(['Shelved']);
    expect(shown({ filter: 'current', query: 'shelved' })).toEqual(['Shelved']);
    // Punctuation alone is no search.
    expect(shown({ filter: 'current', query: ' % ' })).toEqual(['Learning', 'Playing']);
    // A chosen filter still applies while searching.
    expect(shown({ filter: 'learning', query: 'shelved' })).toEqual([]);
  });

  it('requires every folded word, and ranks a title prefix, then word starts, then the rest', () => {
    const pieces = [
      summary({ title: 'Humoresque', composer: 'Antonín Dvořák', aliases: 'Op. 101' }),
      summary({ title: 'Pavane', composer: 'Gabriel Fauré', notes: 'Slow and singing' }),
      summary({ title: 'Ballade No. 1', composer: 'Frédéric Chopin' }),
      summary({ title: 'Ballade No. 4', composer: 'Frédéric Chopin' }),
      summary({ title: 'Valse', composer: 'Frédéric Chopin', aliases: 'Minute Waltz' }),
      summary({ title: 'Allegro', composer: 'Carl Ballard' }),
      summary({ title: 'Fireball', composer: 'Someone' }),
    ];
    const found = (query: string, sort: LibraryView['sort'] = 'title') =>
      titles(filterAndSort(pieces, view({ query, sort })));
    expect(found('DVOŘÁK')).toEqual(['Humoresque']);
    expect(found('op 101')).toEqual(['Humoresque']);
    expect(found('faure singing')).toEqual(['Pavane']);
    expect(found('chopin ballade 4')).toEqual(['Ballade No. 4']);
    expect(found('waltz chopin')).toEqual(['Valse']);
    expect(found('chopin sonata')).toEqual([]);
    // Title prefix, then a word start (Ballard), then inside a word (Fireball).
    expect(found('ball')).toEqual(['Ballade No. 1', 'Ballade No. 4', 'Allegro', 'Fireball']);
    // Within a rank, the chosen sort applies.
    expect(found('ball', 'composer')).toEqual([
      'Ballade No. 1',
      'Ballade No. 4',
      'Allegro',
      'Fireball',
    ]);
  });

  it('matches catalogue numbers and keys however either side wrote them', () => {
    const pieces = [
      summary({ title: 'Prelude Op.28/4', composer: 'Frédéric Chopin' }),
      summary({ title: 'Prelude and Fugue in C, BWV 846', composer: 'J. S. Bach' }),
      summary({ title: 'Sonata facile KV545', composer: 'Mozart' }),
      summary({ title: 'Fantaisie-Impromptu', composer: 'Chopin', aliases: 'cis-Moll' }),
      summary({ title: 'Nocturne in C♯ minor', composer: 'Frédéric Chopin' }),
    ];
    const found = (query: string) => titles(filterAndSort(pieces, view({ query })));
    expect(found('op 28 no 4')).toEqual(['Prelude Op.28/4']);
    expect(found('op28/4')).toEqual(['Prelude Op.28/4']);
    expect(found('bwv846')).toEqual(['Prelude and Fugue in C, BWV 846']);
    expect(found('K. 545')).toEqual(['Sonata facile KV545']);
    expect(found('c# minor')).toEqual(['Fantaisie-Impromptu', 'Nocturne in C♯ minor']);
    expect(found('cis-moll')).toEqual(['Fantaisie-Impromptu', 'Nocturne in C♯ minor']);
    // Typing the number a digit at a time keeps the piece in view.
    expect(found('bwv 84')).toEqual(['Prelude and Fugue in C, BWV 846']);
  });

  it('keeps a year after an opus in view while it is typed', () => {
    const pieces = [summary({ title: 'Études, Op. 10 (1833)', composer: 'Frédéric Chopin' })];
    for (const query of ['op 10 1', 'op 10 18', 'op 10 183', 'op 10 1833']) {
      expect(titles(filterAndSort(pieces, view({ query })))).toEqual(['Études, Op. 10 (1833)']);
    }
  });

  it('ranks a title that starts with the search as typed first', () => {
    const pieces = [
      summary({ title: 'Allegro', aliases: 'Opus 28' }),
      summary({ title: 'Opus 28' }),
      summary({ title: 'Ballade', aliases: 'cis-Moll' }),
      summary({ title: 'cis-Moll Prelude' }),
    ];
    const found = (query: string) => titles(filterAndSort(pieces, view({ query })));
    expect(found('opus')).toEqual(['Opus 28', 'Allegro']);
    expect(found('cis')).toEqual(['cis-Moll Prelude', 'Ballade']);
    // The search terms still rank a title start: "op28" begins "Opus 28".
    expect(found('op28')).toEqual(['Opus 28', 'Allegro']);
  });

  it('ranks a title that starts with the same opus part however it is written', () => {
    const pieces = [
      summary({ title: 'Allegro', aliases: 'Op. 28 No. 4' }),
      summary({ title: 'Op.28/4 Prelude' }),
      summary({ title: 'Op. 28 No. 4 in E minor' }),
    ];
    const found = (query: string) => titles(filterAndSort(pieces, view({ query })));
    expect(found('op 28 no 4')).toEqual(['Op. 28 No. 4 in E minor', 'Op.28/4 Prelude', 'Allegro']);
    expect(found('op28/4')).toEqual(['Op. 28 No. 4 in E minor', 'Op.28/4 Prelude', 'Allegro']);
  });

  it('folds a saved piece into the same search text as the server', () => {
    expect(
      summary({
        title: 'Nocturne in C♯ minor',
        composer: 'Frédéric Chopin',
        aliases: 'Lento con gran espressione',
        notes: 'Op. posth.',
      }).searchText,
    ).toBe(
      'nocturne in c sharp minor frederic chopin lento con gran espressione op posth csharpminor',
    );
  });
});

describe('whole catalogue ranking', () => {
  it('puts op10 before op101/106 while preserving the chosen sort in ties', () => {
    const pieces = [
      summary({ title: 'Op. 101', composer: 'Bach' }),
      summary({ title: 'Op. 106', composer: 'Chopin' }),
      summary({ title: 'Z study', composer: 'Bach', opus: 'Op. 10', favorite: true }),
      summary({ title: 'A study', composer: 'Chopin', opus: 'Op. 10', favorite: true }),
    ];
    expect(titles(filterAndSort(pieces, view({ query: 'op10', sort: 'composer' })))).toEqual([
      'Z study',
      'A study',
      'Op. 101',
      'Op. 106',
    ]);
    expect(titles(filterAndSort(pieces, view({ query: 'op10 ba' })))).toEqual([
      'Z study',
      'Op. 101',
    ]);
    expect(titles(filterAndSort(pieces, view({ query: 'op10', filter: 'favorites' })))).toEqual([
      'A study',
      'Z study',
    ]);
  });
  it('uses separate fields after a save and excludes the wrong key', () => {
    const pieces = [
      summary({ title: 'F♯ minor', composer: 'Chopin' }),
      summary({ title: 'Etude', musicKey: 'C♯ minor' }),
      summary({ title: 'Op.', notes: '10' }),
    ];
    expect(titles(filterAndSort(pieces, view({ query: 'c# minor' })))).toEqual(['Etude']);
    expect(titles(filterAndSort(pieces, view({ query: 'op10' })))).toEqual([]);
  });
});
