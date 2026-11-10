import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImportAsset, ImportDraft, MAX_PREPARED_PAGES, PageEdit } from '../../core/models';
import { PrepareComponent } from './prepare.component';
import { PrepareStore } from './prepare.store';
import { PrepareApiMock, createPrepareFixture, draft } from './prepare-testing';
import { routes } from '../../app.routes';
import { canLeave } from '../../core/leave.guard';

describe('PrepareComponent', () => {
  let fixture: ComponentFixture<PrepareComponent>;
  let store: PrepareStore;
  let api: PrepareApiMock;
  let openWindow: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    ({ fixture, store, api, openWindow } = await createPrepareFixture());
  });

  afterEach(() => {
    openWindow.mockRestore();
  });

  it('offers details without a PDF only for a new piece, not when adding a PDF to one', async () => {
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const detailsButton = () =>
      [...fixture.nativeElement.querySelectorAll('.source-foot button')].find((button) =>
        button.textContent.includes('Add details without a PDF'),
      );
    store.draft.set(structuredClone(draft));
    store.step.set('source');
    fixture.detectChanges();
    expect(detailsButton()).toBeTruthy();

    store.draft.set({ ...structuredClone(draft), pieceId: 'piece-one' });
    fixture.detectChanges();
    expect(detailsButton()).toBeUndefined();
    await store.detailsWithoutPDF();
    expect(api.deleteImport).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('marks meaningful page edits and clears the marker after reset', () => {
    store.draft.set({
      ...structuredClone(draft),
      manifest: {
        version: 1,
        pages: [
          { id: 'page-1', sourceId: 'photo', page: 0, paperCleanupStrength: 0.4 },
          { id: 'page-2', sourceId: 'photo', page: 0 },
        ],
      },
    });
    store.step.set('pages');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.adjusted-marker')).toHaveLength(1);
    expect(
      fixture.nativeElement.querySelectorAll('.thumbnail button')[0].getAttribute('aria-label'),
    ).toBe('Preview page 1, adjusted');
    store.selected.set(0);
    store.edits.resetPage();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.adjusted-marker')).toHaveLength(0);
    store.edits.undo();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.adjusted-marker')).toHaveLength(1);
  });

  it('limits a chosen source range to the preparation page limit', () => {
    const source = { id: 'book', mime: 'application/pdf', pageCount: 40 } as ImportAsset;
    store.draft.set({ ...structuredClone(draft), sources: [source] });
    store.rangeSourceId = source.id;
    store.rangeText = `1-${MAX_PREPARED_PAGES + 1}`;
    store.edits.useRange();
    expect(store.error()).toContain(`at most ${MAX_PREPARED_PAGES} pages`);
    expect(store.draft()!.manifest.pages).toHaveLength(0);

    store.error.set('');
    store.rangeText = `3-${MAX_PREPARED_PAGES + 2}`;
    store.edits.useRange();
    expect(store.error()).toBe('');
    expect(store.draft()!.manifest.pages.map((page) => page.page)).toEqual(
      Array.from({ length: MAX_PREPARED_PAGES }, (_, index) => index + 2),
    );
  });

  it('flushes a debounced edit before the route is left', async () => {
    vi.useFakeTimers();
    try {
      const component = fixture.componentInstance;
      store.updateMetadata('composer', 'Changed before Back');
      expect(api.updateImport).not.toHaveBeenCalled();

      await expect(canLeave(component, null!, null!, null!)).resolves.toBe(true);
      expect(api.updateImport).toHaveBeenCalledTimes(1);
      expect(api.updateImport.mock.calls[0][0].metadata.composer).toBe('Changed before Back');

      store.ngOnDestroy();
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
    store.updateMetadata('notes', 'Unsaved');

    await expect(component.canLeave()).resolves.toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(store.error()).toBe('Offline.');
    await expect(component.canLeave()).resolves.toBe(true);
    expect(api.updateImport).toHaveBeenCalledTimes(2);
    confirm.mockRestore();
  });

  it('flushes and warns before unloading only with unsaved changes', () => {
    const clean = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);

    store.updateMetadata('notes', 'Unsaved');
    const dirty = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
    expect(api.updateImport).toHaveBeenCalledTimes(1);
  });

  it('makes each uploaded file its own Undo step', async () => {
    vi.spyOn(store.preview, 'render').mockResolvedValue();
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
    store.draft.set({
      ...structuredClone(draft),
      sources: [pdf('a')],
      manifest: { version: 1, pages: [structuredClone(pageA)] },
    });
    store.step.set('pages');
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
      return store.transfer.upload({ target: input } as unknown as Event, replace);
    };
    const pages = () => store.draft()!.manifest.pages;

    store.edits.rotate();
    await choose();
    expect(pages().map((page) => page.id)).toEqual(['page-a', 'page-b']);

    store.edits.undo();
    expect(pages()).toEqual([{ ...pageA, rotation: 90 }]);
    store.edits.undo();
    expect(pages()).toEqual([pageA]);

    uploadImport.mockImplementation(uploaded(pdf('c'), { id: 'page-c', sourceId: 'c', page: 0 }));
    store.selected.set(0);
    await choose(true);
    expect(pages()).toEqual([{ id: 'page-a', sourceId: 'c', page: 0 }]);
    store.edits.undo();
    expect(pages()).toEqual([pageA]);
  });

  it('discards a draft even when an in-flight autosave fails', async () => {
    const router = TestBed.inject(Router);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.spyOn(router, 'navigate').mockResolvedValue(true);

    let rejectSave!: (reason: Error) => void;
    const pendingSave = new Promise<void>((_resolve, reject) => {
      rejectSave = reject;
    });
    Reflect.set(store, 'pendingSave', pendingSave);

    const discard = store.discard();
    rejectSave(new Error('autosave failed'));
    await discard;

    expect(api.deleteImport).toHaveBeenCalledWith(draft.id);
    expect(router.navigate).toHaveBeenCalledWith(['/']);
    expect(store.error()).toBe('');
    expect(store.busy()).toBe(false);
  });
});
