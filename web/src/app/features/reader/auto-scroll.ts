export interface AutoScrollHost {
  /** Whether the stage should be scrolling now. */
  running(): boolean;
  stage(): HTMLElement;
  /** Pixels per second. */
  speed(): number;
  /** The stage scrolled to the bottom of the score. */
  reachedEnd(): void;
}

/** Scrolls the stage at the reader's chosen speed, one animation frame at a time. */
export class AutoScroll {
  private frame?: number;
  private timestamp = 0;
  private remainder = 0;

  constructor(private readonly host: AutoScrollHost) {}

  /** Starts or stops scrolling to match the host's state. */
  sync(): void {
    this.stop();
    if (!this.host.running()) return;
    const tick = (timestamp: number): void => {
      if (!this.host.running()) return;
      if (this.timestamp) {
        const elapsed = Math.min(0.1, (timestamp - this.timestamp) / 1000);
        const stage = this.host.stage();
        const distance = this.remainder + this.host.speed() * elapsed;
        const wholePixels = Math.floor(distance);
        this.remainder = distance - wholePixels;
        if (wholePixels > 0) stage.scrollTop += wholePixels;
        const reachedEnd = stage.scrollTop + stage.clientHeight >= stage.scrollHeight - 1;
        if (reachedEnd) {
          this.host.reachedEnd();
          return;
        }
      }
      this.timestamp = timestamp;
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  stop(): void {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = undefined;
    this.timestamp = 0;
    this.remainder = 0;
  }
}
