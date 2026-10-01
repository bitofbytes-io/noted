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

/** The user's Send to Noted token as the account dialog sees it: never the token itself. */
export interface ShortcutToken {
  active: boolean;
  createdAt: string | null;
  lastUsedAt: string | null;
}

/** The one response that carries the token's plaintext. */
export interface ShortcutTokenCreated {
  token: string;
  createdAt: string;
  /** The published iCloud link to the Shortcut; empty until it is published. */
  installUrl: string;
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
  pdfChecksumSha256: string;
  mode: ReaderMode;
  lastPage: number;
  scrollPosition: number;
  zoom: number;
  scrollSpeed: number;
  scrollPaused: boolean;
  updatedAt?: string;
}

/** Mirrors MaxPreparedPages in internal/app/imports.go. */
export const MAX_PREPARED_PAGES = 10;

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
  imslpAutoFill?: {
    title?: string;
    composer?: string;
    titleEdited?: boolean;
    composerEdited?: boolean;
  };
  manifest: EditManifest;
  initialManifest: EditManifest;
  sources: ImportAsset[];
  finalized: boolean;
  updatedAt: string;
  maxFileBytes: number;
}

export interface IMSLPWork {
  title: string;
  composer: string;
  url: string;
}

export interface IMSLPSearch {
  status: 'ready' | 'unavailable' | 'throttled';
  results: IMSLPWork[];
}
