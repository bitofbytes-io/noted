import { ReaderMode } from '../../core/models';
import { clamp, halfTurnFromPosition, lastHalfTurnPosition, spreadStartPage } from './reader.utils';

export interface PageLayout {
  mode: ReaderMode;
  /** Whether page mode pairs pages into a spread. */
  spreading: boolean;
  /** Whether a half turn is between whole pages, showing the next page's top. */
  halfShown: boolean;
  currentPage: number;
  pageCount: number;
}

/**
 * The pages page mode shows: one, or a pair that starts on an odd page and may end alone. In a
 * half turn the pair is the current page and the next, drawn in the same place.
 */
export function visiblePagesFor(layout: PageLayout): number[] {
  const { currentPage } = layout;
  if (layout.halfShown) return [currentPage, currentPage + 1];
  if (layout.mode !== 'page' || !layout.spreading) return [currentPage];
  const start = spreadStartPage(currentPage);
  return start < layout.pageCount ? [start, start + 1] : [start];
}

/**
 * The first page shown after turning `delta` whole pages from `start`. A spread turns two pages at
 * a time; a trailing single page still counts as one spread.
 */
export function wholeTurnTarget(
  start: number,
  delta: number,
  pageCount: number,
  spreading: boolean,
): number {
  return spreading
    ? spreadStartPage(clamp(start + delta * 2, 1, pageCount))
    : clamp(start + delta, 1, pageCount);
}

/** Scroll mode keeps this much of the stage above a page's top when it counts as current. */
const scrollPageInset = 24;

/**
 * The page whose top sits nearest `scrollPageInset` below the top of the stage, or `fallback` when
 * no page is laid out.
 */
export function closestScrollPage(stageTop: number, pageTops: number[], fallback: number): number {
  let closestPage = fallback;
  let closestDistance = Number.POSITIVE_INFINITY;
  pageTops.forEach((top, index) => {
    const distance = Math.abs(top - stageTop - scrollPageInset);
    if (distance < closestDistance) {
      closestDistance = distance;
      closestPage = index + 1;
    }
  });
  return closestPage;
}

/** The page and half-turn state after moving `delta` half pages from `position`, if it moves. */
export function halfTurnTarget(
  position: number,
  delta: number,
  pageCount: number,
): { page: number; turned: boolean } | undefined {
  const next = clamp(position + delta, 0, lastHalfTurnPosition(pageCount));
  return next === position ? undefined : halfTurnFromPosition(next);
}
