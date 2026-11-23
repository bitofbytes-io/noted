/** Pointer travel beyond this, in CSS pixels, makes a press a drag rather than a tap. */
const dragDistance = 12;
const swipeDistance = 60;
const swipeSlack = 80;

/** Tells a horizontal swipe, which turns a page, from a tap, which the score handles. */
export class SwipeTracker {
  private start?: { x: number; y: number };
  private dragged = false;

  down(event: PointerEvent): void {
    this.start = { x: event.clientX, y: event.clientY };
    this.dragged = false;
  }

  /** Ends a press. Returns 1 or -1 for a swipe left or right, and 0 for anything else. */
  up(event: PointerEvent): number {
    if (!this.start) return 0;
    const deltaX = event.clientX - this.start.x;
    const deltaY = event.clientY - this.start.y;
    this.start = undefined;
    if (Math.hypot(deltaX, deltaY) > dragDistance) this.dragged = true;
    if (Math.abs(deltaX) > swipeDistance && Math.abs(deltaY) < swipeSlack) {
      return deltaX < 0 ? 1 : -1;
    }
    return 0;
  }

  cancel(): void {
    this.start = undefined;
    this.dragged = false;
  }

  /** Whether the press that just ended was a drag, whose click must not count as a tap. */
  consumeDrag(): boolean {
    const dragged = this.dragged;
    this.dragged = false;
    return dragged;
  }
}
