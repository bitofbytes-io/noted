export function pageDeltaForKey(key: string): number {
  if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(key)) return 1;
  if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(key)) return -1;
  return 0;
}

export type SpreadPreference = 'auto' | 'single' | 'spread';

export const spreadPreferences: readonly SpreadPreference[] = ['auto', 'single', 'spread'];

export const spreadLabels: Record<SpreadPreference, string> = {
  auto: 'Auto',
  single: 'Single',
  spread: 'Spread',
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
  if (pageCount < 2 || preference === 'single') return false;
  return preference === 'spread' || (width > height && width >= spreadMinWidth);
}

/** Spreads pair pages (1, 2), (3, 4), …, so the left page of a spread is always odd. */
export function spreadStartPage(page: number): number {
  return page - ((page - 1) % 2);
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
