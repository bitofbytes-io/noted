import { ElementRef, QueryList } from '@angular/core';
import { ReaderMode } from '../../core/models';
import { PdfDocument } from './pdf-document.service';
import { halfTurnShift, spreadGap } from './reader.utils';

export interface ReaderRenderHost {
  stage(): HTMLElement;
  canvases(): QueryList<ElementRef<HTMLCanvasElement>> | undefined;
  scrollPages(): QueryList<ElementRef<HTMLElement>>;
  mode(): ReaderMode;
  zoom(): number;
  visiblePages(): number[];
  halfShown(): boolean;
  setHalfShift(shift: number): void;
  /** Asks for another render, for a request that changed while this one was running. */
  requestRender(): void;
}

interface PageBox {
  width: number;
  height: number;
  key: number;
}

interface ScrollRenderRequest {
  width: number;
  canvas: HTMLCanvasElement;
  generation: number;
  settled: boolean;
}

/**
 * Draws the pages the reader shows onto its canvases: the visible page or spread in page mode, and
 * the pages near the viewport in scroll mode. It remembers what is drawn so repeats are skipped.
 */
export class ReaderRenderer {
  private renderedPage?: { pageNumber: number; span: number; columns: number; key: number };
  private renderedWidths = new Map<number, number>();
  private pageRenderInFlight = false;
  private pageRenderPending = false;
  private generation = 0;
  private scrollRenderRequests = new Map<number, ScrollRenderRequest>();

  constructor(
    private readonly pdf: PdfDocument,
    private readonly host: ReaderRenderHost,
  ) {}

  /** Drops everything drawn and abandons renders in flight, after a resize, zoom or reload. */
  reset(): void {
    this.generation++;
    this.scrollRenderRequests.clear();
    this.renderedPage = undefined;
    this.renderedWidths.clear();
  }

  /** Draws the shown pages again next time, as when the layout changes under the same pages. */
  forgetPage(): void {
    this.renderedPage = undefined;
  }

  /** Blanks the page-mode canvases so a stale page never shows while the next one draws. */
  clearVisiblePage(): void {
    this.renderedPage = undefined;
    this.host.setHalfShift(0);
    if (this.host.mode() !== 'page') return;
    this.host.canvases()?.forEach(({ nativeElement: canvas }) => {
      if (!canvas.width && !canvas.height) return;
      canvas.width = 0;
      canvas.height = 0;
    });
  }

  async renderVisible(): Promise<void> {
    if (!this.host.canvases()?.length) return;
    if (this.host.mode() === 'page') await this.renderPageMode();
    else await this.renderScrollMode();
  }

  private async renderPageMode(): Promise<void> {
    const { host } = this;
    if (this.pageRenderInFlight) {
      this.pageRenderPending = true;
      return;
    }
    const pageNumbers = host.visiblePages();
    const targets = host
      .canvases()!
      .toArray()
      .map((canvas) => canvas.nativeElement);
    // The canvases follow the pages after change detection, which schedules another render.
    if (targets.length !== pageNumbers.length) return;
    // A half turn and a spread show the same page numbers, but size them for different columns.
    const columns = this.pageColumns();
    const box = this.pageBox(columns);
    const generation = this.generation;
    if (
      this.renderedPage?.pageNumber === pageNumbers[0] &&
      this.renderedPage.span === pageNumbers.length &&
      this.renderedPage.columns === columns &&
      this.renderedPage.key === box.key
    )
      return;
    const renderCanvases = pageNumbers.map(() => document.createElement('canvas'));
    this.pageRenderInFlight = true;
    this.pageRenderPending = false;
    this.clearVisiblePage();
    try {
      await Promise.all(
        pageNumbers.map((pageNumber, index) =>
          this.pdf.renderPage(renderCanvases[index], pageNumber, box.width, box.height),
        ),
      );
      const current = host.canvases();
      if (
        this.generation === generation &&
        host.mode() === 'page' &&
        this.pageColumns() === columns &&
        this.pageBox(columns).key === box.key &&
        host.visiblePages().join() === pageNumbers.join() &&
        current?.length === targets.length &&
        current.toArray().every((canvas, index) => canvas.nativeElement === targets[index])
      ) {
        targets.forEach((canvas, index) => {
          const renderCanvas = renderCanvases[index];
          canvas.width = renderCanvas.width;
          canvas.height = renderCanvas.height;
          canvas.style.width = renderCanvas.style.width;
          canvas.style.height = renderCanvas.style.height;
          const context = canvas.getContext('2d');
          if (!context) throw new Error('Canvas rendering is unavailable.');
          context.drawImage(renderCanvas, 0, 0);
        });
        host.setHalfShift(host.halfShown() ? halfTurnShift(renderCanvases) : 0);
        this.renderedPage = {
          pageNumber: pageNumbers[0],
          span: pageNumbers.length,
          columns,
          key: box.key,
        };
      }
    } finally {
      // Safari counts canvas backing stores against a memory budget until they are collected.
      renderCanvases.forEach((canvas) => {
        canvas.width = 0;
        canvas.height = 0;
      });
      this.pageRenderInFlight = false;
      const requestChanged =
        this.generation !== generation ||
        host.mode() !== 'page' ||
        host.visiblePages().join() !== pageNumbers.join() ||
        this.pageColumns() !== columns ||
        this.pageBox(columns).key !== box.key;
      if (this.pageRenderPending || requestChanged) {
        this.pageRenderPending = false;
        host.requestRender();
      }
    }
  }

  private async renderScrollMode(): Promise<void> {
    const { host } = this;
    const stageRect = host.stage().getBoundingClientRect();
    const pages = host.scrollPages().toArray();
    const canvases = host.canvases()!.toArray();
    const pending: Promise<void>[] = [];
    pages.forEach((page, index) => {
      const rect = page.nativeElement.getBoundingClientRect();
      const canvas = canvases[index]?.nativeElement;
      if (!canvas) return;
      const nearby =
        rect.bottom >= stageRect.top - stageRect.height &&
        rect.top <= stageRect.bottom + stageRect.height;
      const pageNumber = index + 1;
      if (!nearby) {
        const retained =
          rect.bottom >= stageRect.top - stageRect.height * 2 &&
          rect.top <= stageRect.bottom + stageRect.height * 2;
        if (!retained) {
          if (canvas.width || canvas.height) {
            canvas.width = 0;
            canvas.height = 0;
          }
          this.renderedWidths.delete(pageNumber);
          this.scrollRenderRequests.delete(pageNumber);
        }
        return;
      }
      const width = Math.round(page.nativeElement.clientWidth);
      if (this.renderedWidths.get(pageNumber) === width) return;
      const generation = this.generation;
      const active = this.scrollRenderRequests.get(pageNumber);
      // Scroll refreshes outpace slow pages; restarting would starve them, so let it finish.
      if (
        active &&
        !active.settled &&
        active.width === width &&
        active.canvas === canvas &&
        active.generation === generation
      )
        return;
      const request: ScrollRenderRequest = { width, canvas, generation, settled: false };
      this.scrollRenderRequests.set(pageNumber, request);
      const forgetFailedRequest = (error: unknown) => {
        request.settled = true;
        if (this.scrollRenderRequests.get(pageNumber) === request)
          this.scrollRenderRequests.delete(pageNumber);
        throw error;
      };
      pending.push(
        this.pdf.renderPage(canvas, pageNumber, width).then(() => {
          request.settled = true;
          const currentStageRect = host.stage().getBoundingClientRect();
          const currentRect = page.nativeElement.getBoundingClientRect();
          const retained =
            currentRect.bottom >= currentStageRect.top - currentStageRect.height * 2 &&
            currentRect.top <= currentStageRect.bottom + currentStageRect.height * 2;
          const activeRequest = this.scrollRenderRequests.get(pageNumber);
          const requestIsCurrent = activeRequest === request;
          const pageIsCurrent = host.scrollPages().get(index)?.nativeElement === page.nativeElement;
          const currentCanvas = host.canvases()?.get(index)?.nativeElement;
          const canvasIsCurrent = currentCanvas === canvas;
          if (
            this.generation === generation &&
            host.mode() === 'scroll' &&
            requestIsCurrent &&
            pageIsCurrent &&
            canvasIsCurrent &&
            Math.round(page.nativeElement.clientWidth) === width &&
            retained
          ) {
            this.renderedWidths.set(pageNumber, width);
          } else {
            const newerRequestOwnsCanvas =
              canvasIsCurrent && activeRequest !== undefined && activeRequest !== request;
            if (!newerRequestOwnsCanvas) {
              canvas.width = 0;
              canvas.height = 0;
            }
            if (requestIsCurrent) {
              this.renderedWidths.delete(pageNumber);
              this.scrollRenderRequests.delete(pageNumber);
            }
          }
        }, forgetFailedRequest),
      );
    });
    await Promise.all(pending);
  }

  /** How many pages sit side by side; the two halves of a half turn share one page's place. */
  private pageColumns(): number {
    return this.host.halfShown() ? 1 : this.host.visiblePages().length;
  }

  /** The size each of `count` side-by-side pages may take, and the key identifying it. */
  private pageBox(count: number): PageBox {
    const stage = this.host.stage();
    const width = Math.max(
      240,
      ((stage.clientWidth - 24 - spreadGap * (count - 1)) / count) * this.host.zoom(),
    );
    const height = Math.max(240, (stage.clientHeight - 24) * this.host.zoom());
    return { width, height, key: Math.round(Math.min(width, height)) };
  }
}
