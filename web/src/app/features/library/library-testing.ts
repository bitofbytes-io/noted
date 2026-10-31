import { Piece, PieceSummary } from '../../core/models';
import { summaryOf } from './library.utils';

/** A test piece that is both a whole piece and its library row. */
export type TestPiece = Piece & PieceSummary;

export function testPiece(fields: Partial<Piece> & Pick<Piece, 'id' | 'title'>): TestPiece {
  const piece = {
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
    pdf: null,
    lastPlayedAt: null,
    ...fields,
  } as Piece;
  return { ...piece, searchText: summaryOf(piece).searchText };
}
