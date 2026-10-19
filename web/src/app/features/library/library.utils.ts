export function listeningUrlError(value: string): string {
  const candidate = value.trim();
  if (!candidate) return '';
  if (candidate.length > 2000) return 'listening URL must be at most 2000 characters';
  try {
    const parsed = new URL(candidate);
    if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname) return '';
  } catch {
    // The shared validation message below is more useful than the browser's parser error.
  }
  return 'listening URL must be an http or https URL';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "1 Oct 2026" in the viewer's time zone: the account dialog's date style. */
export function formatDay(iso: string): string {
  const date = new Date(iso);
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

/** When a shortcut token was last used, by calendar day in the viewer's time zone. */
export function lastUsedText(iso: string | null, now = new Date()): string {
  if (!iso) return 'never';
  const used = new Date(iso);
  const day = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((day(now) - day(used)) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return formatDay(iso);
}

/** "Played yesterday": when the reader last saved the piece, in the shortcut's day wording. */
export function playedText(lastPlayedAt: string | null, now = new Date()): string {
  return lastPlayedAt ? `Played ${lastUsedText(lastPlayedAt, now)}` : 'Not played yet';
}

/** Continue offers a piece only if it was played this recently. */
export const CONTINUE_WITHIN_DAYS = 14;

/** The most recently played piece with a PDF, if it was played in the last two weeks. */
export function continuePiece<T extends { pdf: unknown; lastPlayedAt: string | null }>(
  pieces: readonly T[],
  now = new Date(),
): T | null {
  const since = now.getTime() - CONTINUE_WITHIN_DAYS * 86_400_000;
  let latest: T | null = null;
  let latestAt = -Infinity;
  for (const piece of pieces) {
    const at = piece.pdf && piece.lastPlayedAt ? Date.parse(piece.lastPlayedAt) : NaN;
    if (at >= since && at > latestAt) {
      latest = piece;
      latestAt = at;
    }
  }
  return latest;
}
