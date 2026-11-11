import { signal } from '@angular/core';
import type { PrepareStore } from './prepare.store';

/**
 * The page-edge editing session: the pending corners, whether the preview is ready
 * to drag on, and the Apply and Cancel endings. Applying records one Undo step.
 */
export class EdgeEditor {
  /** The edit mode while a session is open; null when no session is. */
  readonly handles = signal<'crop' | 'corners' | null>(null);
  readonly pending = signal<number[][]>([]);
  readonly ready = signal(false);
  readonly resetRequired = signal(false);
  private compareBefore = false;
  /** Identifies the open session, so a preview render that outlives it cannot ready a later one. */
  private session = 0;

  constructor(private readonly store: PrepareStore) {}

  async begin(): Promise<void> {
    const store = this.store,
      page = store.page;
    if (store.busy() || !page) return;
    const session = ++this.session;
    document.getSelection()?.removeAllRanges();
    store.edits.endGesture();
    this.compareBefore = store.preview.compare();
    store.zoom.set(1);
    this.ready.set(false);
    this.resetRequired.set(!!(page.corners?.length && page.crop?.length));
    const [l, t, r, b] = page.crop ?? [0, 0, 1, 1];
    this.pending.set(
      structuredClone(
        page.corners ?? [
          [l, t],
          [r, t],
          [r, b],
          [l, b],
        ],
      ),
    );
    this.handles.set(store.isPhoto ? 'corners' : 'crop');
    store.preview.compare.set(true);
    await store.preview.render();
    if (store.destroyed || session !== this.session) return;
    this.ready.set(true);
    store.views.surface?.nativeElement.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  resetPending(): void {
    this.pending.set([
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]);
    this.resetRequired.set(false);
  }

  cancel(): void {
    this.store.views.edgeEditor?.endDrag();
    this.close();
    this.store.preview.compare.set(this.compareBefore);
    void this.store.preview.render();
  }

  apply(): void {
    const store = this.store,
      p = store.page;
    if (store.busy() || !p || !this.ready() || this.resetRequired()) return;
    store.edits.remember();
    const points = structuredClone(this.pending());
    delete p.crop;
    delete p.corners;
    delete p.x;
    delete p.y;
    delete p.scale;
    delete p.outputWidth;
    delete p.outputHeight;
    if (store.isPhoto) p.corners = points;
    else p.crop = [points[0][0], points[0][1], points[2][0], points[2][1]];
    p.fitEdges = true;
    store.views.edgeEditor?.endDrag();
    this.close();
    store.preview.compare.set(false);
    store.edits.changed();
  }

  /** Ends the session without touching the page. */
  close(): void {
    ++this.session;
    this.handles.set(null);
    this.pending.set([]);
  }
}
