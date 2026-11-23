import { HttpErrorResponse } from '@angular/common/http';
import { ApiService } from '../../core/api.service';
import { ReaderState } from '../../core/models';

export interface ReaderStateSaverHost {
  /** The state to save now, or nothing while no score is loaded to save it for. */
  capture(): ReaderState | undefined;
  /**
   * The score changed under a save. Returns whether the conflict is for the score on screen, in
   * which case saving stops until the reader reloads.
   */
  onConflict(state: ReaderState): boolean;
}

const saveDelayMs = 650;
const checkpointDelayMs = 10_000;

/** Saves the reader's state, one request at a time, keeping only the latest queued snapshot. */
export class ReaderStateSaver {
  private saveTimer?: number;
  private checkpointTimer?: number;
  private blocked = false;
  private inFlight = false;
  private pending?: ReaderState;

  constructor(
    private readonly api: ApiService,
    private readonly host: ReaderStateSaverHost,
  ) {}

  get isBlocked(): boolean {
    return this.blocked;
  }

  /** Forgets a conflict and any unsent state when the reader loads a score afresh. */
  reset(): void {
    this.blocked = false;
    this.pending = undefined;
  }

  /** Saves soon, and at least every few seconds while changes keep arriving. */
  queue(): void {
    if (this.blocked) return;
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.saveNow(), saveDelayMs);
    this.checkpointTimer ??= window.setTimeout(() => this.saveNow(), checkpointDelayMs);
  }

  saveNow(): void {
    const state = this.host.capture();
    if (!state || this.blocked) return;
    this.clearTimers();
    this.pending = state;
    this.flush();
  }

  dispose(): void {
    this.clearTimers();
  }

  private clearTimers(): void {
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    if (this.checkpointTimer) window.clearTimeout(this.checkpointTimer);
    this.checkpointTimer = undefined;
  }

  private flush(): void {
    if (this.inFlight || this.blocked || !this.pending) return;

    const state = this.pending;
    this.pending = undefined;
    this.inFlight = true;
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      this.inFlight = false;
      this.flush();
    };

    this.api.saveReaderState(state.pieceId, state).subscribe({
      error: (error: unknown) => {
        if (
          error instanceof HttpErrorResponse &&
          error.status === 409 &&
          this.host.onConflict(state)
        ) {
          this.blocked = true;
          this.pending = undefined;
        } else {
          console.warn('Reader state could not be saved', error);
        }
        finish();
      },
      complete: finish,
    });
  }
}
