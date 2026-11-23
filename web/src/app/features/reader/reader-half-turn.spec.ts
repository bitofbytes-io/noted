import { ElementRef, QueryList } from '@angular/core';
import { of, Subject } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReaderState } from '../../core/models';
import { ReaderComponent } from './reader.component';
import {
  createReaderComponent,
  destroyConstructedReaders,
  layoutOf,
  mountReader,
  renderVisibleOf,
  saveReaderStateNow,
  shownCanvases,
  spyOnCanvasPublishing,
} from './reader-testing';
import { loadSpreadPreference } from './reader.utils';

afterEach(destroyConstructedReaders);

describe('ReaderComponent half-page turns', () => {
  afterEach(() => localStorage.clear());

  function halfReader(pages: number, page = 1, width = 1366, height = 1024) {
    const component = createReaderComponent();
    Reflect.get(component, 'metrics').set(
      Array.from({ length: pages }, (_, i) => ({ page: i + 1, ratio: 0.75 })),
    );
    layoutOf(component).viewport.set({ width, height });
    Reflect.get(component, 'currentPage').set(page);
    layoutOf(component).spreadPreference.set('half');
    Reflect.get(component, 'loading').set(false);
    return component;
  }

  const visible = (component: ReaderComponent): number[] => layoutOf(component).visiblePages();
  const turned = (component: ReaderComponent): boolean => layoutOf(component).halfShown();
  const state = (component: ReaderComponent) => [
    Reflect.get(component, 'currentPage')(),
    turned(component),
  ];

  it('never spreads, even on a wide landscape viewport', () => {
    expect(visible(halfReader(6))).toEqual([1]);
    expect(turned(halfReader(6))).toBe(false);
  });

  it('turns forward half a page at a time through the whole score', () => {
    const component = halfReader(3);
    const seen: Array<(number | boolean)[]> = [state(component)];
    for (let i = 0; i < 4; i++) {
      component.turnPage(1);
      seen.push(state(component));
    }
    expect(seen).toEqual([
      [1, false],
      [1, true],
      [2, false],
      [2, true],
      [3, false],
    ]);
    component.turnPage(1);
    expect(state(component)).toEqual([3, false]);
  });

  it('shows the top of the next page over the bottom of this one between turns', () => {
    const component = halfReader(4, 2);
    component.turnPage(1);
    // The earlier page comes first: its bottom half stays, the later page's top half replaces its top.
    expect(visible(component)).toEqual([2, 3]);
    expect(layoutOf(component).pageLabel()).toBe('2–3');
    component.turnPage(1);
    expect(visible(component)).toEqual([3]);
  });

  it('clips the earlier page to its bottom half and the later to its top half, in one place', () => {
    const fixture = mountReader();
    fixture.detectChanges();
    const component = fixture.componentInstance;
    Reflect.get(component, 'metrics').set(
      Array.from({ length: 3 }, (_, i) => ({ page: i + 1, ratio: 0.75 })),
    );
    layoutOf(component).spreadPreference.set('half');
    Reflect.get(component, 'loading').set(false);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;

    // Between turns the page shows whole.
    expect(shownCanvases(root)).toEqual([{ page: '1', clipPath: '', gridArea: '' }]);

    component.turnPage(1);
    fixture.detectChanges();
    expect(root.querySelector('.page-stage')?.classList.contains('half-turn')).toBe(true);
    expect(shownCanvases(root)).toEqual([
      // The earlier page keeps its bottom half; the later page's top half takes the rest.
      { page: '1', clipPath: 'inset(50% 0 0 0)', gridArea: '1/1' },
      { page: '2', clipPath: 'inset(0 0 50% 0)', gridArea: '1/1' },
    ]);

    component.turnPage(1);
    fixture.detectChanges();
    expect(root.querySelector('.page-stage')?.classList.contains('half-turn')).toBe(false);
    expect(shownCanvases(root)).toEqual([{ page: '2', clipPath: '', gridArea: '' }]);
  });

  it('retraces the same half steps backward', () => {
    const component = halfReader(3, 2);
    component.turnPage(-1);
    expect(state(component)).toEqual([1, true]);
    expect(visible(component)).toEqual([1, 2]);
    component.turnPage(-1);
    expect(state(component)).toEqual([1, false]);
    component.turnPage(-1);
    expect(state(component)).toEqual([1, false]);
  });

  it('turns with the arrow, page and pedal keys', () => {
    const component = halfReader(3);
    component.onKeydown(new KeyboardEvent('keydown', { key: 'PageDown', cancelable: true }));
    component.onKeydown(new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true }));
    expect(state(component)).toEqual([2, false]);
    component.onKeydown(new KeyboardEvent('keydown', { key: 'ArrowLeft', cancelable: true }));
    expect(state(component)).toEqual([1, true]);
  });

  it('enables the page buttons by half-turn position', () => {
    const component = halfReader(2);
    const canBack = () => layoutOf(component).canTurnBack();
    const canForward = () => layoutOf(component).canTurnForward();
    expect([canBack(), canForward()]).toEqual([false, true]);
    component.turnPage(1);
    expect([canBack(), canForward()]).toEqual([true, true]);
    component.turnPage(1);
    expect([canBack(), canForward()]).toEqual([true, false]);
  });

  it('saves the earlier page so a reload resumes on a whole page', async () => {
    const saveReaderState = vi.fn((_id: string, _state: ReaderState) => new Subject<void>());
    const component = createReaderComponent({ saveReaderState });
    Reflect.get(component, 'metrics').set(
      Array.from({ length: 3 }, (_, i) => ({ page: i + 1, ratio: 0.75 })),
    );
    layoutOf(component).spreadPreference.set('half');
    Reflect.set(component, 'pieceId', 'piece');
    Reflect.set(component, 'loadedPDFChecksum', 'a'.repeat(64));
    Reflect.get(component, 'loading').set(false);
    for (let i = 0; i < 3; i++) component.turnPage(1);
    expect(state(component)).toEqual([2, true]);
    expect(visible(component)).toEqual([2, 3]);
    saveReaderStateNow(component);

    const saved = saveReaderState.mock.calls[0][1];
    expect(saved).toMatchObject({ mode: 'page', lastPage: 2 });
    Reflect.get(component, 'loading').set(true);
    component.ngOnDestroy();

    // Reopening the score from that saved state shows page 2 whole, not the half turn.
    const checksum = 'a'.repeat(64);
    const fixture = mountReader({
      piece: () => of({ pdf: { checksumSha256: checksum, contentUrl: '/pdf' } }),
      readerState: () => of({ ...saved, pdfChecksumSha256: checksum }),
      saveReaderState: () => of({}),
    });
    const reopened = fixture.componentInstance;
    layoutOf(reopened).spreadPreference.set('half');
    vi.spyOn(Reflect.get(reopened, 'pdf'), 'load').mockResolvedValue(
      Array.from({ length: 3 }, (_, i) => ({ page: i + 1, ratio: 0.75 })),
    );
    fixture.detectChanges();
    await vi.waitFor(() => expect(Reflect.get(reopened, 'loading')()).toBe(false));
    fixture.detectChanges();
    expect(state(reopened)).toEqual([2, false]);
    expect(visible(reopened)).toEqual([2]);
    expect(shownCanvases(fixture.nativeElement)).toEqual([
      { page: '2', clipPath: '', gridArea: '' },
    ]);
  });

  it('leaves the half step when the layout changes', () => {
    const component = halfReader(3);
    component.turnPage(1);
    component.cycleSpread();
    expect(layoutOf(component).spreadPreference()).toBe('auto');
    expect(turned(component)).toBe(false);
    expect(layoutOf(component).halfTurned()).toBe(false);
    component.ngOnDestroy();
  });

  it('leaves the half step when the mode changes, in both directions', async () => {
    vi.useFakeTimers();
    try {
      const component = halfReader(3);
      Reflect.set(component, 'stage', {
        nativeElement: {
          clientWidth: 1366,
          clientHeight: 1024,
          scrollTo: () => undefined,
          getBoundingClientRect: () => ({ top: 0 }),
        },
      });
      Reflect.set(component, 'scrollPages', new QueryList<ElementRef<HTMLElement>>());
      component.turnPage(1);
      expect(layoutOf(component).halfTurned()).toBe(true);
      component.setMode('scroll');
      await vi.advanceTimersByTimeAsync(0);
      expect(layoutOf(component).halfTurned()).toBe(false);
      component.setMode('page');
      await vi.advanceTimersByTimeAsync(0);
      expect(layoutOf(component).halfTurned()).toBe(false);
      expect(visible(component)).toEqual([1]);
      component.ngOnDestroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not affect single, spread or one-page layouts', () => {
    const single = halfReader(4);
    layoutOf(single).spreadPreference.set('single');
    single.turnPage(1);
    expect(state(single)).toEqual([2, false]);

    const spread = halfReader(4);
    layoutOf(spread).spreadPreference.set('spread');
    spread.turnPage(1);
    expect(visible(spread)).toEqual([3, 4]);

    const one = halfReader(1);
    one.turnPage(1);
    expect(state(one)).toEqual([1, false]);
  });

  it('remembers the half-turn choice on this device', () => {
    const component = halfReader(3);
    layoutOf(component).spreadPreference.set('spread');
    component.cycleSpread();
    expect(layoutOf(component).spreadPreference()).toBe('half');
    expect(loadSpreadPreference()).toBe('half');
    component.ngOnDestroy();
  });

  it('renders both pages of a half turn into canvases that share one page box', async () => {
    const component = halfReader(4);
    Reflect.set(component, 'stage', { nativeElement: { clientWidth: 1366, clientHeight: 1024 } });
    const earlier = document.createElement('canvas');
    const later = document.createElement('canvas');
    spyOnCanvasPublishing(earlier);
    spyOnCanvasPublishing(later);
    const canvases = new QueryList<ElementRef<HTMLCanvasElement>>();
    canvases.reset([new ElementRef(earlier), new ElementRef(later)]);
    Reflect.set(component, 'canvases', canvases);
    const renderPage = vi
      .spyOn(Reflect.get(component, 'pdf'), 'renderPage')
      .mockResolvedValue(undefined);

    component.turnPage(1);
    await renderVisibleOf(component)();

    expect(renderPage.mock.calls.map((call) => call[1])).toEqual([1, 2]);
    // Both halves use the full stage width rather than sharing it like a spread.
    expect(renderPage.mock.calls.map((call) => call[2])).toEqual([1342, 1342]);
    component.ngOnDestroy();
  });
});
