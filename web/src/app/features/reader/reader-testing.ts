// Shared TestBed setup for the Reader specs. Not part of the application bundle.
import { Location } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { NEVER } from 'rxjs';
import { vi } from 'vitest';
import { ApiService } from '../../core/api.service';
import { ReaderComponent } from './reader.component';

export function configureReaderTestBed(
  api: object,
  router: object = { navigate: vi.fn() },
  location: object = { back: vi.fn() },
): void {
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
}

// Readers built outside the TestBed's component lifecycle. Each spec destroys them after every test
// so no render frame or save timer outlives it.
const constructedReaders: ReaderComponent[] = [];

export function destroyConstructedReaders(): void {
  for (const reader of constructedReaders.splice(0)) {
    if (Reflect.get(reader, 'destroyed')) continue;
    // Teardown must not save reader state, which would call the test's API stub again.
    Reflect.get(reader, 'loading').set(true);
    reader.ngOnDestroy();
  }
  vi.unstubAllGlobals();
}

export function createReaderComponent(
  api: object = {},
  router: object = { navigate: vi.fn() },
  location: object = { back: vi.fn() },
): ReaderComponent {
  configureReaderTestBed(api, router, location);
  const reader = TestBed.runInInjectionContext(() => new ReaderComponent());
  constructedReaders.push(reader);
  return reader;
}

/**
 * Mounts the reader through the TestBed, so its real template and styles are in the document and
 * the TestBed destroys it. Page rendering is stubbed out; the canvases stay empty.
 */
export function mountReader(api: object = { piece: () => NEVER, readerState: () => NEVER }) {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      disconnect(): void {}
    },
  );
  configureReaderTestBed(api);
  const fixture = TestBed.createComponent(ReaderComponent);
  Reflect.set(fixture.componentInstance, 'scheduleRender', () => undefined);
  return fixture;
}

/** The canvases the reader shows, with the CSS the browser would clip and place them by. */
export function shownCanvases(root: HTMLElement) {
  return Array.from(root.querySelectorAll('canvas')).map((canvas) => {
    const style = getComputedStyle(canvas);
    return { page: canvas.dataset['page'], clipPath: style.clipPath, gridArea: style.gridArea };
  });
}

export function spyOnCanvasPublishing(canvas: HTMLCanvasElement) {
  const drawImage = vi.fn();
  vi.spyOn(canvas, 'getContext').mockReturnValue({
    drawImage,
  } as unknown as CanvasRenderingContext2D);
  return drawImage;
}

/** The renderer's `renderVisible`, bound so a test can start several renders by hand. */
export function renderVisibleOf(component: ReaderComponent): () => Promise<void> {
  const renderer = Reflect.get(component, 'renderer');
  return () => renderer.renderVisible();
}

export function renderedPageOf(component: ReaderComponent) {
  return Reflect.get(Reflect.get(component, 'renderer'), 'renderedPage');
}

export function renderedWidthsOf(component: ReaderComponent): Map<number, number> {
  return Reflect.get(Reflect.get(component, 'renderer'), 'renderedWidths');
}

export function saveReaderStateNow(component: ReaderComponent): void {
  Reflect.get(component, 'readerState').saveNow();
}

export function readerStateBlocked(component: ReaderComponent): boolean {
  return Reflect.get(component, 'readerState').isBlocked;
}

export function layoutOf(component: ReaderComponent) {
  return Reflect.get(component, 'layout');
}

export function chromeOf(component: ReaderComponent) {
  return Reflect.get(component, 'chrome');
}
