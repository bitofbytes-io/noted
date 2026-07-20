import { MeasureAnchor } from '../../core/models';

export function positionForMeasure(anchors: MeasureAnchor[], measure: number): number | null {
  if (!anchors.length) return null;
  const ordered = [...anchors].sort((left, right) => left.measureNumber - right.measureNumber);
  const exact = ordered.find((anchor) => anchor.measureNumber === measure);
  if (exact) return exact.positionMs;
  const after = ordered.find((anchor) => anchor.measureNumber > measure);
  const before = [...ordered].reverse().find((anchor) => anchor.measureNumber < measure);
  if (before && after) {
    const ratio = (measure - before.measureNumber) / (after.measureNumber - before.measureNumber);
    return before.positionMs + ratio * (after.positionMs - before.positionMs);
  }
  const pair = before ? ordered.slice(-2) : ordered.slice(0, 2);
  if (pair.length < 2) return before?.positionMs ?? after?.positionMs ?? null;
  const measureDelta = pair[1].measureNumber - pair[0].measureNumber;
  if (measureDelta === 0) return pair[0].positionMs;
  const perMeasure = (pair[1].positionMs - pair[0].positionMs) / measureDelta;
  return Math.max(0, pair[0].positionMs + (measure - pair[0].measureNumber) * perMeasure);
}
