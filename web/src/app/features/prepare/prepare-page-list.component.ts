import { Component, ElementRef, ViewChild, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideChevronDown, LucideChevronUp } from '@lucide/angular';
import { hasPageAdjustments } from './prepare-processing';
import { PrepareStore } from './prepare.store';

/** The page rail: source range, thumbnails with selection, and reordering. */
@Component({
  selector: 'aside[appPreparePageList]',
  imports: [FormsModule, LucideChevronDown, LucideChevronUp],
  templateUrl: './prepare-page-list.component.html',
  styleUrl: './prepare-page-list.component.scss',
  host: { class: 'page-rail', 'aria-label': 'Score pages' },
})
export class PreparePageListComponent {
  protected readonly store = inject(PrepareStore);
  protected readonly hasPageAdjustments = hasPageAdjustments;

  @ViewChild('thumbRail') set thumbRail(rail: ElementRef<HTMLElement> | undefined) {
    this.store.views.thumbRail = rail;
  }

  thumbnailRailScrolled(event: Event): void {
    void this.store.renderThumbnails(event.currentTarget as HTMLElement);
  }
}
