import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { PrepareStore } from './prepare.store';

/** The Details step: the piece's metadata form and a last look at the first pages. */
@Component({
  selector: 'section[appPrepareDetails]',
  imports: [FormsModule],
  templateUrl: './prepare-details.component.html',
  styleUrl: './prepare-details.component.scss',
  host: { class: 'details' },
})
export class PrepareDetailsComponent {
  protected readonly store = inject(PrepareStore);
}
