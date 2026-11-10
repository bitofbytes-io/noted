import { ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImportAsset, PageEdit } from '../../core/models';
import { PreparedPageCache, preparedPhotoKey } from './prepare-processing';
import { PrepareComponent } from './prepare.component';
import { PrepareStore } from './prepare.store';
import { createPrepareFixture, draft, photo } from './prepare-testing';

describe('PreparePreview prepared pages', () => {
  let fixture: ComponentFixture<PrepareComponent>;
  let store: PrepareStore;
  let openWindow: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    ({ fixture, store, openWindow } = await createPrepareFixture());
  });

  afterEach(() => {
    openWindow.mockRestore();
  });

  const cache = () => Reflect.get(store.preview, 'preparedPages') as PreparedPageCache;
  const showPages = (pages: PageEdit[], source: ImportAsset = photo) => {
    store.draft.set({
      ...structuredClone(draft),
      sources: [source],
      manifest: { version: 1, pages },
    });
    store.preview.reconcileKeys();
  };

  it('keeps a prepared photo through reorder and invalidates it after an edit', () => {
    const edited: PageEdit = {
      id: 'edited',
      sourceId: photo.id,
      page: 0,
      paperCleanupStrength: 0.5,
    };
    showPages([edited, { id: 'other', sourceId: photo.id, page: 0 }]);
    const key = preparedPhotoKey(photo, edited);
    cache().set(key, new ArrayBuffer(4));

    store.edits.move(1);
    expect(cache().has(key)).toBe(true);

    store.edits.changePaperStrength(60);
    expect(cache().has(key)).toBe(false);

    const editedKey = preparedPhotoKey(photo, store.page!);
    cache().set(editedKey, new ArrayBuffer(4));
    const replacement = { ...photo, id: 'replacement', checksum: 'replacement-checksum' };
    store.draft()!.sources.push(replacement);
    store.page!.sourceId = replacement.id;
    store.edits.changed();
    expect(cache().has(editedKey)).toBe(false);
  });

  it('keeps a shared prepared key until no current page references it', () => {
    const first = { id: 'first', sourceId: photo.id, page: 0, paperCleanupStrength: 0.5 };
    showPages([first, { ...first, id: 'second' }]);
    const sharedKey = preparedPhotoKey(photo, first);
    cache().set(sharedKey, new ArrayBuffer(4));

    store.page!.paperCleanupStrength = 0.6;
    store.edits.changed();
    expect(cache().has(sharedKey)).toBe(true);

    store.draft()!.manifest.pages.splice(1, 1);
    store.edits.changed();
    expect(cache().has(sharedKey)).toBe(false);
  });

  describe('background preparation', () => {
    const plain: PageEdit = { id: 'plain', sourceId: photo.id, page: 0 };
    const schedule = (revision: number) =>
      Reflect.get(store.preview, 'scheduleBackgroundPrepare').call(
        store.preview,
        structuredClone(plain),
        photo,
        revision,
      );

    beforeEach(() => {
      vi.useFakeTimers();
      showPages([plain]);
      store.preview.lastEditOrSelectionAt = performance.now();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('prepares an unedited selected photo after 750ms idle', async () => {
      const revision = Reflect.get(store.preview, 'previewRevision') as number;
      const run = vi
        .spyOn(store.preview, 'runWorker')
        .mockResolvedValue({ bytes: new ArrayBuffer(4) });

      schedule(revision);
      await vi.advanceTimersByTimeAsync(749);
      expect(run).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(run).toHaveBeenCalledOnce();
      expect(cache().has(preparedPhotoKey(photo, plain))).toBe(true);
    });

    it('does not cache background work after the edit revision changes', async () => {
      const revision = Reflect.get(store.preview, 'previewRevision') as number;
      let finish!: (response: { bytes: ArrayBuffer }) => void;
      vi.spyOn(store.preview, 'runWorker').mockReturnValue(
        new Promise((resolve) => (finish = resolve)),
      );
      const oldKey = preparedPhotoKey(photo, plain);

      schedule(revision);
      await vi.advanceTimersByTimeAsync(750);
      store.page!.paperCleanupStrength = 0.5;
      Reflect.set(store.preview, 'previewRevision', revision + 1);
      finish({ bytes: new ArrayBuffer(4) });
      await Promise.resolve();
      await Promise.resolve();

      expect(cache().has(oldKey)).toBe(false);
    });
  });
});
