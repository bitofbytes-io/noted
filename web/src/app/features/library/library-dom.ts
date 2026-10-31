/** The library page that owns the search, the rows and the dialogs. */
export function libraryElement(from: HTMLElement): HTMLElement {
  const root = from.closest('.library-page');
  return root instanceof HTMLElement ? root : from;
}

/** The rows that open a piece, as shown: Continue first. */
export function libraryPieceRows(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('.results .piece-row[tabindex]')];
}

export function librarySearchInput(root: ParentNode): HTMLInputElement | null {
  return root.querySelector<HTMLInputElement>('.search input');
}

/** Similar matches shown when the search itself has no row to open. */
export function librarySuggestionButtons(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('.suggestions .suggestion')];
}
