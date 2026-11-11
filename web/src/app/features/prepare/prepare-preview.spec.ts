import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { MockInstance, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImportAsset, PageEdit } from '../../core/models';
import { preparedPhotoKey } from './prepare-processing';
import { PrepareComponent } from './prepare.component';
import { PrepareStore } from './prepare.store';
import { createPrepareFixture, draft, photo } from './prepare-testing';

interface FinalAssemblyPayload {
  kind: string;
  manifest: { pages: PageEdit[] };
  prepared: { key: string; bytes: ArrayBuffer }[];
  preparedKeys: string[];
}

describe('PreparePreview prepared pages', () => {
  let fixture: ComponentFixture<PrepareComponent>;
  let store: PrepareStore;
  let openWindow: ReturnType<typeof vi.spyOn>;
  let run: MockInstance<PrepareStore['preview']['runWorker']>;
  let background: { bytes: ArrayBuffer }[];
  let holdBackground: Promise<void> | null;

  const plain: PageEdit = { id: 'plain', sourceId: photo.id, page: 0 };
  const edited: PageEdit = { id: 'edited', sourceId: photo.id, page: 0, paperCleanupStrength: 0.5 };

  beforeEach(async () => {
    ({ fixture, store, openWindow } = await createPrepareFixture());
    vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    vi.useFakeTimers();
    background = [];
    holdBackground = null;
    // The photo is not fetched; only the worker requests and the bytes they return matter.
    vi.spyOn(store.preview.renderer, 'selectedDisplayRaster').mockResolvedValue({
      key: 'raster',
      blob: new Blob(),
      url: 'blob:raster',
      width: 1000,
      height: 1400,
    });
    run = vi.spyOn(store.preview, 'runWorker').mockImplementation(async (payload) => {
      if ('prepared' in payload) return { bytes: new ArrayBuffer(10) };
      const response = { bytes: new ArrayBuffer(4) };
      background.push(response);
      await holdBackground;
      return response;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    openWindow.mockRestore();
  });

  const showPages = (pages: PageEdit[], source: ImportAsset = photo) => {
    store.draft.set({
      ...structuredClone(draft),
      sources: [source],
      manifest: { version: 1, pages },
    });
    store.preview.reconcileKeys();
  };

  /** Selects a page and shows it unprocessed, as the preview does, then waits out the idle delay. */
  const selectAndIdle = async (index: number, idle = 750) => {
    store.selected.set(index);
    store.preview.compare.set(true);
    store.preview.lastEditOrSelectionAt = performance.now();
    await store.preview.render();
    await vi.advanceTimersByTimeAsync(idle);
  };

  const requests = () =>
    run.mock.calls.map(([payload]) => payload as Partial<FinalAssemblyPayload>);
  const backgroundRequests = () => requests().filter((payload) => !payload.prepared);

  /** Saves the draft and returns what final assembly was handed. */
  const finalAssembly = async () => {
    await store.transfer.save();
    return requests().find((payload) => payload.prepared) as FinalAssemblyPayload;
  };

  it('keeps a prepared photo through reorder', async () => {
    showPages([edited, { id: 'other', sourceId: photo.id, page: 0 }]);
    await selectAndIdle(0);
    expect(backgroundRequests()).toHaveLength(1);

    store.edits.move(1);
    const assembly = await finalAssembly();

    expect(assembly.manifest.pages.map((page) => page.id)).toEqual(['other', 'edited']);
    expect(assembly.prepared.map((item) => item.key)).toEqual([preparedPhotoKey(photo, edited)]);
    expect(assembly.prepared[0].bytes).toBe(background[0].bytes);
  });

  it('invalidates a prepared photo after an edit, even if the edit is undone by hand', async () => {
    showPages([structuredClone(edited)]);
    await selectAndIdle(0);
    expect(backgroundRequests()).toHaveLength(1);

    store.edits.changePaperStrength(60);
    store.edits.changePaperStrength(50);
    const assembly = await finalAssembly();

    expect(assembly.preparedKeys).toEqual([preparedPhotoKey(photo, edited)]);
    expect(assembly.prepared).toEqual([]);
  });

  it('invalidates a prepared photo after its source is replaced', async () => {
    showPages([structuredClone(edited)]);
    await selectAndIdle(0);
    const replacement = { ...photo, id: 'replacement', checksum: 'replacement-checksum' };
    store.draft()!.sources.push(replacement);

    store.page!.sourceId = replacement.id;
    store.edits.changed();
    store.page!.sourceId = photo.id;
    store.edits.changed();
    const assembly = await finalAssembly();

    expect(assembly.preparedKeys).toEqual([preparedPhotoKey(photo, edited)]);
    expect(assembly.prepared).toEqual([]);
  });

  describe('a key shared by two pages', () => {
    const first = { ...edited, id: 'first' };
    const second = { ...edited, id: 'second' };

    it('stays prepared while another page still references it', async () => {
      showPages([structuredClone(first), structuredClone(second)]);
      await selectAndIdle(0);

      store.edits.changePaperStrength(60);
      const assembly = await finalAssembly();

      const sharedKey = preparedPhotoKey(photo, second);
      expect(assembly.preparedKeys[1]).toBe(sharedKey);
      expect(assembly.prepared.map((item) => item.key)).toEqual([sharedKey]);
    });

    it('is dropped once no page references it', async () => {
      showPages([structuredClone(first), structuredClone(second)]);
      await selectAndIdle(0);

      store.edits.changePaperStrength(60);
      store.selected.set(1);
      store.edits.remove();
      store.selected.set(0);
      store.edits.changePaperStrength(50);
      const assembly = await finalAssembly();

      expect(assembly.preparedKeys).toEqual([preparedPhotoKey(photo, first)]);
      expect(assembly.prepared).toEqual([]);
    });
  });

  describe('background preparation', () => {
    beforeEach(() => showPages([structuredClone(plain)]));

    it('prepares an unedited selected photo after 750ms idle', async () => {
      await selectAndIdle(0, 749);
      expect(run).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(backgroundRequests()).toHaveLength(1);
      expect(backgroundRequests()[0].manifest?.pages).toEqual([plain]);
      const assembly = await finalAssembly();
      expect(assembly.prepared.map((item) => item.key)).toEqual([preparedPhotoKey(photo, plain)]);
      expect(assembly.prepared[0].bytes).toBe(background[0].bytes);
    });

    it('does not cache a result that finishes after a newer revision', async () => {
      let finish!: () => void;
      holdBackground = new Promise((resolve) => (finish = resolve));
      await selectAndIdle(0);
      expect(backgroundRequests()).toHaveLength(1);

      // The page and its prepared key are unchanged; only the revision moves on.
      store.preview.invalidate();
      finish();
      await vi.advanceTimersByTimeAsync(0);

      const assembly = await finalAssembly();
      expect(assembly.preparedKeys).toEqual([preparedPhotoKey(photo, plain)]);
      expect(assembly.prepared).toEqual([]);
    });
  });
});
