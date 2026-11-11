import { Component, ElementRef, HostListener, ViewChild, forwardRef, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LeaveGuarded } from '../../core/leave.guard';
import { PrepareAdjustmentsComponent } from './prepare-adjustments.component';
import { PrepareDetailsComponent } from './prepare-details.component';
import { PrepareFileInputsComponent } from './prepare-file-inputs.component';
import { ImslpPanelHost } from './prepare-imslp';
import { PreparePageListComponent } from './prepare-page-list.component';
import { PreparePreviewComponent } from './prepare-preview.component';
import { PrepareStep } from './prepare-rendering';
import { PrepareSourceComponent } from './prepare-source.component';
import { PrepareStore } from './prepare.store';

/**
 * The Prepare page. It frames the draft (heading, notices, footer, completion) and
 * picks the step to show; the steps and their state live in the child components
 * and the `PrepareStore` they share.
 */
@Component({
  selector: 'app-prepare',
  imports: [
    RouterLink,
    PrepareAdjustmentsComponent,
    PrepareDetailsComponent,
    PrepareFileInputsComponent,
    PreparePageListComponent,
    PreparePreviewComponent,
    PrepareSourceComponent,
  ],
  templateUrl: './prepare.component.html',
  styleUrl: './prepare.component.scss',
  providers: [
    PrepareStore,
    { provide: ImslpPanelHost, useExisting: forwardRef(() => PrepareStore) },
  ],
})
export class PrepareComponent implements LeaveGuarded {
  protected readonly store = inject(PrepareStore);
  protected readonly steps: { id: PrepareStep; label: string }[] = [
    { id: 'source', label: 'Source' },
    { id: 'pages', label: 'Pages' },
    { id: 'details', label: 'Details' },
  ];

  @ViewChild('completionHeading') set completionHeading(
    heading: ElementRef<HTMLElement> | undefined,
  ) {
    this.store.views.completionHeading = heading;
  }

  canLeave(): Promise<boolean> {
    return this.store.canLeave();
  }

  @HostListener('window:beforeunload', ['$event'])
  warnBeforeUnload(event: BeforeUnloadEvent) {
    this.store.warnBeforeUnload(event);
  }
}
