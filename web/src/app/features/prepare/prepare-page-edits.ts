import { errorMessage } from '../../core/api.service';
import { EditManifest, MAX_PREPARED_PAGES } from '../../core/models';
import type { PrepareStore } from './prepare.store';

export const marginLabels = ['Top', 'Right', 'Bottom', 'Left'];

/** The Pages step's edits to the draft manifest, with the Undo history they share. */
export class PageEdits {
  private history: EditManifest[] = [];
  private gesture = false;

  constructor(private readonly store: PrepareStore) {}

  /** Page edits are locked while another operation runs or the edge editor is open. */
  private get locked(): boolean {
    return this.store.busy() || this.store.editingEdges;
  }

  marginMM(index: number) {
    return Math.round((((this.store.page?.margins?.[index] || 0) * 25.4) / 72) * 10) / 10;
  }

  get paperStrength() {
    const page = this.store.page;
    return Math.round((page?.paperCleanupStrength ?? (page?.paperCleanup ? 1 : 0)) * 100);
  }

  remember() {
    const d = this.store.draft();
    if (d) {
      this.history.push(structuredClone(d.manifest));
      if (this.history.length > 30) this.history.shift();
    }
  }

  startGesture() {
    if (!this.gesture) {
      this.remember();
      this.gesture = true;
    }
  }

  endGesture() {
    this.gesture = false;
  }

  /** Every manifest edit ends here: it refreshes the draft, saves it and redraws the preview. */
  changed() {
    const store = this.store;
    store.draft.update((d) =>
      d ? { ...d, manifest: { ...d.manifest, pages: [...d.manifest.pages] } } : null,
    );
    store.mark();
    store.preview.schedule();
  }

  change(key: 'angle' | 'rotation', value: number, input?: HTMLInputElement) {
    const page = this.store.page;
    if (!page || !Number.isFinite(value) || this.locked) return;
    const requested = value;
    if (key === 'angle') value = Math.max(-10, Math.min(10, value));
    // ngModel may already hold the same clamped model value after another
    // out-of-range entry, so synchronize the native number field as well.
    if (input && value !== requested) input.value = String(value);
    this.startGesture();
    page[key] = value;
    if (!page.outputWidth && !page.x && !page.y && (!page.scale || page.scale === 1))
      page.fitEdges = true;
    this.changed();
  }

  changeMargin(index: number, mm: number) {
    const page = this.store.page;
    if (!page || !Number.isFinite(mm) || this.locked) return;
    this.startGesture();
    const margins = [...(page.margins || [0, 0, 0, 0])];
    margins[index] = (Math.max(0, Math.min(50, mm)) * 72) / 25.4;
    page.margins = margins;
    this.changed();
  }

  changePaperStrength(value: number) {
    const page = this.store.page;
    if (!page || !this.store.isPhoto || this.locked) return;
    this.startGesture();
    page.paperCleanupStrength = Math.max(0, Math.min(100, value)) / 100;
    this.changed();
  }

  rotate() {
    const page = this.store.page;
    if (!page || this.locked) return;
    this.remember();
    page.rotation = ((page.rotation || 0) + 90) % 360;
    this.changed();
    this.endGesture();
  }

  undo() {
    const store = this.store;
    if (store.busy()) return;
    this.endGesture();
    const m = this.history.pop();
    if (m) {
      store.draft.update((d) => (d ? { ...d, manifest: m } : null));
      store.selected.set(Math.min(store.selected(), m.pages.length - 1));
      store.preview.reconcileKeys();
      store.mark();
      void store.preview.render();
      void store.renderThumbnails();
    }
  }

  resetPage() {
    const store = this.store;
    if (!store.page || store.busy()) return;
    this.remember();
    const { id, sourceId, page } = store.page;
    store.draft()!.manifest.pages[store.selected()] = { id, sourceId, page };
    store.edges.handles.set(null);
    this.changed();
  }

  resetAll() {
    const d = this.store.draft();
    if (!d || this.store.busy()) return;
    this.remember();
    d.manifest = {
      version: 1,
      pages: d.manifest.pages.map(({ id, sourceId, page }) => ({ id, sourceId, page })),
    };
    this.changed();
  }

  choose(index: number) {
    const store = this.store;
    if (this.locked) return;
    this.endGesture();
    const nextPage = store.draft()?.manifest.pages[index];
    const nextSource = store.draft()?.sources.find((source) => source.id === nextPage?.sourceId);
    store.preview.renderer.keepDisplayRasterFor(`${nextSource?.checksum}:${nextPage?.page}`);
    store.preview.lastEditOrSelectionAt = performance.now();
    store.selected.set(index);
    store.edges.handles.set(null);
    void store.renderThumbnails();
    void store.preview.render();
  }

  move(delta: number) {
    const store = this.store,
      pages = store.draft()?.manifest.pages,
      index = store.selected();
    if (store.busy() || !pages || index + delta < 0 || index + delta >= pages.length) return;
    this.remember();
    [pages[index], pages[index + delta]] = [pages[index + delta], pages[index]];
    store.selected.set(index + delta);
    this.changed();
  }

  remove() {
    const store = this.store,
      d = store.draft();
    if (!d || !store.page || store.busy()) return;
    this.remember();
    const [removed] = d.manifest.pages.splice(store.selected(), 1);
    if (store.selectedIDs().has(removed.id)) {
      const ids = new Set(store.selectedIDs());
      ids.delete(removed.id);
      store.selectedIDs.set(ids);
    }
    store.selected.set(Math.max(0, Math.min(store.selected(), d.manifest.pages.length - 1)));
    this.changed();
  }

  toggle(id: string) {
    if (this.store.busy()) return;
    const set = new Set(this.store.selectedIDs());
    if (set.has(id)) set.delete(id);
    else set.add(id);
    this.store.selectedIDs.set(set);
  }

  keepSelected() {
    const store = this.store,
      d = store.draft(),
      ids = store.selectedIDs();
    if (!d || !ids.size || store.busy()) return;
    this.remember();
    d.manifest.pages = d.manifest.pages.filter((p) => ids.has(p.id));
    store.selected.set(0);
    this.changed();
  }

  /** Replaces the manifest with the typed source page range, such as "1-4, 7". */
  useRange() {
    const store = this.store,
      d = store.draft();
    if (!d || this.locked) return;
    const source = d.sources.find((a) => a.id === store.rangeSourceId);
    if (!source) return;
    try {
      const pages: number[] = [];
      for (const part of store.rangeText.split(',')) {
        const match = part.trim().match(/^(\d+)(?:-(\d+))?$/);
        if (!match) throw Error('Enter page numbers such as 1-4, 7.');
        const first = +match[1],
          last = +(match[2] || match[1]);
        if (
          first < 1 ||
          last < first ||
          last > source.pageCount ||
          last - first >= MAX_PREPARED_PAGES
        )
          throw Error(`Choose a valid source range of at most ${MAX_PREPARED_PAGES} pages.`);
        for (let n = first; n <= last; n++) pages.push(n - 1);
      }
      if (!pages.length || pages.length > MAX_PREPARED_PAGES)
        throw Error(`Choose 1 to ${MAX_PREPARED_PAGES} pages.`);
      this.remember();
      d.manifest = {
        version: 1,
        pages: pages.map((page) => ({ id: crypto.randomUUID(), sourceId: source.id, page })),
      };
      store.selected.set(0);
      // The replaced pages have new IDs, so no page stays checked.
      store.selectedIDs.set(new Set());
      this.changed();
      void store.renderThumbnails();
    } catch (e) {
      store.error.set(errorMessage(e));
    }
  }
}
