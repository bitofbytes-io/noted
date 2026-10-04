import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImportAsset, ImportDraft, MAX_PREPARED_PAGES, PageEdit } from '../../core/models';
import {
  PreparedPageCache,
  ProcessingStoppedError,
  ProcessingWorkerClient,
  preparedPhotoKey,
} from './prepare-processing';
import { PrepareComponent } from './prepare.component';
import { PrepareApiMock, createPrepareFixture, draft } from './prepare-testing';
import { routes } from '../../app.routes';
import { canLeave } from '../../core/leave.guard';

describe('PrepareComponent', () => {
  let fixture: ComponentFixture<PrepareComponent>;
  let api: PrepareApiMock;
  let openWindow: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    ({ fixture, api, openWindow } = await createPrepareFixture());
  });

  afterEach(() => {
    openWindow.mockRestore();
  });

  it('offers details without a PDF only for a new piece, not when adding a PDF to one', async () => {
    const component = fixture.componentInstance;
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const detailsButton = () =>
      [...fixture.nativeElement.querySelectorAll('.source-foot button')].find((button) =>
        button.textContent.includes('Add details without a PDF'),
      );
    component.draft.set(structuredClone(draft));
    component.step.set('source');
    fixture.detectChanges();
    expect(detailsButton()).toBeTruthy();

    component.draft.set({ ...structuredClone(draft), pieceId: 'piece-one' });
    fixture.detectChanges();
    expect(detailsButton()).toBeUndefined();
    await component.detailsWithoutPDF();
    expect(api.deleteImport).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('marks meaningful page edits and clears the marker after reset', () => {
    const component = fixture.componentInstance;
    component.draft.set({
      ...structuredClone(draft),
      manifest: {
        version: 1,
        pages: [
          { id: 'page-1', sourceId: 'photo', page: 0, paperCleanupStrength: 0.4 },
          { id: 'page-2', sourceId: 'photo', page: 0 },
        ],
      },
    });
    component.step.set('pages');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.adjusted-marker')).toHaveLength(1);
    expect(
      fixture.nativeElement.querySelectorAll('.thumbnail button')[0].getAttribute('aria-label'),
    ).toBe('Preview page 1, adjusted');
    component.selected.set(0);
    component.resetPage();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.adjusted-marker')).toHaveLength(0);
    component.undo();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.adjusted-marker')).toHaveLength(1);
  });

  it('limits a chosen source range to the preparation page limit', () => {
    const component = fixture.componentInstance;
    const source = { id: 'book', mime: 'application/pdf', pageCount: 40 } as ImportAsset;
    component.draft.set({ ...structuredClone(draft), sources: [source] });
    component.rangeSourceId = source.id;
    component.rangeText = `1-${MAX_PREPARED_PAGES + 1}`;
    component.useRange();
    expect(component.error()).toContain(`at most ${MAX_PREPARED_PAGES} pages`);
    expect(component.draft()!.manifest.pages).toHaveLength(0);

    component.error.set('');
    component.rangeText = `3-${MAX_PREPARED_PAGES + 2}`;
    component.useRange();
    expect(component.error()).toBe('');
    expect(component.draft()!.manifest.pages.map((page) => page.page)).toEqual(
      Array.from({ length: MAX_PREPARED_PAGES }, (_, index) => index + 2),
    );
  });

  it('flushes a debounced edit before the route is left', async () => {
    vi.useFakeTimers();
    try {
      const component = fixture.componentInstance;
      component.updateMetadata('composer', 'Changed before Back');
      expect(api.updateImport).not.toHaveBeenCalled();

      await expect(canLeave(component, null!, null!, null!)).resolves.toBe(true);
      expect(api.updateImport).toHaveBeenCalledTimes(1);
      expect(api.updateImport.mock.calls[0][0].metadata.composer).toBe('Changed before Back');

      component.ngOnDestroy();
      await vi.runAllTimersAsync();
      expect(api.updateImport).toHaveBeenCalledTimes(1);
      await expect(component.canLeave()).resolves.toBe(true);
      expect(routes.find((route) => route.path === 'prepare/:draftId')?.canDeactivate).toEqual([
        canLeave,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks before leaving when the departure save fails', async () => {
    const component = fixture.componentInstance;
    const confirm = vi
      .spyOn(window, 'confirm')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    api.updateImport.mockReturnValue(throwError(() => new Error('offline')));
    component.updateMetadata('notes', 'Unsaved');

    await expect(component.canLeave()).resolves.toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(component.error()).toBe('Offline.');
    await expect(component.canLeave()).resolves.toBe(true);
    expect(api.updateImport).toHaveBeenCalledTimes(2);
    confirm.mockRestore();
  });

  it('flushes and warns before unloading only with unsaved changes', () => {
    const component = fixture.componentInstance;
    const clean = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);

    component.updateMetadata('notes', 'Unsaved');
    const dirty = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
    expect(api.updateImport).toHaveBeenCalledTimes(1);
  });

  it('makes each uploaded file its own Undo step', async () => {
    const component = fixture.componentInstance;
    vi.spyOn(component, 'renderPreview').mockResolvedValue();
    const pdf = (id: string): ImportAsset => ({
      id,
      filename: `${id}.pdf`,
      mime: 'application/pdf',
      size: 1,
      checksum: id,
      pageCount: 1,
      width: 0,
      height: 0,
    });
    const pageA: PageEdit = { id: 'page-a', sourceId: 'a', page: 0 };
    component.draft.set({
      ...structuredClone(draft),
      sources: [pdf('a')],
      manifest: { version: 1, pages: [structuredClone(pageA)] },
    });
    component.step.set('pages');
    const uploaded = (source: ImportAsset, extra: PageEdit) => (current: ImportDraft) =>
      of({
        ...structuredClone(current),
        revision: current.revision + 1,
        sources: [...current.sources, source],
        manifest: { version: 1 as const, pages: [...current.manifest.pages, extra] },
      });
    const uploadImport = vi.fn(uploaded(pdf('b'), { id: 'page-b', sourceId: 'b', page: 0 }));
    Reflect.set(api, 'uploadImport', uploadImport);
    const choose = (replace = false) => {
      const input = document.createElement('input');
      Object.defineProperty(input, 'files', { value: [new File(['%PDF-'], 'b.pdf')] });
      return component.upload({ target: input } as unknown as Event, replace);
    };
    const pages = () => component.draft()!.manifest.pages;

    component.rotate();
    await choose();
    expect(pages().map((page) => page.id)).toEqual(['page-a', 'page-b']);

    component.undo();
    expect(pages()).toEqual([{ ...pageA, rotation: 90 }]);
    component.undo();
    expect(pages()).toEqual([pageA]);

    uploadImport.mockImplementation(uploaded(pdf('c'), { id: 'page-c', sourceId: 'c', page: 0 }));
    component.selected.set(0);
    await choose(true);
    expect(pages()).toEqual([{ id: 'page-a', sourceId: 'c', page: 0 }]);
    component.undo();
    expect(pages()).toEqual([pageA]);
  });

  it('discards a draft even when an in-flight autosave fails', async () => {
    const component = fixture.componentInstance;
    const router = TestBed.inject(Router);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.spyOn(router, 'navigate').mockResolvedValue(true);

    let rejectSave!: (reason: Error) => void;
    const pendingSave = new Promise<void>((_resolve, reject) => {
      rejectSave = reject;
    });
    Reflect.set(component, 'pendingSave', pendingSave);

    const discard = component.discard();
    rejectSave(new Error('autosave failed'));
    await discard;

    expect(api.deleteImport).toHaveBeenCalledWith(draft.id);
    expect(router.navigate).toHaveBeenCalledWith(['/']);
    expect(component.error()).toBe('');
    expect(component.busy()).toBe(false);
  });

  it('keeps a prepared photo through reorder and invalidates it after an edit', () => {
    const component = fixture.componentInstance;
    const photo: ImportAsset = {
      id: 'photo',
      filename: 'page.jpg',
      mime: 'image/jpeg',
      size: 100,
      checksum: 'photo-checksum',
      pageCount: 1,
      width: 1000,
      height: 1400,
    };
    const edited: PageEdit = {
      id: 'edited',
      sourceId: photo.id,
      page: 0,
      paperCleanupStrength: 0.5,
    };
    const other: PageEdit = { id: 'other', sourceId: photo.id, page: 0 };
    component.draft.set({
      ...structuredClone(draft),
      sources: [photo],
      manifest: { version: 1, pages: [edited, other] },
    });
    Reflect.get(component, 'reconcilePreparedKeys').call(component);
    const cache = Reflect.get(component, 'preparedPages') as PreparedPageCache;
    const key = preparedPhotoKey(photo, edited);
    cache.set(key, new ArrayBuffer(4));

    component.move(1);
    expect(cache.has(key)).toBe(true);

    component.changePaperStrength(60);
    expect(cache.has(key)).toBe(false);

    const editedKey = preparedPhotoKey(photo, component.page!);
    cache.set(editedKey, new ArrayBuffer(4));
    const replacement = { ...photo, id: 'replacement', checksum: 'replacement-checksum' };
    component.draft()!.sources.push(replacement);
    component.page!.sourceId = replacement.id;
    component.changed();
    expect(cache.has(editedKey)).toBe(false);
  });

  it('keeps a shared prepared key until no current page references it', () => {
    const component = fixture.componentInstance;
    const photo: ImportAsset = {
      id: 'photo',
      filename: 'page.jpg',
      mime: 'image/jpeg',
      size: 100,
      checksum: 'photo-checksum',
      pageCount: 1,
      width: 1000,
      height: 1400,
    };
    const first = { id: 'first', sourceId: photo.id, page: 0, paperCleanupStrength: 0.5 };
    const second = { ...first, id: 'second' };
    component.draft.set({
      ...structuredClone(draft),
      sources: [photo],
      manifest: { version: 1, pages: [first, second] },
    });
    Reflect.get(component, 'reconcilePreparedKeys').call(component);
    const cache = Reflect.get(component, 'preparedPages') as PreparedPageCache;
    const sharedKey = preparedPhotoKey(photo, first);
    cache.set(sharedKey, new ArrayBuffer(4));

    component.page!.paperCleanupStrength = 0.6;
    component.changed();
    expect(cache.has(sharedKey)).toBe(true);

    component.draft()!.manifest.pages.splice(1, 1);
    component.changed();
    expect(cache.has(sharedKey)).toBe(false);
  });

  it('prepares an unedited selected photo after 750ms idle', async () => {
    vi.useFakeTimers();
    try {
      const component = fixture.componentInstance;
      const photo: ImportAsset = {
        id: 'photo',
        filename: 'page.jpg',
        mime: 'image/jpeg',
        size: 100,
        checksum: 'photo-checksum',
        pageCount: 1,
        width: 1000,
        height: 1400,
      };
      const page = { id: 'plain', sourceId: photo.id, page: 0 };
      component.draft.set({
        ...structuredClone(draft),
        sources: [photo],
        manifest: { version: 1, pages: [page] },
      });
      Reflect.get(component, 'reconcilePreparedKeys').call(component);
      Reflect.set(component, 'lastEditOrSelectionAt', performance.now());
      const revision = Reflect.get(component, 'previewRevision') as number;
      const run = vi
        .spyOn(
          component as unknown as { runWorker: (...args: unknown[]) => Promise<object> },
          'runWorker',
        )
        .mockResolvedValue({ bytes: new ArrayBuffer(4) });

      Reflect.get(component, 'scheduleBackgroundPrepare').call(
        component,
        structuredClone(page),
        photo,
        revision,
      );
      await vi.advanceTimersByTimeAsync(749);
      expect(run).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(run).toHaveBeenCalledOnce();
      const cache = Reflect.get(component, 'preparedPages') as PreparedPageCache;
      expect(cache.has(preparedPhotoKey(photo, page))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not cache background work after the edit revision changes', async () => {
    vi.useFakeTimers();
    try {
      const component = fixture.componentInstance;
      const photo: ImportAsset = {
        id: 'photo',
        filename: 'page.jpg',
        mime: 'image/jpeg',
        size: 100,
        checksum: 'photo-checksum',
        pageCount: 1,
        width: 1000,
        height: 1400,
      };
      const page = { id: 'plain', sourceId: photo.id, page: 0 };
      component.draft.set({
        ...structuredClone(draft),
        sources: [photo],
        manifest: { version: 1, pages: [page] },
      });
      Reflect.get(component, 'reconcilePreparedKeys').call(component);
      Reflect.set(component, 'lastEditOrSelectionAt', performance.now());
      const revision = Reflect.get(component, 'previewRevision') as number;
      let finish!: (response: { bytes: ArrayBuffer }) => void;
      vi.spyOn(
        component as unknown as { runWorker: (...args: unknown[]) => Promise<object> },
        'runWorker',
      ).mockReturnValue(new Promise((resolve) => (finish = resolve)));
      const oldKey = preparedPhotoKey(photo, page);

      Reflect.get(component, 'scheduleBackgroundPrepare').call(
        component,
        structuredClone(page),
        photo,
        revision,
      );
      await vi.advanceTimersByTimeAsync(750);
      component.page!.paperCleanupStrength = 0.5;
      Reflect.set(component, 'previewRevision', revision + 1);
      finish({ bytes: new ArrayBuffer(4) });
      await Promise.resolve();
      await Promise.resolve();

      const cache = Reflect.get(component, 'preparedPages') as PreparedPageCache;
      expect(cache.has(oldKey)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aligns mixed cached and uncached pages for final assembly', async () => {
    const component = fixture.componentInstance;
    const router = TestBed.inject(Router);
    vi.spyOn(router, 'navigate').mockResolvedValue(true);
    const photo: ImportAsset = {
      id: 'photo',
      filename: 'page.jpg',
      mime: 'image/jpeg',
      size: 100,
      checksum: 'photo-checksum',
      pageCount: 1,
      width: 1000,
      height: 1400,
    };
    const edited: PageEdit = {
      id: 'edited',
      sourceId: photo.id,
      page: 0,
      paperCleanupStrength: 0.5,
    };
    const missPhoto = { ...photo, id: 'miss-photo', checksum: 'miss-checksum' };
    const miss: PageEdit = {
      id: 'miss',
      sourceId: missPhoto.id,
      page: 0,
      paperCleanupStrength: 0.25,
    };
    component.draft.set({
      ...structuredClone(draft),
      sources: [photo, missPhoto],
      manifest: { version: 1, pages: [miss, edited, { ...miss, id: 'miss-again' }] },
    });
    Reflect.get(component, 'reconcilePreparedKeys').call(component);
    const key = preparedPhotoKey(photo, edited);
    const cache = Reflect.get(component, 'preparedPages') as PreparedPageCache;
    cache.set(key, new ArrayBuffer(4));
    const client = Reflect.get(component, 'workerClient') as ProcessingWorkerClient;
    const run = vi.spyOn(client, 'run').mockResolvedValue({ bytes: new ArrayBuffer(10) });

    await component.save();

    const payload = run.mock.calls[0][0] as {
      prepared: { key: string; bytes: ArrayBuffer }[];
      preparedKeys: string[];
      manifest: { pages: PageEdit[] };
    };
    const missKey = preparedPhotoKey(missPhoto, miss);
    expect(payload.preparedKeys).toEqual([missKey, key, missKey]);
    expect(payload.manifest.pages.map((page) => page.id)).toEqual(['miss', 'edited', 'miss-again']);
    expect(payload.prepared).toHaveLength(1);
    expect(payload.prepared[0].key).toBe(key);
    expect(api.finalizeImport).toHaveBeenCalledOnce();
    expect(router.navigate).toHaveBeenCalledWith(['/reader', 'piece-one']);
  });

  it('locks metadata after flushing the latest revision for finalization', async () => {
    const component = fixture.componentInstance;
    const router = TestBed.inject(Router);
    vi.spyOn(router, 'navigate').mockResolvedValue(true);
    const source: ImportAsset = {
      id: 'pdf',
      filename: 'score.pdf',
      mime: 'application/pdf',
      size: 100,
      checksum: 'pdf-checksum',
      pageCount: 1,
      width: 612,
      height: 792,
    };
    component.draft.set({
      ...structuredClone(draft),
      sources: [source],
      manifest: { version: 1, pages: [{ id: 'page', sourceId: source.id, page: 0 }] },
    });
    component.step.set('details');
    api.updateImport.mockImplementationOnce((value: ImportDraft) =>
      of({ ...value, revision: 2, updatedAt: '2026-09-19T12:00:00Z' }),
    );
    component.updateMetadata('title', 'Latest persisted title');

    let finishBuild!: (response: { bytes: ArrayBuffer }) => void;
    const client = Reflect.get(component, 'workerClient') as ProcessingWorkerClient;
    const run = vi
      .spyOn(client, 'run')
      .mockReturnValue(new Promise((resolve) => (finishBuild = resolve)));

    const saving = component.save();
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    fixture.detectChanges();

    const title = fixture.nativeElement.querySelector('.details-form input') as HTMLInputElement;
    expect(title.disabled).toBe(true);
    component.updateMetadata('composer', 'Blocked edit');
    expect(component.draft()?.metadata.composer).toBe('');
    expect(api.updateImport).toHaveBeenCalledOnce();

    finishBuild({ bytes: new ArrayBuffer(10) });
    await saving;

    expect(api.finalizeImport).toHaveBeenCalledOnce();
    const finalizedDraft = api.finalizeImport.mock.calls[0][0] as ImportDraft;
    expect(finalizedDraft.revision).toBe(2);
    expect(finalizedDraft.metadata.title).toBe('Latest persisted title');
    expect(finalizedDraft.metadata.composer).toBe('');
    expect(component.finalizing()).toBe(false);
  });

  it('retains the draft when finalization fails', async () => {
    const component = fixture.componentInstance;
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    const source: ImportAsset = {
      id: 'pdf',
      filename: 'score.pdf',
      mime: 'application/pdf',
      size: 100,
      checksum: 'pdf-checksum',
      pageCount: 1,
      width: 612,
      height: 792,
    };
    component.draft.set({
      ...structuredClone(draft),
      sources: [source],
      manifest: { version: 1, pages: [{ id: 'page', sourceId: source.id, page: 0 }] },
    });
    const client = Reflect.get(component, 'workerClient') as ProcessingWorkerClient;
    vi.spyOn(client, 'run').mockResolvedValue({ bytes: new ArrayBuffer(10) });
    api.finalizeImport.mockReturnValueOnce(throwError(() => new Error('Finalization failed.')));

    await component.save();

    expect(component.error()).toBe('Finalization failed.');
    expect(component.draft()?.id).toBe(draft.id);
    expect(component.busy()).toBe(false);
    expect(component.finalizing()).toBe(false);
    expect(navigate).not.toHaveBeenCalledWith(['/reader', expect.anything()]);
  });

  it('keeps draft controls locked until cancelled final processing unwinds', async () => {
    const component = fixture.componentInstance;
    const source: ImportAsset = {
      id: 'pdf',
      filename: 'score.pdf',
      mime: 'application/pdf',
      size: 100,
      checksum: 'pdf-checksum',
      pageCount: 1,
      width: 612,
      height: 792,
    };
    component.draft.set({
      ...structuredClone(draft),
      sources: [source],
      manifest: { version: 1, pages: [{ id: 'page', sourceId: source.id, page: 0 }] },
    });
    let rejectBuild!: (reason: Error) => void;
    const client = Reflect.get(component, 'workerClient') as ProcessingWorkerClient;
    vi.spyOn(client, 'run').mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectBuild = reject;
      }),
    );
    vi.spyOn(client, 'cancel').mockImplementation(() =>
      rejectBuild(new ProcessingStoppedError('cancelled')),
    );

    const saving = component.save();
    await vi.waitFor(() => expect(component.cancellable()).toBe(true));
    component.cancel();

    expect(component.busy()).toBe(true);
    expect(component.finalizing()).toBe(true);
    await saving;
    expect(component.busy()).toBe(false);
    expect(component.finalizing()).toBe(false);
    expect(component.error()).toBe('Processing cancelled. Your draft and originals are retained.');
  });
});
