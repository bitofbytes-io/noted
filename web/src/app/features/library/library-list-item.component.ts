import { Component, ElementRef, inject, input, output } from '@angular/core';
import {
  LucideChevronDown,
  LucideFileText,
  LucideHeadphones,
  LucideHeart,
  LucidePencil,
} from '@lucide/angular';
import { PIECE_STATUSES, PieceSummary } from '../../core/models';
import { libraryElement, libraryPieceRows, librarySearchInput } from './library-dom';
import { LibraryStore } from './library.store';
import { lastUsedText, playedText } from './library.utils';
import { MatchPartsPipe } from './match-parts.pipe';

/** One library row, used by the list and by Continue, with the same actions. */
@Component({
  selector: 'app-library-list-item',
  imports: [
    MatchPartsPipe,
    LucideChevronDown,
    LucideFileText,
    LucideHeadphones,
    LucideHeart,
    LucidePencil,
  ],
  templateUrl: './library-list-item.component.html',
  styleUrl: './library-list-item.component.scss',
})
export class LibraryListItemComponent {
  private readonly store = inject(LibraryStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  readonly piece = input.required<PieceSummary>();
  readonly continuing = input(false);
  readonly opened = output<PieceSummary>();
  readonly details = output<PieceSummary>();
  protected readonly query = this.store.query;
  protected readonly showPlayed = this.store.showPlayed;
  protected readonly pieceStatuses = PIECE_STATUSES;
  protected readonly playedText = playedText;
  protected readonly lastUsedText = lastUsedText;

  protected open(): void {
    this.opened.emit(this.piece());
  }

  protected openFromKeyboard(event: Event): void {
    if (event.target === event.currentTarget) this.open();
  }

  protected edit(event: Event): void {
    event.stopPropagation();
    this.details.emit(this.piece());
  }

  protected toggleFavorite(event: Event): void {
    void this.store.toggleFavorite(this.piece(), event);
  }

  protected changeStatus(control: HTMLSelectElement): void {
    void this.store.changeStatus(this.piece(), control);
  }

  /** Up and Down move between rows, Up from the first back to the search; Escape clears it. */
  protected rowKey(event: KeyboardEvent): void {
    const root = libraryElement(this.host.nativeElement);
    const rows = libraryPieceRows(root);
    const at = rows.indexOf(event.currentTarget as HTMLElement);
    let next: HTMLElement | undefined;
    if (event.key === 'ArrowDown') {
      next = rows[at + 1];
    } else if (event.key === 'ArrowUp') {
      next = at > 0 ? rows[at - 1] : (librarySearchInput(root) ?? undefined);
    } else if (event.key === 'Escape') {
      this.store.query.set('');
      const input = librarySearchInput(root);
      if (input) input.value = '';
      next = input ?? undefined;
    }
    if (!next) return;
    event.preventDefault();
    next.focus();
  }
}
