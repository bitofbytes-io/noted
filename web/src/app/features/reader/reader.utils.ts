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

const pointerMovementThreshold = 3;

export function isFinePointerMovement(
  previous: ReaderPointerPosition | undefined,
  event: ReaderPointerMove,
): boolean {
  if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return false;
  if (!previous) return false;
  return (
    Math.hypot(event.clientX - previous.clientX, event.clientY - previous.clientY) >=
    pointerMovementThreshold
  );
}
