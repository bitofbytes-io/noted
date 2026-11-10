import { ElementRef, QueryList, signal } from '@angular/core';
import { Location } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import {
  ActivatedRoute,
  DefaultUrlSerializer,
  Navigation,
  Router,
  convertToParamMap,
} from '@angular/router';
import { of, Subject, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiService } from '../../core/api.service';
import { Piece, ReaderState } from '../../core/models';
import { ReaderComponent } from './reader.component';
import {
  loadSpreadPreference,
  nextSpreadPreference,
  pageDeltaForKey,
  saveSpreadPreference,
  spreadActive,
  spreadStartPage,
  trackFinePointerMovement,
} from './reader.utils';

function createReaderComponent(
  api: object = {},
  router: object = { navigate: vi.fn() },
  location: object = { back: vi.fn() },
): ReaderComponent {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: ApiService, useValue: api },
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { paramMap: convertToParamMap({ pieceId: 'piece' }) } },
      },
      { provide: Router, useValue: router },
      { provide: Location, useValue: location },
    ],
  });
  return TestBed.runInInjectionContext(() => new ReaderComponent());
}

function spyOnCanvasPublishing(canvas: HTMLCanvasElement) {
  const drawImage = vi.fn();
  vi.spyOn(canvas, 'getContext').mockReturnValue({
    drawImage,
  } as unknown as CanvasRenderingContext2D);
  return drawImage;
}

describe('ReaderComponent back', () => {
  afterEach(() => sessionStorage.clear());

  /** A router whose last navigation, to the reader, came from `previous`. */
  function routerFrom(previous: string | null) {
    const parse = new DefaultUrlSerializer();
    const previousNavigation = previous
      ? ({ finalUrl: parse.parse(previous) } as Navigation)
      : null;
    return {
      navigate: vi.fn(),
      lastSuccessfulNavigation: signal({ previousNavigation } as Navigation),
    };
  }

  it('goes back to the library it was opened from, with its search', () => {
    const router = routerFrom('/?q=bach&show=all');
    const location = { back: vi.fn() };
    createReaderComponent({}, router, location).back();
    expect(location.back).toHaveBeenCalled();
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it('opens the library with its last search when opened from elsewhere', () => {
    sessionStorage.setItem('noted.libraryQuery', JSON.stringify({ q: 'bach', sort: 7 }));
    for (const previous of [null, '/prepare/draft-1']) {
      const router = routerFrom(previous);
      const location = { back: vi.fn() };
      createReaderComponent({}, router, location).back();
      expect(location.back).not.toHaveBeenCalled();
      expect(router.navigate).toHaveBeenCalledWith(['/'], { queryParams: { q: 'bach' } });
    }
  });

  it('opens the plain library without a search saved in this tab', () => {
    const router = routerFrom(null);
    createReaderComponent({}, router).back();
    expect(router.navigate).toHaveBeenCalledWith(['/'], { queryParams: {} });
  });
});

describe('ReaderComponent', () => {
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
    const renderVisible = Reflect.get(component, 'renderVisible').bind(
      component,
    ) as () => Promise<void>;

    const firstRender = renderVisible();
    Reflect.get(component, 'currentPage').set(2);
    finishFirstRender();
    await firstRender;

    expect(Reflect.get(component, 'renderedPage')).toBeUndefined();

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
    const renderVisible = Reflect.get(component, 'renderVisible').bind(
      component,
    ) as () => Promise<void>;

    await renderVisible();
    Reflect.get(component, 'currentPage').set(2);
    await renderVisible();
    Reflect.get(component, 'currentPage').set(1);
    await renderVisible();

    expect(renderPage.mock.calls.map((call) => call[1])).toEqual([1, 2, 1]);
    expect(Reflect.get(component, 'renderedPage')).toEqual({ pageNumber: 1, span: 1, key: 1000 });
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
      const renderVisible = Reflect.get(component, 'renderVisible').bind(
        component,
      ) as () => Promise<void>;

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
      const renderVisible = Reflect.get(component, 'renderVisible').bind(
        component,
      ) as () => Promise<void>;
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

      const renderedWidths = Reflect.get(component, 'renderedWidths') as Map<number, number>;
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
    const renderVisible = Reflect.get(component, 'renderVisible').bind(
      component,
    ) as () => Promise<void>;
    const renderedWidths = Reflect.get(component, 'renderedWidths') as Map<number, number>;

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
    const renderedWidths = Reflect.get(component, 'renderedWidths') as Map<number, number>;
    renderedWidths.set(2, 200);
    const renderPage = vi
      .spyOn(Reflect.get(component, 'pdf'), 'renderPage')
      .mockResolvedValue(undefined);
    const renderVisible = Reflect.get(component, 'renderVisible').bind(
      component,
    ) as () => Promise<void>;

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

  it('checkpoints reader state during uninterrupted auto-scroll activity', async () => {
    vi.useFakeTimers();
    try {
      const saveReaderState = vi.fn((_id: string, _state: ReaderState) => of({}));
      const component = createReaderComponent({ saveReaderState });
      const scrollPages = new QueryList<ElementRef<HTMLElement>>();
      scrollPages.reset([]);
      Reflect.set(component, 'scrollPages', scrollPages);
      Reflect.set(component, 'stage', {
        nativeElement: {
          scrollTop: 240,
          getBoundingClientRect: () => ({ top: 0 }) as DOMRect,
        },
      });
      Reflect.set(component, 'pieceId', 'piece');
      Reflect.set(component, 'loadedPDFChecksum', 'a'.repeat(64));
      Reflect.get(component, 'loading').set(false);
      Reflect.get(component, 'mode').set('scroll');

      for (let elapsed = 0; elapsed < 10_000; elapsed += 500) {
        component.onStageScroll();
        await vi.advanceTimersByTimeAsync(500);
      }

      expect(saveReaderState).toHaveBeenCalledOnce();
      expect(saveReaderState.mock.calls[0][1]).toMatchObject({
        pieceId: 'piece',
        pdfChecksumSha256: 'a'.repeat(64),
        mode: 'scroll',
        scrollPosition: 240,
        scrollSpeed: 5,
      });
      component.ngOnDestroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops stale saves and asks for a reload after a PDF checksum conflict', () => {
    const saveReaderState = vi.fn((_id: string, _state: ReaderState) =>
      throwError(
        () =>
          new HttpErrorResponse({
            status: 409,
            error: { error: 'score PDF changed; reload before saving reader state' },
          }),
      ),
    );
    const component = createReaderComponent({ saveReaderState });
    Reflect.set(component, 'stage', { nativeElement: { scrollTop: 0 } });
    Reflect.set(component, 'pieceId', 'piece');
    Reflect.set(component, 'loadedPDFChecksum', 'a'.repeat(64));
    Reflect.get(component, 'loading').set(false);
    const saveNow = Reflect.get(component, 'saveNow').bind(component) as () => void;

    saveNow();
    saveNow();

    expect(saveReaderState).toHaveBeenCalledOnce();
    expect(saveReaderState.mock.calls[0][1]).toMatchObject({
      pieceId: 'piece',
      pdfChecksumSha256: 'a'.repeat(64),
    });
    expect(Reflect.get(component, 'error')()).toContain('Reload');
    expect(Reflect.get(component, 'readerStateSaveBlocked')).toBe(true);
    component.ngOnDestroy();
  });

  it('serializes reader-state saves and coalesces queued changes to the latest snapshot', () => {
    const firstSave = new Subject<void>();
    const secondSave = new Subject<void>();
    const saveReaderState = vi
      .fn((_id: string, _state: ReaderState) => firstSave)
      .mockReturnValueOnce(firstSave)
      .mockReturnValueOnce(secondSave);
    const component = createReaderComponent({ saveReaderState });
    Reflect.set(component, 'stage', { nativeElement: { scrollTop: 100 } });
    Reflect.set(component, 'pieceId', 'piece');
    Reflect.set(component, 'loadedPDFChecksum', 'a'.repeat(64));
    Reflect.get(component, 'loading').set(false);
    Reflect.get(component, 'mode').set('scroll');
    Reflect.get(component, 'paused').set(false);
    Reflect.get(component, 'currentPage').set(1);
    const saveNow = Reflect.get(component, 'saveNow').bind(component) as () => void;

    saveNow();
    Reflect.set(component, 'stage', { nativeElement: { scrollTop: 240 } });
    Reflect.get(component, 'paused').set(true);
    saveNow();
    Reflect.get(component, 'mode').set('page');
    Reflect.get(component, 'currentPage').set(3);
    saveNow();

    expect(saveReaderState).toHaveBeenCalledOnce();
    expect(saveReaderState.mock.calls[0][1]).toMatchObject({
      mode: 'scroll',
      lastPage: 1,
      scrollPosition: 100,
      scrollPaused: false,
    });

    firstSave.complete();

    expect(saveReaderState).toHaveBeenCalledTimes(2);
    expect(saveReaderState.mock.calls[1][1]).toMatchObject({
      mode: 'page',
      lastPage: 3,
      scrollPosition: 0,
      scrollPaused: true,
    });

    secondSave.complete();
    Reflect.get(component, 'loading').set(true);
    component.ngOnDestroy();
  });

  it('saves immediately when auto-scroll pauses or the reader mode changes', async () => {
    vi.useFakeTimers();
    try {
      const saveReaderState = vi.fn((_id: string, _state: ReaderState) => of({}));
      const component = createReaderComponent({ saveReaderState });
      const scrollPages = new QueryList<ElementRef<HTMLElement>>();
      scrollPages.reset([]);
      Reflect.set(component, 'scrollPages', scrollPages);
      Reflect.set(component, 'stage', {
        nativeElement: {
          scrollTop: 240,
          getBoundingClientRect: () => ({ top: 0 }) as DOMRect,
        },
      });
      Reflect.set(component, 'pieceId', 'piece');
      Reflect.set(component, 'loadedPDFChecksum', 'a'.repeat(64));
      Reflect.get(component, 'loading').set(false);
      Reflect.get(component, 'mode').set('scroll');
      Reflect.get(component, 'paused').set(false);

      component.togglePause();
      expect(saveReaderState).toHaveBeenCalledOnce();

      component.setMode('page');
      await vi.advanceTimersByTimeAsync(0);
      expect(saveReaderState).toHaveBeenCalledTimes(2);
      expect(saveReaderState.mock.calls[1][1].mode).toBe('page');
      component.ngOnDestroy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ReaderComponent metronome overlay', () => {
  function readerOnPage(page: number, pages: number) {
    const component = createReaderComponent();
    Reflect.get(component, 'metrics').set(
      Array.from({ length: pages }, (_, i) => ({ page: i + 1 })),
    );
    Reflect.get(component, 'currentPage').set(page);
    Reflect.set(component, 'stage', {
      nativeElement: { getBoundingClientRect: () => ({ left: 0, width: 1000 }) },
    });
    return component;
  }

  function tapAt(component: ReaderComponent, target: HTMLElement, clientX: number) {
    component.onScoreTap({ target, clientX } as unknown as MouseEvent);
  }

  it('does not turn the page when the overlay is tapped', () => {
    const component = readerOnPage(2, 5);
    const overlay = document.createElement('app-metronome');
    overlay.className = 'reader-metronome';
    const button = overlay.appendChild(document.createElement('button'));

    tapAt(component, button, 900);
    tapAt(component, button, 100);
    expect(Reflect.get(component, 'currentPage')()).toBe(2);
  });

  it('still turns pages from the score while the metronome is open', () => {
    const component = readerOnPage(2, 5);
    component.toggleMetronome();
    const score = document.createElement('canvas');

    tapAt(component, score, 900);
    expect(Reflect.get(component, 'currentPage')()).toBe(3);
    tapAt(component, score, 100);
    expect(Reflect.get(component, 'currentPage')()).toBe(2);
    component.ngOnDestroy();
  });

  it('releases focus from the toggle after a pointer press but not a keyboard press', () => {
    const component = readerOnPage(1, 3);
    const toggle = document.createElement('button');
    document.body.appendChild(toggle);

    toggle.focus();
    component.toggleMetronome({ detail: 1, currentTarget: toggle } as unknown as MouseEvent);
    expect(document.activeElement).not.toBe(toggle);

    toggle.focus();
    component.toggleMetronome({ detail: 0, currentTarget: toggle } as unknown as MouseEvent);
    expect(document.activeElement).toBe(toggle);
    toggle.remove();
  });

  it('keeps the chrome visible while a metronome control has keyboard focus', () => {
    vi.useFakeTimers();
    try {
      const component = readerOnPage(1, 3);
      Reflect.get(component, 'loading').set(false);
      const panel = document.createElement('div');
      const button = panel.appendChild(document.createElement('button'));
      document.body.appendChild(panel);
      Reflect.set(component, 'metronome', new ElementRef(panel));

      button.focus();
      component.onChromeActivity();
      vi.advanceTimersByTime(3100);
      expect(Reflect.get(component, 'controlsVisible')()).toBe(true);

      button.blur();
      vi.advanceTimersByTime(3100);
      expect(Reflect.get(component, 'controlsVisible')()).toBe(false);
      panel.remove();
      component.ngOnDestroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens and closes without touching the page', () => {
    const component = readerOnPage(1, 3);
    component.toggleMetronome();
    expect(Reflect.get(component, 'metronomeOpen')()).toBe(true);
    component.toggleMetronome();
    expect(Reflect.get(component, 'metronomeOpen')()).toBe(false);
    expect(Reflect.get(component, 'currentPage')()).toBe(1);
  });
});

describe('ReaderComponent two-page spread', () => {
  afterEach(() => localStorage.clear());

  /** A reader of `pages` pages, shown in a viewport of the given size. */
  function readerIn(width: number, height: number, pages: number, page = 1) {
    const component = createReaderComponent();
    Reflect.get(component, 'metrics').set(
      Array.from({ length: pages }, (_, i) => ({ page: i + 1, ratio: 0.75 })),
    );
    Reflect.get(component, 'viewport').set({ width, height });
    Reflect.get(component, 'currentPage').set(page);
    Reflect.get(component, 'loading').set(false);
    return component;
  }

  const visible = (component: ReaderComponent): number[] =>
    Reflect.get(component, 'visiblePages')();

  it('shows two pages in landscape and one in portrait', () => {
    expect(visible(readerIn(1366, 1024, 6))).toEqual([1, 2]);
    expect(visible(readerIn(1024, 1366, 6))).toEqual([1]);
  });

  it('keeps one page on a landscape viewport that is too narrow', () => {
    expect(visible(readerIn(844, 390, 6))).toEqual([1]);
  });

  it('turns a spread by two pages with the arrow, page and pedal keys', () => {
    const component = readerIn(1366, 1024, 6);
    const press = (key: string) => {
      const event = new KeyboardEvent('keydown', { key, cancelable: true });
      component.onKeydown(event);
      expect(event.defaultPrevented).toBe(true);
    };

    press('ArrowRight');
    expect(visible(component)).toEqual([3, 4]);
    press('PageDown');
    expect(visible(component)).toEqual([5, 6]);
    press('ArrowLeft');
    expect(visible(component)).toEqual([3, 4]);
    press('PageUp');
    expect(visible(component)).toEqual([1, 2]);
  });

  it('stops at the first and last spread', () => {
    const component = readerIn(1366, 1024, 4);
    component.turnPage(-1);
    expect(visible(component)).toEqual([1, 2]);
    component.turnPage(1);
    component.turnPage(1);
    expect(visible(component)).toEqual([3, 4]);
  });

  it('ends an odd page count with a single page', () => {
    const component = readerIn(1366, 1024, 5, 3);
    expect(visible(component)).toEqual([3, 4]);
    component.turnPage(1);
    expect(visible(component)).toEqual([5]);
    expect(Reflect.get(component, 'pageLabel')()).toBe('5');
    component.turnPage(1);
    expect(visible(component)).toEqual([5]);
    component.turnPage(-1);
    expect(visible(component)).toEqual([3, 4]);
  });

  it('pairs from an odd page when a spread opens on an even page', () => {
    const component = readerIn(1366, 1024, 6, 4);
    expect(visible(component)).toEqual([3, 4]);
    expect(Reflect.get(component, 'pageLabel')()).toBe('3–4');
  });

  it('turns one page at a time when the spread is switched off', () => {
    const component = readerIn(1366, 1024, 6);
    Reflect.get(component, 'spreadPreference').set('single');
    component.turnPage(1);
    expect(visible(component)).toEqual([2]);
  });

  it('forces a spread in portrait and a single page in landscape', () => {
    const component = readerIn(1024, 1366, 6);
    Reflect.get(component, 'spreadPreference').set('spread');
    expect(visible(component)).toEqual([1, 2]);
    Reflect.get(component, 'viewport').set({ width: 1366, height: 1024 });
    Reflect.get(component, 'spreadPreference').set('single');
    expect(visible(component)).toEqual([1]);
  });

  it('never spreads a one-page score', () => {
    expect(visible(readerIn(1366, 1024, 1))).toEqual([1]);
  });

  it('remembers the layout choice on this device', () => {
    const component = readerIn(1366, 1024, 6);
    component.cycleSpread();
    expect(Reflect.get(component, 'spreadPreference')()).toBe('single');
    expect(loadSpreadPreference()).toBe('single');
    component.cycleSpread();
    component.cycleSpread();
    expect(loadSpreadPreference()).toBe('auto');
    component.ngOnDestroy();
  });

  it('renders both pages of a spread, left to right, into their own canvases', async () => {
    const component = readerIn(1366, 1024, 6);
    Reflect.set(component, 'stage', { nativeElement: { clientWidth: 1366, clientHeight: 1024 } });
    const left = document.createElement('canvas');
    const right = document.createElement('canvas');
    spyOnCanvasPublishing(left);
    spyOnCanvasPublishing(right);
    const canvases = new QueryList<ElementRef<HTMLCanvasElement>>();
    canvases.reset([new ElementRef(left), new ElementRef(right)]);
    Reflect.set(component, 'canvases', canvases);
    const renderPage = vi
      .spyOn(Reflect.get(component, 'pdf'), 'renderPage')
      .mockResolvedValue(undefined);
    const renderVisible = Reflect.get(component, 'renderVisible').bind(
      component,
    ) as () => Promise<void>;

    await renderVisible();

    expect(renderPage.mock.calls.map((call) => call[1])).toEqual([1, 2]);
    // Each page gets half the stage, less the padding and the gap between them.
    expect(renderPage.mock.calls.map((call) => call[2])).toEqual([667, 667]);
    expect(Reflect.get(component, 'renderedPage')).toEqual({ pageNumber: 1, span: 2, key: 667 });

    component.turnPage(1);
    await renderVisible();
    expect(renderPage.mock.calls.slice(2).map((call) => call[1])).toEqual([3, 4]);
    component.ngOnDestroy();
  });

  it('waits for the canvases to match the pages before rendering', async () => {
    const component = readerIn(1366, 1024, 6);
    Reflect.set(component, 'stage', { nativeElement: { clientWidth: 1366, clientHeight: 1024 } });
    const canvases = new QueryList<ElementRef<HTMLCanvasElement>>();
    canvases.reset([new ElementRef(document.createElement('canvas'))]);
    Reflect.set(component, 'canvases', canvases);
    const renderPage = vi
      .spyOn(Reflect.get(component, 'pdf'), 'renderPage')
      .mockResolvedValue(undefined);

    await (Reflect.get(component, 'renderVisible').bind(component) as () => Promise<void>)();

    expect(renderPage).not.toHaveBeenCalled();
    component.ngOnDestroy();
  });
});

describe('spread helpers', () => {
  it('spreads only in landscape wide enough, unless the choice forces it', () => {
    expect(spreadActive('auto', 1366, 1024, 4)).toBe(true);
    expect(spreadActive('auto', 1024, 1366, 4)).toBe(false);
    expect(spreadActive('auto', 899, 500, 4)).toBe(false);
    expect(spreadActive('single', 1366, 1024, 4)).toBe(false);
    expect(spreadActive('spread', 1024, 1366, 4)).toBe(true);
    expect(spreadActive('spread', 1366, 1024, 1)).toBe(false);
  });

  it('starts every spread on an odd page', () => {
    expect([1, 2, 3, 4, 5].map(spreadStartPage)).toEqual([1, 1, 3, 3, 5]);
  });

  it('cycles auto, single, spread', () => {
    expect(nextSpreadPreference('auto')).toBe('single');
    expect(nextSpreadPreference('single')).toBe('spread');
    expect(nextSpreadPreference('spread')).toBe('auto');
  });

  it('falls back to auto for a missing, unknown or unreadable choice', () => {
    expect(loadSpreadPreference({ getItem: () => null })).toBe('auto');
    expect(loadSpreadPreference({ getItem: () => 'wide' })).toBe('auto');
    expect(
      loadSpreadPreference({
        getItem: () => {
          throw new Error('blocked');
        },
      }),
    ).toBe('auto');
  });

  it('round-trips the choice and ignores storage that refuses writes', () => {
    const store = new Map<string, string>();
    saveSpreadPreference('spread', { setItem: (key, value) => void store.set(key, value) });
    expect(loadSpreadPreference({ getItem: (key) => store.get(key) ?? null })).toBe('spread');
    expect(() =>
      saveSpreadPreference('single', {
        setItem: () => {
          throw new Error('quota');
        },
      }),
    ).not.toThrow();
  });
});

describe('pageDeltaForKey', () => {
  it('maps keyboard and pedal-style navigation keys', () => {
    expect(pageDeltaForKey('PageDown')).toBe(1);
    expect(pageDeltaForKey('ArrowRight')).toBe(1);
    expect(pageDeltaForKey('PageUp')).toBe(-1);
    expect(pageDeltaForKey('Escape')).toBe(0);
  });
});

describe('trackFinePointerMovement', () => {
  it('recognizes genuine mouse and pen movement', () => {
    expect(
      trackFinePointerMovement(
        { clientX: 15, clientY: 30, pointerType: 'mouse' },
        {
          clientX: 20,
          clientY: 30,
          pointerType: 'mouse',
        },
      ).moved,
    ).toBe(true);
    expect(
      trackFinePointerMovement(
        { clientX: 20, clientY: 30, pointerType: 'pen' },
        {
          clientX: 24,
          clientY: 30,
          pointerType: 'pen',
        },
      ).moved,
    ).toBe(true);
  });

  it('ignores stationary pointermove events and touch panning', () => {
    expect(
      trackFinePointerMovement(
        { clientX: 20, clientY: 30, pointerType: 'mouse' },
        {
          clientX: 20,
          clientY: 30,
          pointerType: 'mouse',
        },
      ).moved,
    ).toBe(false);
    expect(
      trackFinePointerMovement(
        { clientX: 20, clientY: 30, pointerType: 'mouse' },
        {
          clientX: 60,
          clientY: 80,
          pointerType: 'touch',
        },
      ),
    ).toEqual({ baseline: undefined, moved: false });
  });

  it('accumulates successive sub-threshold moves until they qualify', () => {
    let baseline = trackFinePointerMovement(undefined, {
      clientX: 20,
      clientY: 30,
      pointerType: 'mouse',
    }).baseline;

    for (const clientX of [21, 22]) {
      const tracking = trackFinePointerMovement(baseline, {
        clientX,
        clientY: 30,
        pointerType: 'mouse',
      });
      expect(tracking.moved).toBe(false);
      expect(tracking.baseline?.clientX).toBe(20);
      baseline = tracking.baseline;
    }

    const tracking = trackFinePointerMovement(baseline, {
      clientX: 23,
      clientY: 30,
      pointerType: 'mouse',
    });
    expect(tracking.moved).toBe(true);
    expect(tracking.baseline?.clientX).toBe(23);
  });

  it('does not carry a touch or different fine-pointer baseline across modalities', () => {
    const touchTracking = trackFinePointerMovement(
      { clientX: 20, clientY: 30, pointerType: 'mouse' },
      { clientX: 120, clientY: 130, pointerType: 'touch' },
    );
    expect(touchTracking).toEqual({ baseline: undefined, moved: false });

    const firstMouseTracking = trackFinePointerMovement(touchTracking.baseline, {
      clientX: 120,
      clientY: 130,
      pointerType: 'mouse',
    });
    expect(firstMouseTracking.moved).toBe(false);

    const penTracking = trackFinePointerMovement(firstMouseTracking.baseline, {
      clientX: 220,
      clientY: 230,
      pointerType: 'pen',
    });
    expect(penTracking.moved).toBe(false);
    expect(penTracking.baseline).toEqual({
      clientX: 220,
      clientY: 230,
      pointerType: 'pen',
    });
  });
});
