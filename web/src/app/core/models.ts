export type LearnerStatus =
  | 'Interested'
  | 'Assigned'
  | 'Learning'
  | 'Playable'
  | 'Polished'
  | 'Memorized'
  | 'Paused'
  | 'Archived';

export const learnerStatuses: LearnerStatus[] = [
  'Interested',
  'Assigned',
  'Learning',
  'Playable',
  'Polished',
  'Memorized',
  'Paused',
  'Archived',
];

export interface User {
  id: string;
  email: string;
  displayName: string;
  weekStartsOn: number;
  metronomeBpm: number;
  metronomeAccent: boolean;
}

export interface Session {
  user: User;
  authMode: string;
  development: boolean;
}

export interface Asset {
  id: string;
  editionId: string;
  assetType: 'pdf' | 'musicxml';
  originalFilename: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
  sourceUrl?: string;
  rightsNote: string;
  playbackCapable: boolean;
  createdAt: string;
  contentUrl: string;
}

export interface Edition {
  id: string;
  name: string;
  editor?: string;
  publisher?: string;
  publicationYear?: number;
  sourceUrl?: string;
  rightsNote?: string;
  assets: Asset[];
}

export interface Movement {
  id: string;
  sequenceNumber: number;
  title: string;
  tempoMarking?: string;
  measureCount?: number;
}

export interface LearnerState {
  status: LearnerStatus;
  isFavorite: boolean;
  personalDifficulty?: string;
  personalNotes?: string;
  lastBpm?: number;
  tags: string[];
}

export interface WorkSummary {
  id: string;
  title: string;
  composer: string;
  status: LearnerStatus;
  isFavorite: boolean;
  tags: string[];
  lastPracticed?: string;
  lastBpm?: number;
  hasPdf: boolean;
  hasPlayback: boolean;
  updatedAt: string;
}

export interface WorkDetail {
  id: string;
  title: string;
  subtitle?: string;
  composer: string;
  catalogNumber?: string;
  keySignature?: string;
  period?: string;
  publishedDifficultyLabel?: string;
  notes?: string;
  learnerState: LearnerState;
  movements: Movement[];
  editions: Edition[];
  practiceSummary: { totalSeconds: number; sessionCount: number };
}

export interface WeekDay {
  date: string;
  durationSeconds: number;
  sessionCount: number;
}

export interface WeekSummary {
  startsOn: string;
  days: WeekDay[];
  totalSeconds: number;
  sessionCount: number;
}

export interface Dashboard {
  currentWorks: WorkSummary[];
  recentImports: Asset[];
  week: WeekSummary;
}

export interface PracticeSession {
  id: string;
  workId: string;
  workTitle: string;
  movementId?: string;
  scoreAssetId?: string;
  startedAt: string;
  endedAt?: string;
  durationSeconds: number;
  entryMethod: 'timer' | 'manual';
  startMeasure?: number;
  endMeasure?: number;
  handPart?: string;
  startingBpm?: number;
  endingBpm?: number;
  notes?: string;
}

export interface PracticeInput {
  workId?: string;
  movementId?: string | null;
  scoreAssetId?: string | null;
  startedAt?: string;
  durationSeconds?: number;
  startMeasure?: number | null;
  endMeasure?: number | null;
  handPart?: string;
  startingBpm?: number | null;
  endingBpm?: number | null;
  notes?: string;
}

export interface Preferences {
  weekStartsOn: number;
  metronomeBpm: number;
  metronomeAccent: boolean;
}

export interface Tag {
  id: string;
  name: string;
}

export interface ApiList<T> {
  items: T[];
}
