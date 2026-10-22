import { Params } from '@angular/router';

const KEY = 'noted.libraryQuery';

/** Keeps the library's last search, filter and sort for this tab, for a reader opened without it. */
export function rememberLibraryParams(params: Params): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(params));
  } catch {
    // Storage can be unavailable; the reader then returns to the plain library.
  }
}

/** Drops the saved library address. Signing out must not leave it for the next account. */
export function clearLibraryParams(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Storage can be unavailable; there is then nothing left to forget.
  }
}

/** The library's last address in this tab; the library itself ignores anything it does not know. */
export function rememberedLibraryParams(): Params {
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(KEY) ?? '{}');
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
    return Object.fromEntries(
      Object.entries(saved).filter(([, value]) => typeof value === 'string'),
    );
  } catch {
    return {};
  }
}
