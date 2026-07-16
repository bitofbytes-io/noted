import {
  GlobalWorkerOptions,
  getDocument,
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
  RenderTask,
} from 'pdfjs-dist';

GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';

export type PdfFitMode = 'width' | 'page';
type DocumentLoader = (source: Parameters<typeof getDocument>[0]) => PDFDocumentLoadingTask;

export class PdfScoreAdapter {
  private document?: PDFDocumentProxy;
  private loadingTask?: PDFDocumentLoadingTask;
  private renderTask?: RenderTask;
  private renderRequest = 0;

  constructor(private readonly documentLoader: DocumentLoader = getDocument) {}

  get pageCount(): number {
    return this.document?.numPages ?? 0;
  }

  async load(url: string): Promise<number> {
    await this.dispose();
    this.loadingTask = this.documentLoader({ url, wasmUrl: '/pdfjs/wasm/' });
    this.document = await this.loadingTask.promise;
    return this.document.numPages;
  }

  async render(
    canvas: HTMLCanvasElement,
    pageNumber: number,
    mode: PdfFitMode,
    availableWidth: number,
    availableHeight: number,
    zoom = 1,
  ): Promise<void> {
    if (!this.document) throw new Error('PDF is not loaded');
    const request = ++this.renderRequest;
    const page: PDFPageProxy = await this.document.getPage(pageNumber);
    if (request !== this.renderRequest) return;
    const base = page.getViewport({ scale: 1 });
    const widthScale = Math.max(0.25, (availableWidth - 28) / base.width);
    const heightScale = Math.max(0.25, (availableHeight - 28) / base.height);
    const fitScale = mode === 'width' ? widthScale : Math.min(widthScale, heightScale);
    const scale = fitScale * Math.min(2, Math.max(0.75, zoom));
    const viewport = page.getViewport({ scale });
    const outputScale = window.devicePixelRatio || 1;
    await this.cancelRender();
    if (request !== this.renderRequest) return;
    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas rendering is unavailable');
    const task = page.render({
      canvas,
      canvasContext: context,
      viewport,
      transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
    });
    this.renderTask = task;
    try {
      await task.promise;
    } catch (error) {
      if (request === this.renderRequest && !isRenderCancellation(error)) throw error;
    } finally {
      if (this.renderTask === task) this.renderTask = undefined;
    }
  }

  async dispose(): Promise<void> {
    this.renderRequest += 1;
    await this.cancelRender();
    if (this.loadingTask) await this.loadingTask.destroy();
    this.loadingTask = undefined;
    this.document = undefined;
  }

  private async cancelRender(): Promise<void> {
    const task = this.renderTask;
    if (!task) return;
    task.cancel();
    try {
      await task.promise;
    } catch (error) {
      if (!isRenderCancellation(error)) throw error;
    } finally {
      if (this.renderTask === task) this.renderTask = undefined;
    }
  }
}

function isRenderCancellation(error: unknown): boolean {
  return error instanceof Error && error.name === 'RenderingCancelledException';
}
