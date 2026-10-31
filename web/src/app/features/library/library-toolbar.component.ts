import { Component, ElementRef, HostListener, inject, output, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideSearch } from '@lucide/angular';
import { LIBRARY_FILTERS, LibraryFilter, PieceSummary } from '../../core/models';
import { ChoiceMenuComponent } from './choice-menu.component';
import { libraryElement, libraryPieceRows, librarySuggestionButtons } from './library-dom';
import { LibraryStore } from './library.store';

/** The search and the Show menu. Sort stays on the piece-count line. */
@Component({
  selector: 'app-library-toolbar',
  imports: [FormsModule, LucideSearch, ChoiceMenuComponent],
  templateUrl: './library-toolbar.component.html',
  styleUrl: './library-toolbar.component.scss',
})
export class LibraryToolbarComponent {
  private readonly store = inject(LibraryStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly searchInput = viewChild<ElementRef<HTMLInputElement>>('searchInput');
  protected readonly libraryFilters = LIBRARY_FILTERS;
  protected readonly query = this.store.query;
  protected readonly filter = this.store.filter;
  readonly opened = output<PieceSummary>();

  protected chooseFilter(filter: LibraryFilter): void {
    void this.store.chooseFilter(filter);
  }

  /** "/" goes to the search from anywhere but a field or a dialog. */
  @HostListener('document:keydown', ['$event'])
  protected focusSearch(event: KeyboardEvent): void {
    if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.isContentEditable || target?.closest('input, textarea, select, dialog')) return;
    if (libraryElement(this.host.nativeElement).querySelector('dialog[open]')) return;
    event.preventDefault();
    this.searchInput()?.nativeElement.focus();
  }

  /**
   * Enter opens the first result, or the first similar match when nothing
   * matches exactly. Down moves to that same row. Escape clears the search.
   */
  protected searchKey(event: KeyboardEvent): void {
    if (event.isComposing) return;
    const root = libraryElement(this.host.nativeElement);
    if (event.key === 'Enter') {
      const first = this.store.listed()[0];
      if (this.store.searching() && first) {
        event.preventDefault();
        this.openPiece(first);
        return;
      }
      const suggestion = librarySuggestionButtons(root)[0];
      if (!suggestion) return;
      event.preventDefault();
      suggestion.click();
    } else if (event.key === 'ArrowDown') {
      const row = libraryPieceRows(root)[0] ?? librarySuggestionButtons(root)[0];
      if (!row) return;
      event.preventDefault();
      row.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      if (this.store.query()) this.clearSearch();
      else this.searchInput()?.nativeElement.blur();
    }
  }

  /** Empties the field at once too, so a letter typed straight after is not added to the old search. */
  private clearSearch(): void {
    this.store.query.set('');
    const input = this.searchInput()?.nativeElement;
    if (input) input.value = '';
  }

  private openPiece(piece: PieceSummary): void {
    this.opened.emit(piece);
  }
}
