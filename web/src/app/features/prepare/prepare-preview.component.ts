import { Component, ElementRef, ViewChild, inject } from '@angular/core';
import { LucideMinus, LucidePlus } from '@lucide/angular';
import { PrepareEdgesComponent } from './prepare-edges.component';
import { PrepareStore } from './prepare.store';

/** The selected page: the Original/Adjusted toggle, zoom, the preview, and the edge editor. */
@Component({
  selector: 'div[appPreparePreview]',
  imports: [LucideMinus, LucidePlus, PrepareEdgesComponent],
  templateUrl: './prepare-preview.component.html',
  styleUrl: './prepare-preview.component.scss',
  host: { class: 'preview-column', '[class.editing-edges]': 'store.editingEdges' },
})
export class PreparePreviewComponent {
  protected readonly store = inject(PrepareStore);
  protected readonly Math = Math;

  @ViewChild('surface') set surface(surface: ElementRef<HTMLElement> | undefined) {
    this.store.views.surface = surface;
  }

  @ViewChild(PrepareEdgesComponent) set edgeEditor(editor: PrepareEdgesComponent | undefined) {
    this.store.views.edgeEditor = editor;
  }
}
