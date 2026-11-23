import { Signal, WritableSignal, computed, signal } from '@angular/core';
import { ReaderMode } from '../../core/models';
import { halfTurnTarget, visiblePagesFor, wholeTurnTarget } from './reader-navigation';
import {
  SpreadPreference,
  halfTurnPosition,
  lastHalfTurnPosition,
  loadSpreadPreference,
  nextSpreadPreference,
  saveSpreadPreference,
  spreadActive,
} from './reader.utils';

export interface ReaderLayoutInputs {
  mode: Signal<ReaderMode>;
  currentPage: WritableSignal<number>;
  pageCount: Signal<number>;
}

/** Which pages page mode shows, as one page, a two-page spread or half-page turns, and how to turn. */
export class ReaderLayout {
  readonly spreadPreference = signal<SpreadPreference>(loadSpreadPreference());
  readonly viewport = signal({ width: 0, height: 0 });
  readonly spreading = computed(() =>
    spreadActive(
      this.spreadPreference(),
      this.viewport().width,
      this.viewport().height,
      this.inputs.pageCount(),
    ),
  );
  /** Whether page mode turns half a page at a time; a one-page score has nothing to turn into. */
  readonly halfTurning = computed(
    () =>
      this.inputs.mode() === 'page' &&
      this.spreadPreference() === 'half' &&
      this.inputs.pageCount() > 1,
  );
  /** Between half turns: the top of the next page shows over the bottom of the current one. */
  readonly halfTurned = signal(false);
  readonly halfShown = computed(() => this.halfTurning() && this.halfTurned());
  /** Vertical nudge in CSS pixels that centers the two halves of a turn on the stage. */
  readonly halfShift = signal(0);
  private readonly halfPosition = computed(() =>
    halfTurnPosition(this.inputs.currentPage(), this.halfShown()),
  );
  readonly visiblePages = computed(() =>
    visiblePagesFor({
      mode: this.inputs.mode(),
      spreading: this.spreading(),
      halfShown: this.halfShown(),
      currentPage: this.inputs.currentPage(),
      pageCount: this.inputs.pageCount(),
    }),
  );
  readonly canTurnBack = computed(() =>
    this.halfTurning() ? this.halfPosition() > 0 : this.visiblePages()[0] > 1,
  );
  readonly canTurnForward = computed(() =>
    this.halfTurning()
      ? this.halfPosition() < lastHalfTurnPosition(this.inputs.pageCount())
      : this.visiblePages()[this.visiblePages().length - 1] < this.inputs.pageCount(),
  );
  readonly pageLabel = computed(() => {
    const pages = this.visiblePages();
    return pages.length > 1 ? `${pages[0]}–${pages[1]}` : String(pages[0]);
  });

  constructor(private readonly inputs: ReaderLayoutInputs) {}

  /** Turns a page, or half a page, forward or back. Returns whether the shown pages changed. */
  turn(delta: number): boolean {
    const { currentPage, pageCount } = this.inputs;
    if (this.halfTurning()) {
      const next = halfTurnTarget(this.halfPosition(), delta, pageCount());
      if (!next) return false;
      currentPage.set(next.page);
      this.halfTurned.set(next.turned);
      return true;
    }
    const start = this.visiblePages()[0];
    const next = wholeTurnTarget(start, delta, pageCount(), this.spreading());
    if (next === start) return false;
    currentPage.set(next);
    return true;
  }

  cycleSpread(): void {
    const next = nextSpreadPreference(this.spreadPreference());
    this.spreadPreference.set(next);
    this.halfTurned.set(false);
    saveSpreadPreference(next);
  }
}
