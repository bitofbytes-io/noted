import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { ImportAsset, ImportDraft, PageEdit } from '../../core/models';
import { ProcessingStoppedError } from './prepare-processing';
import { PageRenderer, PrepareStep } from './prepare-rendering';
import { draft } from './prepare-testing';

describe('PageRenderer', () => {
  /** A renderer over its own Prepare view, so each test sets the draft, step and selection. */
  const setup = () => {
    const view = {
      draft: signal<ImportDraft | null>(structuredClone(draft)),
      step: signal<PrepareStep>('source'),
      selected: signal(0),
      error: signal(''),
    };
    return { view, renderer: new PageRenderer(view) };
  };

  it('keeps the first three review thumbnails when a later page is selected', async () => {
    const { view, renderer } = setup();
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
    view.draft.set({
      ...structuredClone(draft),
      sources: [photo],
      manifest: { version: 1, pages },
    });
    view.selected.set(8);
    view.step.set('details');
    vi.spyOn(
      renderer as unknown as {
        thumbnailCanvas: (...args: unknown[]) => Promise<HTMLCanvasElement>;
      },
      'thumbnailCanvas',
    ).mockResolvedValue(document.createElement('canvas'));
    vi.spyOn(
      renderer as unknown as { canvasBlob: (...args: unknown[]) => Promise<Blob> },
      'canvasBlob',
    ).mockResolvedValue(new Blob());
    let nextURL = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:thumb-${++nextURL}`);
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    renderer.thumbs.set({ stale: 'blob:stale' });

    await renderer.renderThumbnails(undefined);

    expect(Object.keys(renderer.thumbs()).sort()).toEqual(['page-0', 'page-1', 'page-2', 'page-8']);
    expect(revoke).toHaveBeenCalledWith('blob:stale');
  });

  it('selects actual rail thumbnails near the viewport without eagerly selecting all pages', () => {
    const { view, renderer } = setup();
    const pages = Array.from({ length: 10 }, (_, index) => ({
      id: `page-${index}`,
      sourceId: 'photo',
      page: 0,
    }));
    const current = { ...structuredClone(draft), manifest: { version: 1 as const, pages } };
    view.draft.set(current);
    view.step.set('pages');
    view.selected.set(8);
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

    const ids = Reflect.get(renderer, 'thumbnailIDs').call(
      renderer,
      current,
      container,
    ) as Set<string>;

    expect([...ids].sort()).toEqual(['page-4', 'page-8']);
  });

  it('serializes rapid thumbnail requests and advances to only the latest visible set', async () => {
    const { view, renderer } = setup();
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
    view.draft.set({
      ...structuredClone(draft),
      sources: [photo],
      manifest: { version: 1, pages },
    });
    view.step.set('pages');
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
        renderer as unknown as {
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
      renderer as unknown as { canvasBlob: (...args: unknown[]) => Promise<Blob> },
      'canvasBlob',
    ).mockResolvedValue(new Blob());
    const createURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:latest');
    createURL.mockClear();

    view.selected.set(0);
    const first = renderer.renderThumbnails(rail(0));
    const duplicate = renderer.renderThumbnails(rail(0));
    view.selected.set(3);
    const latest = renderer.renderThumbnails(rail(3));
    await Promise.resolve();

    expect(decode).toHaveBeenCalledOnce();
    expect(maximumActive).toBe(1);

    releaseFirst();
    await Promise.all([first, duplicate, latest]);

    expect(decode).toHaveBeenCalledTimes(2);
    expect(decode.mock.calls.map(([page]) => (page as PageEdit).id)).toEqual(['page-0', 'page-3']);
    expect(maximumActive).toBe(1);
    expect(createURL).toHaveBeenCalledOnce();
    expect(renderer.thumbs()).toEqual({ 'page-3': 'blob:latest' });
  });

  it.each([
    new ProcessingStoppedError('superseded'),
    new DOMException('The operation was aborted.', 'AbortError'),
  ])('does not report expected thumbnail cancellation errors', async (error) => {
    const { view, renderer } = setup();
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
    view.draft.set({
      ...structuredClone(draft),
      sources: [photo],
      manifest: { version: 1, pages: [{ id: 'page', sourceId: photo.id, page: 0 }] },
    });
    view.step.set('pages');
    vi.spyOn(
      renderer as unknown as {
        thumbnailCanvas: (...args: unknown[]) => Promise<HTMLCanvasElement>;
      },
      'thumbnailCanvas',
    ).mockRejectedValue(error);

    await renderer.renderThumbnails(undefined);

    expect(view.error()).toBe('');
  });
});
