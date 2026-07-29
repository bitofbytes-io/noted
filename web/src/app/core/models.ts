export interface User {
  id: string;
  email: string;
  displayName: string;
  avatarUrl?: string;
}

export interface Session {
  authenticated: boolean;
  authMode: 'development' | 'google';
  development: boolean;
  user?: User;
}

export interface PiecePdf {
  originalFilename: string;
  sizeBytes: number;
  checksumSha256: string;
  pageCount: number;
  uploadedAt: string;
  contentUrl: string;
}

export interface Piece {
  id: string;
  title: string;
  composer: string;
  favorite: boolean;
  sourceUrl: string;
  listeningUrl: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
  pdf: PiecePdf | null;
}

export interface PieceInput {
  title: string;
  composer: string;
  favorite: boolean;
  sourceUrl: string;
  listeningUrl: string;
  notes: string;
}

export type ReaderMode = 'page' | 'scroll';

export interface ReaderState {
  pieceId: string;
  mode: ReaderMode;
  lastPage: number;
  scrollPosition: number;
  zoom: number;
  scrollSpeed: number;
  scrollPaused: boolean;
  updatedAt?: string;
}
