import { ElementRef, QueryList } from '@angular/core';
import { of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Piece, ReaderState } from '../../core/models';
import {
  createReaderComponent,
  destroyConstructedReaders,
  layoutOf,
  renderVisibleOf,
  renderedPageOf,
  renderedWidthsOf,
  spyOnCanvasPublishing,
} from './reader-testing';

afterEach(destroyConstructedReaders);

describe('ReaderComponent page rendering', () => {
  it('caches a completed page render against its captured page request', async () => {
    const component = createReaderComponent();
    const canvas = document.createElement('canvas');
    spyOnCanvasPublishing(canvas);
    const canvases = new QueryList<ElementRef<HTMLCanvasElement>>();
    canvases.reset([new ElementRef(canvas)]);
    Reflect.set(component, 'canvases', canvases);
    Reflect.set(component, 'stage', {
      nativeElement: { clientWidth: 1024, clientHeight: 1366 },
    });
    Reflect.get(component, 'loading').set(false);

    let finishFirstRender!: () => void;
    const renderPage = vi
      .spyOn(Reflect.get(component, 'pdf'), 'renderPage')
      .mockReturnValueOnce(new Promise<void>((resolve) => (finishFirstRender = resolve)))
      .mockResolvedValue(undefined);
    const renderVisible = renderVisibleOf(component);

    const firstRender = renderVisible();
    Reflect.get(component, 'currentPage').set(2);
    finishFirstRender();
    await firstRender;

    expect(renderedPageOf(component)).toBeUndefined();

    await renderVisible();
    expect(renderPage.mock.calls.map((call) => call[1])).toEqual([1, 2]);
    component.ngOnDestroy();
  });

  it('rerenders a page when returning to it on the shared page-mode canvas', async () => {
    const component = createReaderComponent();
    const canvas = document.createElement('canvas');
    spyOnCanvasPublishing(canvas);
    const canvases = new QueryList<ElementRef<HTMLCanvasElement>>();
    canvases.reset([new ElementRef(canvas)]);
    Reflect.set(component, 'canvases', canvases);
    Reflect.set(component, 'stage', {
      nativeElement: { clientWidth: 1024, clientHeight: 1366 },
    });
    Reflect.get(component, 'loading').set(false);
    const renderPage = vi
      .spyOn(Reflect.get(component, 'pdf'), 'renderPage')
      .mockResolvedValue(undefined);
    const renderVisible = renderVisibleOf(component);

    await renderVisible();
    Reflect.get(component, 'currentPage').set(2);
    await renderVisible();
    Reflect.get(component, 'currentPage').set(1);
    await renderVisible();

    expect(renderPage.mock.calls.map((call) => call[1])).toEqual([1, 2, 1]);
    expect(renderedPageOf(component)).toEqual({
      pageNumber: 1,
      span: 1,
      columns: 1,
      key: 1000,
    });
    component.ngOnDestroy();
  });

  it('publishes only the current page render to the visible canvas', async () => {
    vi.useFakeTimers();
    try {
      const component = createReaderComponent();
      const canvas = document.createElement('canvas');
      const drawImage = spyOnCanvasPublishing(canvas);
      const canvases = new QueryList<ElementRef<HTMLCanvasElement>>();
      canvases.reset([new ElementRef(canvas)]);
      Reflect.set(component, 'canvases', canvases);
      Reflect.set(component, 'stage', {
        nativeElement: { clientWidth: 1024, clientHeight: 1366 },
      });
      Reflect.get(component, 'loading').set(false);
      Reflect.get(component, 'metrics').set([
        { page: 1, ratio: 0.75 },
        { page: 2, ratio: 0.75 },
      ]);

      let finishSecondRender!: () => void;
      vi.spyOn(Reflect.get(component, 'pdf'), 'renderPage').mockImplementation(
        (...args: unknown[]) => {
          const [target, pageNumber] = args as [HTMLCanvasElement, number];
          target.width = 100;
          target.height = 200;
          target.dataset['page'] = String(pageNumber);
          return pageNumber === 2
            ? new Promise<void>((resolve) => (finishSecondRender = resolve))
            : Promise.resolve();
        },
      );
      const renderVisible = renderVisibleOf(component);

      await renderVisible();
      expect(canvas.width).toBe(100);
      expect(drawImage.mock.calls.map((call) => call[0].dataset['page'])).toEqual(['1']);

      component.turnPage(1);
      expect(canvas.width).toBe(0);
      const staleRender = renderVisible();
      component.turnPage(-1);
      finishSecondRender();
      await staleRender;

      expect(canvas.width).toBe(0);
      expect(drawImage.mock.calls.map((call) => call[0].dataset['page'])).toEqual(['1']);

      await renderVisible();
      expect(canvas.width).toBe(100);
      expect(drawImage.mock.calls.map((call) => call[0].dataset['page'])).toEqual(['1', '1']);
      component.ngOnDestroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not cache a scroll render from the document superseded by reload', async () => {
    vi.useFakeTimers();
    try {
      const checksum = 'a'.repeat(64);
      const api = {
        piece: vi.fn(() =>
          of({
            id: 'piece',
            title: 'Reloaded score',
            composer: '',
            favorite: false,
            status: 'playing',
            sourceUrl: '',
            listeningUrl: '',
            notes: '',
            aliases: '',
            opus: '',
            musicKey: '',
            createdAt: '',
            updatedAt: '',
            pdf: {
              originalFilename: 'score.pdf',
              sizeBytes: 100,
              checksumSha256: checksum,
              pageCount: 1,
              uploadedAt: '',
              contentUrl: '/api/pieces/piece/pdf',
            },
            lastPlayedAt: null,
          } satisfies Piece),
        ),
        readerState: vi.fn(() =>
          of({
            pieceId: 'piece',
            pdfChecksumSha256: checksum,
            mode: 'scroll',
            lastPage: 1,
            scrollPosition: 0,
            zoom: 1,
            scrollSpeed: 5,
            scrollPaused: true,
          } satisfies ReaderState),
        ),
        saveReaderState: vi.fn((_id: string, _state: ReaderState) => of({})),
      };
      const component = createReaderComponent(api);
      const stageRect = { top: 0, bottom: 100, height: 100 } as DOMRect;
      Reflect.set(component, 'stage', {
        nativeElement: {
          clientWidth: 200,
          clientHeight: 100,
          scrollHeight: 100,
          scrollTop: 0,
          getBoundingClientRect: () => stageRect,
        },
      });
      Reflect.set(component, 'pieceId', 'piece');
      Reflect.get(component, 'loading').set(false);
      Reflect.get(component, 'mode').set('scroll');

      const scrollPage = () =>
        new ElementRef({
          clientWidth: 200,
          getBoundingClientRect: () => ({ top: 0, bottom: 100 }) as DOMRect,
        } as HTMLElement);
      const oldPages = new QueryList<ElementRef<HTMLElement>>();
      oldPages.reset([scrollPage()]);
      const oldCanvas = document.createElement('canvas');
      const oldCanvases = new QueryList<ElementRef<HTMLCanvasElement>>();
      oldCanvases.reset([new ElementRef(oldCanvas)]);
      Reflect.set(component, 'scrollPages', oldPages);
      Reflect.set(component, 'canvases', oldCanvases);

      let finishOldRender!: () => void;
      const pdf = Reflect.get(component, 'pdf');
      const renderPage = vi
        .spyOn(pdf, 'renderPage')
        .mockReturnValueOnce(new Promise<void>((resolve) => (finishOldRender = resolve)))
        .mockResolvedValue(undefined);
      vi.spyOn(pdf, 'load').mockResolvedValue([{ page: 1, ratio: 0.75 }]);
      const renderVisible = renderVisibleOf(component);
      const load = Reflect.get(component, 'load').bind(component) as () => Promise<void>;

      const oldRender = renderVisible();
      await load();
      finishOldRender();

      const newPages = new QueryList<ElementRef<HTMLElement>>();
      newPages.reset([scrollPage()]);
      const newCanvas = document.createElement('canvas');
      const newCanvases = new QueryList<ElementRef<HTMLCanvasElement>>();
      newCanvases.reset([new ElementRef(newCanvas)]);
      Reflect.set(component, 'scrollPages', newPages);
      Reflect.set(component, 'canvases', newCanvases);
      await oldRender;

      const renderedWidths = renderedWidthsOf(component);
      expect(renderedWidths.has(1)).toBe(false);

      await renderVisible();

      expect(renderPage).toHaveBeenCalledTimes(2);
      expect(renderPage.mock.calls[1][0]).toBe(newCanvas);
      expect(renderedWidths.get(1)).toBe(200);
      Reflect.get(component, 'loading').set(true);
      component.ngOnDestroy();
      vi.clearAllTimers();
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets a slow scroll render finish while scrolling refreshes the visible pages', async () => {
    const component = createReaderComponent();
    const stageRect = { top: 0, bottom: 100, height: 100 } as DOMRect;
    Reflect.set(component, 'stage', { nativeElement: { getBoundingClientRect: () => stageRect } });
    let pageWidth = 200;
    const pages = new QueryList<ElementRef<HTMLElement>>();
    pages.reset([
      new ElementRef({
        get clientWidth() {
          return pageWidth;
        },
        getBoundingClientRect: () => ({ top: 0, bottom: 100 }) as DOMRect,
      } as HTMLElement),
    ]);
    const canvas = document.createElement('canvas');
    const canvases = new QueryList<ElementRef<HTMLCanvasElement>>();
    canvases.reset([new ElementRef(canvas)]);
    Reflect.set(component, 'scrollPages', pages);
    Reflect.set(component, 'canvases', canvases);
    Reflect.get(component, 'loading').set(false);
    Reflect.get(component, 'mode').set('scroll');
    const finishes: (() => void)[] = [];
    const renderPage = vi
      .spyOn(Reflect.get(component, 'pdf'), 'renderPage')
      .mockImplementation(() => new Promise<void>((resolve) => finishes.push(resolve)));
    const renderVisible = renderVisibleOf(component);
    const renderedWidths = renderedWidthsOf(component);

    const slowRender = renderVisible();
    for (let refresh = 0; refresh < 5; refresh++) await renderVisible();
    expect(renderPage).toHaveBeenCalledTimes(1);
    finishes[0]();
    await slowRender;
    expect(renderedWidths.get(1)).toBe(200);

    renderedWidths.clear();
    const narrowRender = renderVisible();
    pageWidth = 180;
    const resizedRender = renderVisible();
    expect(renderPage.mock.calls.map((call) => call[2])).toEqual([200, 200, 180]);
    finishes[1]();
    finishes[2]();
    await Promise.all([narrowRender, resizedRender]);
    expect(renderedWidths.get(1)).toBe(180);
    component.ngOnDestroy();
  });

  it('evicts distant scroll canvases and renders them again when they return', async () => {
    const component = createReaderComponent();
    const stageRect = { top: 0, bottom: 100, height: 100 } as DOMRect;
    const stage = {
      nativeElement: {
        getBoundingClientRect: () => stageRect,
      },
    };
    const firstPage = {
      nativeElement: {
        clientWidth: 200,
        getBoundingClientRect: () => ({ top: 0, bottom: 100 }) as DOMRect,
      },
    };
    let secondTop = 400;
    const secondPage = {
      nativeElement: {
        clientWidth: 200,
        getBoundingClientRect: () => ({ top: secondTop, bottom: secondTop + 100 }) as DOMRect,
      },
    };
    const pages = new QueryList<ElementRef<HTMLElement>>();
    pages.reset([
      firstPage as unknown as ElementRef<HTMLElement>,
      secondPage as unknown as ElementRef<HTMLElement>,
    ]);
    const firstCanvas = document.createElement('canvas');
    const secondCanvas = document.createElement('canvas');
    secondCanvas.width = 1200;
    secondCanvas.height = 1600;
    const canvases = new QueryList<ElementRef<HTMLCanvasElement>>();
    canvases.reset([new ElementRef(firstCanvas), new ElementRef(secondCanvas)]);
    Reflect.set(component, 'stage', stage);
    Reflect.set(component, 'scrollPages', pages);
    Reflect.set(component, 'canvases', canvases);
    Reflect.get(component, 'loading').set(false);
    Reflect.get(component, 'mode').set('scroll');
    const renderedWidths = renderedWidthsOf(component);
    renderedWidths.set(2, 200);
    const renderPage = vi
      .spyOn(Reflect.get(component, 'pdf'), 'renderPage')
      .mockResolvedValue(undefined);
    const renderVisible = renderVisibleOf(component);

    await renderVisible();

    expect(secondCanvas.width).toBe(0);
    expect(secondCanvas.height).toBe(0);
    expect(renderedWidths.has(2)).toBe(false);

    secondTop = 100;
    await renderVisible();

    expect(renderPage.mock.calls.some((call) => call[1] === 2)).toBe(true);
    expect(renderedWidths.get(2)).toBe(200);
    component.ngOnDestroy();
  });
});

describe('ReaderComponent half turns with mixed page heights', () => {
  afterEach(() => localStorage.clear());

  /** Renders a half turn whose pages draw at the given CSS heights. */
  async function renderHalfTurn(heights: Record<number, number>) {
    const component = createReaderComponent();
    Reflect.get(component, 'metrics').set(
      Array.from({ length: 3 }, (_, i) => ({ page: i + 1, ratio: 0.75 })),
    );
    layoutOf(component).viewport.set({ width: 1366, height: 1024 });
    layoutOf(component).spreadPreference.set('half');
    Reflect.get(component, 'loading').set(false);
    Reflect.set(component, 'stage', { nativeElement: { clientWidth: 1366, clientHeight: 1024 } });
    const pair = [document.createElement('canvas'), document.createElement('canvas')];
    pair.forEach(spyOnCanvasPublishing);
    const canvases = new QueryList<ElementRef<HTMLCanvasElement>>();
    canvases.reset(pair.map((canvas) => new ElementRef(canvas)));
    Reflect.set(component, 'canvases', canvases);
    vi.spyOn(Reflect.get(component, 'pdf'), 'renderPage').mockImplementation(
      async (...args: unknown[]) => {
        const [canvas, page] = args as [HTMLCanvasElement, number];
        canvas.style.height = `${heights[page]}px`;
      },
    );
    const renderVisible = renderVisibleOf(component);
    component.turnPage(1);
    await renderVisible();
    return { component, shift: () => layoutOf(component).halfShift() as number };
  }

  it('centers the halves of a tall page and a short one on the same line', async () => {
    // Centered on one line, the pair spans 300 px above it and 500 px below: 100 px off center.
    const { component, shift } = await renderHalfTurn({ 1: 1000, 2: 600 });
    expect(shift()).toBe(-100);
    component.ngOnDestroy();
  });

  it('shifts the other way when the later page is the taller one', async () => {
    const { component, shift } = await renderHalfTurn({ 1: 600, 2: 1000 });
    expect(shift()).toBe(100);
    component.ngOnDestroy();
  });

  it('needs no shift when both pages are the same height', async () => {
    const { component, shift } = await renderHalfTurn({ 1: 800, 2: 800 });
    expect(shift()).toBe(0);
    component.ngOnDestroy();
  });

  it('drops the shift as soon as the turn completes', async () => {
    const { component, shift } = await renderHalfTurn({ 1: 1000, 2: 600 });
    component.turnPage(1);
    expect(shift()).toBe(0);
    component.ngOnDestroy();
  });
});

describe('ReaderComponent half turn to spread render cache', () => {
  afterEach(() => localStorage.clear());

  it('redraws pages 1–2 for the spread after drawing them for a half turn', async () => {
    const component = createReaderComponent();
    Reflect.get(component, 'metrics').set(
      Array.from({ length: 4 }, (_, i) => ({ page: i + 1, ratio: 1.4 })),
    );
    // Landscape and short enough that one column and two columns share a box key.
    layoutOf(component).viewport.set({ width: 1366, height: 600 });
    layoutOf(component).spreadPreference.set('half');
    Reflect.get(component, 'loading').set(false);
    Reflect.set(component, 'stage', { nativeElement: { clientWidth: 1366, clientHeight: 600 } });
    const canvases = new QueryList<ElementRef<HTMLCanvasElement>>();
    const pair = [document.createElement('canvas'), document.createElement('canvas')];
    pair.forEach(spyOnCanvasPublishing);
    canvases.reset(pair.map((canvas) => new ElementRef(canvas)));
    Reflect.set(component, 'canvases', canvases);
    const renderPage = vi
      .spyOn(Reflect.get(component, 'pdf'), 'renderPage')
      .mockResolvedValue(undefined);
    const renderVisible = renderVisibleOf(component);

    component.turnPage(1);
    await renderVisible();
    expect(renderPage).toHaveBeenCalledTimes(2);
    expect(renderedPageOf(component)).toMatchObject({ pageNumber: 1, columns: 1 });

    // Cycling Half turn -> Auto shows the same pages 1–2, now as a spread.
    component.cycleSpread();
    expect(renderedPageOf(component)).toBeUndefined();
    expect(layoutOf(component).visiblePages()).toEqual([1, 2]);
    await renderVisible();
    expect(renderPage).toHaveBeenCalledTimes(4);
    expect(renderedPageOf(component)).toMatchObject({ pageNumber: 1, columns: 2 });
    component.ngOnDestroy();
  });
});
