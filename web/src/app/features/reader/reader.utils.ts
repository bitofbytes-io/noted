export function pageDeltaForKey(key: string): number {
  if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(key)) return 1;
  if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(key)) return -1;
  return 0;
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
