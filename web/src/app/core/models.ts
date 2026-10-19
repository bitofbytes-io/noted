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
}

export interface PiecePdf {
  originalFilename: string;
  sizeBytes: number;
  checksumSha256: string;
  pageCount: number;
  uploadedAt: string;
  contentUrl: string;
}

/** Where a piece sits in the pianist's work. Favorites are separate. */
export type PieceStatus = 'learning' | 'playing' | 'shelved';

export const PIECE_STATUSES: readonly { value: PieceStatus; label: string }[] = [
  { value: 'learning', label: 'Learning' },
  { value: 'playing', label: 'Playing' },
  { value: 'shelved', label: 'Shelved' },
];

/** The library's filter. `current` is Learning and Playing, the first-time default. */
export type LibraryFilter = 'current' | 'all' | 'favorites' | PieceStatus;

export const LIBRARY_FILTERS: readonly { value: LibraryFilter; label: string }[] = [
  { value: 'current', label: 'Learning & Playing' },
  { value: 'all', label: 'All' },
  { value: 'favorites', label: 'Favorites' },
  ...PIECE_STATUSES,
];

/** The library's order. Recently played and Fresh use when the reader last saved the piece. */
export type LibrarySort = 'title' | 'composer' | 'recent' | 'added' | 'fresh';

export const LIBRARY_SORTS: readonly { value: LibrarySort; label: string; hint?: string }[] = [
  { value: 'title', label: 'Title' },
  { value: 'composer', label: 'Composer' },
  { value: 'recent', label: 'Recently played' },
  { value: 'added', label: 'Recently added' },
  { value: 'fresh', label: 'Fresh', hint: 'least recently played first' },
];

/** Per-user settings kept on the server, so they follow the user across devices. */
export interface Preferences {
  libraryFilter: LibraryFilter;
  librarySort: LibrarySort;
}

export interface Piece {
  id: string;
  title: string;
  composer: string;
  favorite: boolean;
  status: PieceStatus;
  sourceUrl: string;
  listeningUrl: string;
  notes: string;
  /** Other names to search by, such as "Moonlight Sonata"; rows do not show them. */
  aliases: string;
  createdAt: string;
  updatedAt: string;
  pdf: PiecePdf | null;
  /** When the reader last saved this piece's place; null if it was never opened. */
  lastPlayedAt: string | null;
}

export interface PieceInput {
  title: string;
  composer: string;
  favorite: boolean;
  /** Set from the library only; import drafts leave it out. */
  status?: PieceStatus;
  sourceUrl: string;
  listeningUrl: string;
  notes: string;
  /** Set from the library only, like status; import drafts leave it out. */
  aliases?: string;
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
