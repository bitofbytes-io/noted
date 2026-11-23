import { ElementRef, QueryList, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { DefaultUrlSerializer, Navigation } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReaderState } from '../../core/models';
import { ReaderComponent } from './reader.component';
import {
  chromeOf,
  createReaderComponent,
  destroyConstructedReaders,
  layoutOf,
  renderVisibleOf,
  renderedPageOf,
  saveReaderStateNow,
  spyOnCanvasPublishing,
} from './reader-testing';
import { loadSpreadPreference } from './reader.utils';

afterEach(destroyConstructedReaders);

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
      chromeOf(component).activity();
      vi.advanceTimersByTime(3100);
      expect(chromeOf(component).controlsVisible()).toBe(true);

      button.blur();
      vi.advanceTimersByTime(3100);
      expect(chromeOf(component).controlsVisible()).toBe(false);
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
    layoutOf(component).viewport.set({ width, height });
    Reflect.get(component, 'currentPage').set(page);
    Reflect.get(component, 'loading').set(false);
    return component;
  }

  const visible = (component: ReaderComponent): number[] => layoutOf(component).visiblePages();

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
    expect(layoutOf(component).pageLabel()).toBe('5');
    component.turnPage(1);
    expect(visible(component)).toEqual([5]);
    component.turnPage(-1);
    expect(visible(component)).toEqual([3, 4]);
  });

  it('labels one page in scroll mode even on a wide landscape viewport', () => {
    const component = readerIn(1366, 1024, 6, 4);
    Reflect.get(component, 'mode').set('scroll');
    expect(visible(component)).toEqual([4]);
    expect(layoutOf(component).pageLabel()).toBe('4');
  });

  it('saves the left page of the spread so a narrower screen resumes there', () => {
    const saveReaderState = vi.fn((_id: string, _state: ReaderState) => new Subject<void>());
    const component = createReaderComponent({ saveReaderState });
    Reflect.get(component, 'metrics').set(
      Array.from({ length: 6 }, (_, i) => ({ page: i + 1, ratio: 0.75 })),
    );
    layoutOf(component).viewport.set({ width: 1366, height: 1024 });
    Reflect.get(component, 'currentPage').set(4);
    Reflect.set(component, 'pieceId', 'piece');
    Reflect.set(component, 'loadedPDFChecksum', 'a'.repeat(64));
    Reflect.get(component, 'loading').set(false);
    saveReaderStateNow(component);

    expect(saveReaderState.mock.calls[0][1]).toMatchObject({ mode: 'page', lastPage: 3 });
    Reflect.get(component, 'loading').set(true);
    component.ngOnDestroy();
  });

  it('pairs from an odd page when a spread opens on an even page', () => {
    const component = readerIn(1366, 1024, 6, 4);
    expect(visible(component)).toEqual([3, 4]);
    expect(layoutOf(component).pageLabel()).toBe('3–4');
  });

  it('turns one page at a time when the spread is switched off', () => {
    const component = readerIn(1366, 1024, 6);
    layoutOf(component).spreadPreference.set('single');
    component.turnPage(1);
    expect(visible(component)).toEqual([2]);
  });

  it('forces a spread in portrait and a single page in landscape', () => {
    const component = readerIn(1024, 1366, 6);
    layoutOf(component).spreadPreference.set('spread');
    expect(visible(component)).toEqual([1, 2]);
    layoutOf(component).viewport.set({ width: 1366, height: 1024 });
    layoutOf(component).spreadPreference.set('single');
    expect(visible(component)).toEqual([1]);
  });

  it('never spreads a one-page score', () => {
    expect(visible(readerIn(1366, 1024, 1))).toEqual([1]);
  });

  it('remembers the layout choice on this device', () => {
    const component = readerIn(1366, 1024, 6);
    component.cycleSpread();
    expect(layoutOf(component).spreadPreference()).toBe('single');
    expect(loadSpreadPreference()).toBe('single');
    component.cycleSpread();
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
    const renderVisible = renderVisibleOf(component);

    await renderVisible();

    expect(renderPage.mock.calls.map((call) => call[1])).toEqual([1, 2]);
    // Each page gets half the stage, less the padding and the gap between them.
    expect(renderPage.mock.calls.map((call) => call[2])).toEqual([667, 667]);
    expect(renderedPageOf(component)).toEqual({
      pageNumber: 1,
      span: 2,
      columns: 2,
      key: 667,
    });

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

    await renderVisibleOf(component)();

    expect(renderPage).not.toHaveBeenCalled();
    component.ngOnDestroy();
  });
});
