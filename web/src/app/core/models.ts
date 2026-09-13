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

export interface PageEdit {
  fitEdges?: boolean;
  margins?: number[];
  paperCleanupStrength?: number;
  paperCleanup?: boolean;
  id: string;
  sourceId: string;
  page: number;
  angle?: number;
  rotation?: number;
  outputWidth?: number;
  outputHeight?: number;
  scale?: number;
  x?: number;
  y?: number;
  crop?: number[];
  corners?: number[][];
}
export interface EditManifest {
  version: 1;
  pages: PageEdit[];
}
export interface ImportAsset {
  id: string;
  filename: string;
  mime: string;
  size: number;
  checksum: string;
  pageCount: number;
  width: number;
  height: number;
}
export interface ImportDraft {
  id: string;
  pieceId: string | null;
  revision: number;
  metadata: PieceInput;
  manifest: EditManifest;
  initialManifest: EditManifest;
  sources: ImportAsset[];
  finalized: boolean;
  updatedAt: string;
  maxFileBytes: number;
}
