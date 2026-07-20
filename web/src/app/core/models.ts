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
  authenticated: boolean;
  user?: User;
  authMode: string;
  development: boolean;
  capabilities: { recognition: boolean };
}

export interface Asset {
  id: string;
  editionId: string;
  assetType: 'pdf' | 'musicxml' | 'midi' | 'audio' | 'image';
  originalFilename: string;
  displayName?: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
  sourceUrl?: string;
  rightsNote: string;
  playbackCapable: boolean;
  archivedAt?: string;
  replacesAssetId?: string;
  derivedFromAssetId?: string;
  verificationState?: 'original' | 'unverified_ocr' | 'verified' | 'corrected';
  createdAt: string;
  contentUrl: string;
  downloadUrl: string;
  playbackValidation: PlaybackValidation;
  anchorCount?: number;
}

export interface MediaLink {
  id: string;
  editionId: string;
  kind: 'youtube';
  videoId: string;
  title: string;
  anchorCount: number;
  createdAt: string;
}

export interface MeasureAnchor {
  id?: string;
  measureNumber: number;
  positionMs: number;
}

export interface MeasureBox {
  measureNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MeasureMapPage {
  pageNumber: number;
  width: number;
  height: number;
  dpi: number;
  measures: MeasureBox[];
}

export interface MeasureMap {
  assetId: string;
  status: 'pending' | 'processing' | 'ready' | 'failed';
  pages: MeasureMapPage[];
  engineVersion?: string;
  failureMessage?: string;
  updatedAt: string;
}

export type PlaybackValidationStatus = 'not_checked' | 'ready' | 'needs_review' | 'blocked';

export interface PlaybackIssue {
  code: string;
  message: string;
  count: number;
  measures?: string[];
}

export interface PlaybackValidation {
  status: PlaybackValidationStatus;
  issues: PlaybackIssue[];
}

export type MetronomeSound = 'classic' | 'woodblock' | 'soft_tick';

export interface Edition {
  id: string;
  name: string;
  editor?: string;
  publisher?: string;
  publicationYear?: number;
  sourceUrl?: string;
  rightsNote?: string;
  archivedAt?: string;
  assets: Asset[];
  mediaLinks?: MediaLink[];
}

export type RecognitionMeasureConfidence = 'high' | 'medium' | 'low';

export interface RecognitionMeasureReport {
  partId: string;
  number: string;
  /** One-based index in the final normalized MusicXML consumed by the player. */
  measureIndex: number;
  sourceEngine: string;
  agreement: boolean;
  confidence: RecognitionMeasureConfidence;
  corrected: boolean;
  issues: string[];
}

export interface RecognitionPlayabilityReport {
  status: 'passed';
  measureCount: number;
  totalTicks?: number;
}

export interface RecognitionReport {
  schemaVersion: 1;
  totalMeasures: number;
  flaggedMeasures: number;
  correctedMeasures: number;
  suspectMeasures: number;
  selectedEngine: string;
  engines: Record<string, unknown>;
  measures: RecognitionMeasureReport[];
  playability: RecognitionPlayabilityReport;
}

export interface RecognitionJob {
  id: string;
  sourceAssetId: string;
  outputAssetId?: string;
  status: 'queued' | 'processing' | 'succeeded' | 'failed' | 'cancelled';
  jobKind?: 'transcribe' | 'measure_map';
  hints?: { implicitTuplets: boolean };
  engine: string;
  engineVersion: string;
  errorCode?: string;
  failureMessage?: string;
  projectDownloadUrl?: string;
  flaggedMeasures?: number;
  correctedMeasures?: number;
  report?: RecognitionReport;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
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
  metronomeBeatsPerBar: 1 | 2 | 3 | 4;
  metronomeSound: MetronomeSound;
}

export interface Tag {
  id: string;
  name: string;
}

export interface ApiList<T> {
  items: T[];
}
