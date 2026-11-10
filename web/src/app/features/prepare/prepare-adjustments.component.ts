import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { marginLabels } from './prepare-page-edits';
import { PrepareStore } from './prepare.store';

/** The selected page's controls: edges, paper, straighten, margins, rotate, replace, remove. */
@Component({
  selector: 'aside[appPrepareAdjustments]',
  imports: [FormsModule],
  templateUrl: './prepare-adjustments.component.html',
  styleUrl: './prepare-adjustments.component.scss',
  host: { class: 'adjustments', 'aria-label': 'Page adjustments' },
})
export class PrepareAdjustmentsComponent {
  protected readonly store = inject(PrepareStore);
  protected readonly marginLabels = marginLabels;
}
