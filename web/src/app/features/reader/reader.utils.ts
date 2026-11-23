export function pageDeltaForKey(key: string): number {
  if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(key)) return 1;
  if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(key)) return -1;
  return 0;
}

/** `half` is a single-page layout that turns half a page at a time (BND-043). */
export type SpreadPreference = 'auto' | 'single' | 'spread' | 'half';

export const spreadPreferences: readonly SpreadPreference[] = ['auto', 'single', 'spread', 'half'];

export const spreadLabels: Record<SpreadPreference, string> = {
  auto: 'Auto',
  single: 'Single',
  spread: 'Spread',
  half: 'Half turn',
};

/** Auto mode shows two pages only on a landscape viewport at least this wide, in CSS pixels. */
export const spreadMinWidth = 900;

/** Gap between the two pages of a spread, in CSS pixels. */
export const spreadGap = 8;

export function nextSpreadPreference(preference: SpreadPreference): SpreadPreference {
  return spreadPreferences[(spreadPreferences.indexOf(preference) + 1) % spreadPreferences.length];
}

/** Whether page mode should show two pages side by side. A one-page score never does. */
export function spreadActive(
  preference: SpreadPreference,
  width: number,
  height: number,
  pageCount: number,
): boolean {
  if (pageCount < 2 || preference === 'single' || preference === 'half') return false;
  return preference === 'spread' || (width > height && width >= spreadMinWidth);
}

/** Spreads pair pages (1, 2), (3, 4), …, so the left page of a spread is always odd. */
export function spreadStartPage(page: number): number {
  return page - ((page - 1) % 2);
}

/**
 * Half turns step through 2 * (pages - 1) + 1 positions: position 2k shows page k + 1 whole and
 * position 2k + 1 shows the top of page k + 2 over the bottom of page k + 1.
 */
export function halfTurnPosition(page: number, turned: boolean): number {
  return 2 * (page - 1) + (turned ? 1 : 0);
}

/** The page and half-turn state at a half-turn position. */
export function halfTurnFromPosition(position: number): { page: number; turned: boolean } {
  return { page: Math.floor(position / 2) + 1, turned: position % 2 === 1 };
}

/** The last half-turn position: the final page shown whole. */
export function lastHalfTurnPosition(pageCount: number): number {
  return Math.max(0, 2 * (pageCount - 1));
}

/**
 * The vertical shift that centers a half turn's two halves in the stage. Both pages are centered
 * on one middle line, so the later page's top half ends and the earlier page's bottom half begins
 * there; the pair spans from `later / 2` above it to `earlier / 2` below it, which is
 * `(earlier - later) / 4` off center when the pages differ in height.
 */
export function halfTurnShift(pages: readonly Pick<HTMLElement, 'style'>[]): number {
  const [earlier, later] = pages.map((page) => Number.parseFloat(page.style.height) || 0);
  return later === undefined ? 0 : (later - earlier) / 4;
}

const spreadStorageKey = 'noted.reader.spread';

/** Reads this device's layout choice; anything missing or malformed means auto. */
export function loadSpreadPreference(storage?: Pick<Storage, 'getItem'>): SpreadPreference {
  try {
    // Reading `localStorage` itself throws when the browser blocks storage.
    const saved = (storage ?? localStorage).getItem(spreadStorageKey);
    return spreadPreferences.find((preference) => preference === saved) ?? 'auto';
  } catch {
    return 'auto';
  }
}

/** Remembers the layout choice on this device; storage failures are not worth surfacing. */
export function saveSpreadPreference(
  preference: SpreadPreference,
  storage?: Pick<Storage, 'setItem'>,
): void {
  try {
    (storage ?? localStorage).setItem(spreadStorageKey, preference);
  } catch {
    // Private browsing or a full quota must not interrupt reading.
  }
}

export interface ReaderPointerPosition {
  clientX: number;
  clientY: number;
}

export interface ReaderPointerMove extends ReaderPointerPosition {
  pointerType: string;
}

export interface ReaderPointerTracking {
  baseline: ReaderPointerMove | undefined;
  moved: boolean;
}

const pointerMovementThreshold = 3;

export function trackFinePointerMovement(
  previous: ReaderPointerMove | undefined,
  event: ReaderPointerMove,
): ReaderPointerTracking {
  if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') {
    return { baseline: undefined, moved: false };
  }
  if (!previous || previous.pointerType !== event.pointerType) {
    return { baseline: pointerBaseline(event), moved: false };
  }
  const moved =
    Math.hypot(event.clientX - previous.clientX, event.clientY - previous.clientY) >=
    pointerMovementThreshold;
  return { baseline: moved ? pointerBaseline(event) : previous, moved };
}

function pointerBaseline(event: ReaderPointerMove): ReaderPointerMove {
  return {
    clientX: event.clientX,
    clientY: event.clientY,
    pointerType: event.pointerType,
  };
}
