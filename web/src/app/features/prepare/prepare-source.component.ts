import { Component, inject } from '@angular/core';
import { MAX_PREPARED_PAGES } from '../../core/models';
import { PrepareImslpComponent } from './prepare-imslp.component';
import { PrepareStore } from './prepare.store';

/** The Source step: choose where the score comes from, or hand off to the IMSLP panel. */
@Component({
  selector: 'app-prepare-source',
  imports: [PrepareImslpComponent],
  templateUrl: './prepare-source.component.html',
  styleUrl: './prepare-source.component.scss',
})
export class PrepareSourceComponent {
  protected readonly store = inject(PrepareStore);
  protected readonly maxPreparedPages = MAX_PREPARED_PAGES;
}
