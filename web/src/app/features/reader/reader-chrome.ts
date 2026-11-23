import { Signal, computed, signal } from '@angular/core';
import { ReaderPointerMove, trackFinePointerMovement } from './reader.utils';

export interface ReaderChromeHost {
  /** The chrome stays up while the score is loading or has failed. */
  held: Signal<boolean>;
  /** Whether keyboard focus sits in the top bar, controls or metronome, which keeps them up. */
  focusInside(): boolean;
  focusFirstControl(): void;
}

const hideDelayMs = 3000;

/** Shows the reader's chrome on activity and hides it again after a pause. */
export class ReaderChrome {
  readonly controlsVisible = signal(true);
  readonly bubbleVisible = signal(false);
  readonly visible = computed(() => this.host.held() || this.controlsVisible());
  private hideTimer?: number;
  private pointerBaseline?: ReaderPointerMove;

  constructor(private readonly host: ReaderChromeHost) {}

  show(event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    const keyboardActivation = event instanceof MouseEvent && event.detail === 0;
    this.bubbleVisible.set(false);
    this.controlsVisible.set(true);
    this.scheduleHide();
    if (keyboardActivation) setTimeout(() => this.host.focusFirstControl());
  }

  activity(): void {
    this.controlsVisible.set(true);
    this.scheduleHide();
  }

  /** Offers the show-controls bubble while the chrome is hidden. */
  offer(): void {
    if (this.host.held() || this.controlsVisible()) return;
    this.bubbleVisible.set(true);
  }

  onScorePointerMove(event: PointerEvent): void {
    if (this.trackMovement(event)) this.offer();
  }

  onChromePointerMove(event: PointerEvent): void {
    event.stopPropagation();
    if (this.trackMovement(event)) this.activity();
  }

  scheduleHide(): void {
    if (this.hideTimer) window.clearTimeout(this.hideTimer);
    if (this.host.held()) return;
    this.hideTimer = window.setTimeout(() => {
      if (this.host.focusInside()) {
        this.scheduleHide();
        return;
      }
      this.controlsVisible.set(false);
    }, hideDelayMs);
  }

  dispose(): void {
    if (this.hideTimer) window.clearTimeout(this.hideTimer);
  }

  private trackMovement(event: PointerEvent): boolean {
    const tracking = trackFinePointerMovement(this.pointerBaseline, event);
    this.pointerBaseline = tracking.baseline;
    return tracking.moved;
  }
}
