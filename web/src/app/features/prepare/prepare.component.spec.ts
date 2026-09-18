import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { Observable, of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiService } from '../../core/api.service';
import { ImportAsset, ImportDraft, PageEdit, Piece } from '../../core/models';
import {
  PreparedPageCache,
  ProcessingStoppedError,
  ProcessingWorkerClient,
  preparedPhotoKey,
} from './prepare-processing';
import { PrepareComponent } from './prepare.component';

describe('PrepareComponent', () => {
  const draft: ImportDraft = {
    id: '1b06330f-cee6-4cbd-a9e5-bcbad612a997',
    pieceId: null,
    revision: 1,
    metadata: {
      title: 'Draft score',
      composer: '',
      favorite: false,
      sourceUrl: '',
      listeningUrl: '',
      notes: '',
    },
    manifest: { version: 1, pages: [] },
    initialManifest: { version: 1, pages: [] },
    sources: [],
    finalized: false,
    updatedAt: '2026-09-13T20:00:00Z',
    maxFileBytes: 50 * 1024 * 1024,
  };
  let fixture: ComponentFixture<PrepareComponent>;
  let api: {
    importDraft: ReturnType<typeof vi.fn>;
    deleteImport: ReturnType<typeof vi.fn>;
    updateImport: ReturnType<typeof vi.fn>;
    finalizeImport: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    api = {
      importDraft: vi.fn(() => of(structuredClone(draft))),
      deleteImport: vi.fn((): Observable<void> => of(undefined)),
      updateImport: vi.fn((value: ImportDraft) => of(value)),
      finalizeImport: vi.fn(() => of({ id: 'piece-one', pdf: {} } as unknown as Piece)),
    };
    await TestBed.configureTestingModule({
      imports: [PrepareComponent],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: {
              paramMap: convertToParamMap({ draftId: draft.id }),
              queryParamMap: convertToParamMap({}),
            },
          },
        },
        { provide: ApiService, useValue: api },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(PrepareComponent);
    fixture.detectChanges();
    await fixture.whenStable();
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

  async function openEdgeEditor() {
    const component = fixture.componentInstance;
    component.draft.set({
      ...structuredClone(draft),
      manifest: { version: 1, pages: [{ id: 'page', sourceId: 'pdf', page: 0 }] },
    });
    component.step.set('pages');
    component.preview.set('data:image/png;base64,');
    vi.spyOn(component, 'renderPreview').mockResolvedValue();
    fixture.detectChanges();
    const surface = component.surface!.nativeElement;
    surface.scrollIntoView = vi.fn();
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(fixture.nativeElement.querySelector('h1'));
    selection.addRange(range);
    expect(selection.isCollapsed).toBe(false);
    await component.beginEdges();
    fixture.detectChanges();
    return { component, surface, selection };
  }

  it('suppresses native preview interactions only while editing edges and clears selection', async () => {
    const { component, surface, selection } = await openEdgeEditor();
    expect(selection.isCollapsed).toBe(true);
    expect(fixture.nativeElement.querySelector('main').classList.contains('editing-edges')).toBe(
      true,
    );
    for (const type of ['contextmenu', 'dragstart']) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      surface.querySelector('img')!.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }

    component.cancelEdges();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('main').classList.contains('editing-edges')).toBe(
      false,
    );
    const event = new Event('contextmenu', { bubbles: true, cancelable: true });
    surface.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it.each(['pointerup', 'pointercancel', 'lostpointercapture', 'cancel', 'apply', 'destroy'])(
    'confines a corner drag to its pointer and removes handlers after %s',
    async (ending) => {
      const { component, surface, selection } = await openEdgeEditor();
      vi.spyOn(surface.querySelector('img')!, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        top: 0,
        width: 100,
        height: 100,
      } as DOMRect);
      const corner = surface.querySelector<HTMLButtonElement>('.corner')!;
      corner.setPointerCapture = vi.fn();
      corner.hasPointerCapture = vi.fn(() => true);
      corner.releasePointerCapture = vi.fn();
      const pointer = (type: string, pointerId = 1, x = 20) => {
        const event = new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: x,
          button: 0,
        });
        Object.defineProperties(event, {
          pointerId: { value: pointerId },
          isPrimary: { value: pointerId === 1 },
        });
        corner.dispatchEvent(event);
        return event;
      };
      const range = document.createRange();
      range.selectNodeContents(fixture.nativeElement.querySelector('h1'));
      selection.addRange(range);
      expect(pointer('pointerdown').defaultPrevented).toBe(true);
      expect(selection.isCollapsed).toBe(true);
      pointer('pointermove', 2);
      pointer('pointerup', 2);
      expect(component.edgePoints[0]).toEqual([0, 0]);
      expect(pointer('pointermove').defaultPrevented).toBe(true);
      expect(component.edgePoints[0]).toEqual([0.2, 0.2]);

      if (ending === 'cancel') component.cancelEdges();
      else if (ending === 'apply') {
        vi.spyOn(component, 'changed').mockImplementation(() => {});
        component.applyEdges();
      } else if (ending === 'destroy') fixture.destroy();
      else pointer(ending);
      const edges = structuredClone(component.edgePoints);
      expect(pointer('pointermove', 1, 30).defaultPrevented).toBe(false);
      expect(component.edgePoints).toEqual(edges);
      expect(corner.releasePointerCapture).toHaveBeenCalledWith(1);
    },
  );

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

  it('keeps the first three review thumbnails when a later page is selected', async () => {
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
    const pages = Array.from({ length: 10 }, (_, index) => ({
      id: `page-${index}`,
      sourceId: photo.id,
      page: 0,
    }));
    component.draft.set({
      ...structuredClone(draft),
      sources: [photo],
      manifest: { version: 1, pages },
    });
    component.selected.set(8);
    component.step.set('details');
    vi.spyOn(
      component as unknown as {
        thumbnailCanvas: (...args: unknown[]) => Promise<HTMLCanvasElement>;
      },
      'thumbnailCanvas',
    ).mockResolvedValue(document.createElement('canvas'));
    vi.spyOn(
      component as unknown as { canvasBlob: (...args: unknown[]) => Promise<Blob> },
      'canvasBlob',
    ).mockResolvedValue(new Blob());
    let nextURL = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:thumb-${++nextURL}`);
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    component.thumbs.set({ stale: 'blob:stale' });

    await component.renderThumbnails(undefined);

    expect(Object.keys(component.thumbs()).sort()).toEqual([
      'page-0',
      'page-1',
      'page-2',
      'page-8',
    ]);
    expect(revoke).toHaveBeenCalledWith('blob:stale');
  });

  it('selects actual rail thumbnails near the viewport without eagerly selecting all pages', () => {
    const component = fixture.componentInstance;
    const pages = Array.from({ length: 10 }, (_, index) => ({
      id: `page-${index}`,
      sourceId: 'photo',
      page: 0,
    }));
    const current = { ...structuredClone(draft), manifest: { version: 1 as const, pages } };
    component.draft.set(current);
    component.step.set('pages');
    component.selected.set(8);
    const container = document.createElement('div');
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      right: 100,
      top: 0,
      bottom: 300,
      width: 100,
      height: 300,
    } as DOMRect);
    for (const [index, page] of pages.entries()) {
      const element = document.createElement('div');
      element.dataset['thumbnailId'] = page.id;
      const top = index === 4 ? 20 : -500;
      vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        right: 100,
        top,
        bottom: top + 100,
        width: 100,
        height: 100,
      } as DOMRect);
      container.append(element);
    }

    const ids = Reflect.get(component, 'thumbnailIDs').call(
      component,
      current,
      container,
    ) as Set<string>;

    expect([...ids].sort()).toEqual(['page-4', 'page-8']);
  });

  it('serializes rapid thumbnail requests and advances to only the latest visible set', async () => {
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
    const pages = Array.from({ length: 4 }, (_, index) => ({
      id: `page-${index}`,
      sourceId: photo.id,
      page: 0,
    }));
    component.draft.set({
      ...structuredClone(draft),
      sources: [photo],
      manifest: { version: 1, pages },
    });
    component.step.set('pages');
    const rail = (visibleIndex: number) => {
      const container = document.createElement('div');
      vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        right: 100,
        top: 0,
        bottom: 100,
        width: 100,
        height: 100,
      } as DOMRect);
      for (const [index, page] of pages.entries()) {
        const element = document.createElement('div');
        element.dataset['thumbnailId'] = page.id;
        const top = index === visibleIndex ? 0 : -500;
        vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
          left: 0,
          right: 100,
          top,
          bottom: top + 100,
          width: 100,
          height: 100,
        } as DOMRect);
        container.append(element);
      }
      return container;
    };
    let releaseFirst!: () => void;
    const firstDecode = new Promise<void>((resolve) => (releaseFirst = resolve));
    let active = 0;
    let maximumActive = 0;
    let calls = 0;
    const decode = vi
      .spyOn(
        component as unknown as {
          thumbnailCanvas: (...args: unknown[]) => Promise<HTMLCanvasElement>;
        },
        'thumbnailCanvas',
      )
      .mockImplementation(async () => {
        const call = ++calls;
        active++;
        maximumActive = Math.max(maximumActive, active);
        try {
          if (call === 1) await firstDecode;
          return document.createElement('canvas');
        } finally {
          active--;
        }
      });
    vi.spyOn(
      component as unknown as { canvasBlob: (...args: unknown[]) => Promise<Blob> },
      'canvasBlob',
    ).mockResolvedValue(new Blob());
    const createURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:latest');
    createURL.mockClear();

    component.selected.set(0);
    const first = component.renderThumbnails(rail(0));
    const duplicate = component.renderThumbnails(rail(0));
    component.selected.set(3);
    const latest = component.renderThumbnails(rail(3));
    await Promise.resolve();

    expect(decode).toHaveBeenCalledOnce();
    expect(maximumActive).toBe(1);

    releaseFirst();
    await Promise.all([first, duplicate, latest]);

    expect(decode).toHaveBeenCalledTimes(2);
    expect(decode.mock.calls.map(([page]) => (page as PageEdit).id)).toEqual(['page-0', 'page-3']);
    expect(maximumActive).toBe(1);
    expect(createURL).toHaveBeenCalledOnce();
    expect(component.thumbs()).toEqual({ 'page-3': 'blob:latest' });
  });

  it.each([
    new ProcessingStoppedError('superseded'),
    new DOMException('The operation was aborted.', 'AbortError'),
  ])('does not report expected thumbnail cancellation errors', async (error) => {
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
    component.draft.set({
      ...structuredClone(draft),
      sources: [photo],
      manifest: { version: 1, pages: [{ id: 'page', sourceId: photo.id, page: 0 }] },
    });
    component.step.set('pages');
    vi.spyOn(
      component as unknown as {
        thumbnailCanvas: (...args: unknown[]) => Promise<HTMLCanvasElement>;
      },
      'thumbnailCanvas',
    ).mockRejectedValue(error);

    await component.renderThumbnails(undefined);

    expect(component.error()).toBe('');
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
    expect(navigate).not.toHaveBeenCalledWith(['/reader', expect.anything()]);
  });
});
