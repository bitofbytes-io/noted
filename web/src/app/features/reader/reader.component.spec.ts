import { ElementRef, QueryList } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { of, Subject, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { ApiService } from '../../core/api.service';
import { Piece, ReaderState } from '../../core/models';
import { ReaderComponent } from './reader.component';
import { pageDeltaForKey, trackFinePointerMovement } from './reader.utils';

function createReaderComponent(api: object = {}): ReaderComponent {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: ApiService, useValue: api },
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { paramMap: convertToParamMap({ pieceId: 'piece' }) } },
      },
      { provide: Router, useValue: { navigate: vi.fn() } },
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
    expect(Reflect.get(component, 'renderedPage')).toEqual({ pageNumber: 1, key: 1000 });
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
            sourceUrl: '',
            listeningUrl: '',
            notes: '',
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
      spyOnCanvasPublishing(oldCanvas);
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
      spyOnCanvasPublishing(newCanvas);
      const newCanvases = new QueryList<ElementRef<HTMLCanvasElement>>();
      newCanvases.reset([new ElementRef(newCanvas)]);
      Reflect.set(component, 'scrollPages', newPages);
      Reflect.set(component, 'canvases', newCanvases);
      await oldRender;

      const renderedWidths = Reflect.get(component, 'renderedWidths') as Map<number, number>;
      expect(renderedWidths.has(1)).toBe(false);

      await renderVisible();

      expect(renderPage).toHaveBeenCalledTimes(2);
      expect(renderPage.mock.calls[1][0]).not.toBe(newCanvas);
      expect(renderedWidths.get(1)).toBe(200);
      Reflect.get(component, 'loading').set(true);
      component.ngOnDestroy();
      vi.clearAllTimers();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not publish an older scroll render after a newer request completes', async () => {
    const component = createReaderComponent();
    const stageRect = { top: 0, bottom: 100, height: 100 } as DOMRect;
    Reflect.set(component, 'stage', {
      nativeElement: { getBoundingClientRect: () => stageRect },
    });
    const pages = new QueryList<ElementRef<HTMLElement>>();
    pages.reset([
      new ElementRef({
        clientWidth: 200,
        getBoundingClientRect: () => ({ top: 0, bottom: 100 }) as DOMRect,
      } as HTMLElement),
    ]);
    const canvas = document.createElement('canvas');
    const drawImage = spyOnCanvasPublishing(canvas);
    const canvases = new QueryList<ElementRef<HTMLCanvasElement>>();
    canvases.reset([new ElementRef(canvas)]);
    Reflect.set(component, 'scrollPages', pages);
    Reflect.set(component, 'canvases', canvases);
    Reflect.get(component, 'loading').set(false);
    Reflect.get(component, 'mode').set('scroll');

    const finish: Array<() => void> = [];
    vi.spyOn(Reflect.get(component, 'pdf'), 'renderPage').mockImplementation((canvasTarget) => {
      const target = canvasTarget as HTMLCanvasElement;
      const request = String(finish.length + 1);
      return new Promise<void>((resolve) =>
        finish.push(() => {
          target.width = 200;
          target.height = 300;
          target.dataset['request'] = request;
          resolve();
        }),
      );
    });
    const renderVisible = Reflect.get(component, 'renderVisible').bind(
      component,
    ) as () => Promise<void>;

    const first = renderVisible();
    Reflect.set(component, 'renderGeneration', 1);
    const second = renderVisible();
    finish[1]();
    await second;
    finish[0]();
    await first;

    expect(drawImage.mock.lastCall?.[0].dataset['request'] ?? canvas.dataset['request']).toBe('2');
    expect(canvas.width).toBe(200);
    expect(Reflect.get(component, 'renderedWidths').get(1)).toBe(200);
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
    spyOnCanvasPublishing(firstCanvas);
    const secondCanvas = document.createElement('canvas');
    spyOnCanvasPublishing(secondCanvas);
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
