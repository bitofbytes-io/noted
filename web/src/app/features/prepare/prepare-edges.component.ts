import { Component, OnDestroy, input, model } from '@angular/core';

export type EdgeMode = 'crop' | 'corners';

/**
 * Moves one corner of the pending page edges to (x, y), in fractions of the page.
 * A crop (or a Shift-drag) keeps a rectangle at least 5% wide and tall; a
 * perspective quad rejects crossed, collapsed or nearly collinear shapes. Returns
 * null when the move is rejected and the edges stay as they are.
 */
export function moveEdgeCorner(
  points: number[][],
  mode: EdgeMode,
  index: number,
  x: number,
  y: number,
  rectangle = false,
): number[][] | null {
  x = Math.max(0, Math.min(1, x));
  y = Math.max(0, Math.min(1, y));
  const next = points.map((p) => [...p]);
  if (mode === 'crop' || rectangle) {
    const anchor = next[(index + 2) % 4],
      gap = 0.050001,
      left = index === 0 || index === 3,
      top = index < 2;
    x = left ? Math.min(x, anchor[0] - gap) : Math.max(x, anchor[0] + gap);
    y = top ? Math.min(y, anchor[1] - gap) : Math.max(y, anchor[1] + gap);
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    const l = left ? x : anchor[0],
      r = left ? anchor[0] : x,
      t = top ? y : anchor[1],
      b = top ? anchor[1] : y;
    return [
      [l, t],
      [r, t],
      [r, b],
      [l, b],
    ];
  }
  next[index] = [x, y];
  // Reject crossed, collapsed, or nearly collinear quads, for pointer and keyboard alike.
  for (let i = 0; i < 4; i++) {
    const a = next[i],
      b = next[(i + 1) % 4],
      c = next[(i + 2) % 4];
    if (
      Math.hypot(b[0] - a[0], b[1] - a[1]) < 0.05 ||
      (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) <= 0.0025
    )
      return null;
  }
  return next;
}

/**
 * The page edge editor drawn over the preview image: the shaded outline and the four
 * corner handles, moved by pointer drag or arrow keys. Prepare owns when editing
 * starts and what Apply or Cancel does with the points.
 */
@Component({
  selector: 'app-prepare-edges',
  templateUrl: './prepare-edges.component.html',
  styleUrl: './prepare-edges.component.scss',
})
export class PrepareEdgesComponent implements OnDestroy {
  /** Pending corners, clockwise from top left, as fractions of the image. */
  readonly points = model.required<number[][]>();
  readonly mode = input.required<EdgeMode>();
  /** The preview image the corners are placed on. */
  readonly image = input.required<HTMLImageElement>();
  readonly busy = input(false);
  /** False until the unadjusted preview shows. */
  readonly ready = input(false);
  /** Mixed crop and perspective edits must be reset before the corners move. */
  readonly resetRequired = input(false);
  private dragCleanup?: () => void;

  get polygon() {
    return this.points()
      .map(([x, y]) => `${x * 100},${y * 100}`)
      .join(' ');
  }

  get shade() {
    return `M0 0H100V100H0Z M${this.points()
      .map(([x, y]) => `${x * 100} ${y * 100}`)
      .join('L')}Z`;
  }

  ngOnDestroy() {
    this.endDrag();
  }

  /** Stops a corner drag in progress and releases its pointer. */
  endDrag() {
    this.dragCleanup?.();
  }

  dragCorner(event: PointerEvent, index: number) {
    if (
      this.busy() ||
      !this.ready() ||
      this.resetRequired() ||
      !event.isPrimary ||
      event.button !== 0
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    document.getSelection()?.removeAllRanges();
    this.dragCleanup?.();
    const target = event.currentTarget as HTMLElement;
    const rect = this.image().getBoundingClientRect();
    target.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => {
      if (e.pointerId !== event.pointerId) return;
      e.preventDefault();
      e.stopPropagation();
      this.setEdge(
        index,
        (e.clientX - rect.left) / rect.width,
        (e.clientY - rect.top) / rect.height,
        e.shiftKey,
      );
    };
    const cleanup = (e?: PointerEvent) => {
      if (e && e.pointerId !== event.pointerId) return;
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', cleanup);
      target.removeEventListener('pointercancel', cleanup);
      target.removeEventListener('lostpointercapture', cleanup);
      if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
      this.dragCleanup = undefined;
    };
    this.dragCleanup = cleanup;
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', cleanup);
    target.addEventListener('pointercancel', cleanup);
    target.addEventListener('lostpointercapture', cleanup);
  }

  nudgeCorner(index: number, event: KeyboardEvent) {
    const delta: Record<string, number[]> = {
      ArrowLeft: [-0.01, 0],
      ArrowRight: [0.01, 0],
      ArrowUp: [0, -0.01],
      ArrowDown: [0, 0.01],
    };
    if (!delta[event.key] || !this.ready()) return;
    event.preventDefault();
    const p = this.points()[index],
      d = delta[event.key];
    this.setEdge(index, p[0] + d[0], p[1] + d[1], event.shiftKey);
  }

  private setEdge(index: number, x: number, y: number, rectangle = false) {
    if (!this.ready() || this.resetRequired()) return;
    const next = moveEdgeCorner(this.points(), this.mode(), index, x, y, rectangle);
    if (next) this.points.set(next);
  }
}
