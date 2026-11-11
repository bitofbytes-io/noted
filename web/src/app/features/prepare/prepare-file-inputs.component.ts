import { Component, ElementRef, ViewChild, inject } from '@angular/core';
import { PrepareFileKind, PrepareStore } from './prepare.store';

/**
 * The hidden file inputs behind every "Choose" button on the page. The steps ask the
 * store to open one by kind, so a button never needs a reference to an input.
 */
@Component({
  selector: 'app-prepare-file-inputs',
  templateUrl: './prepare-file-inputs.component.html',
  styles: ':host { display: none; }',
})
export class PrepareFileInputsComponent {
  protected readonly store = inject(PrepareStore);
  @ViewChild('pdf') pdf?: ElementRef<HTMLInputElement>;
  @ViewChild('photos') photos?: ElementRef<HTMLInputElement>;
  @ViewChild('camera') camera?: ElementRef<HTMLInputElement>;
  @ViewChild('add') add?: ElementRef<HTMLInputElement>;
  @ViewChild('replace') replace?: ElementRef<HTMLInputElement>;

  constructor() {
    this.store.views.fileInputs = this;
  }

  open(kind: PrepareFileKind): void {
    this[kind]?.nativeElement.click();
  }
}
