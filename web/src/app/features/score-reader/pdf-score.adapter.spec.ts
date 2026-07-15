import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
  RenderTask,
} from 'pdfjs-dist';
import { vi } from 'vitest';
import { PdfScoreAdapter } from './pdf-score.adapter';

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(),
}));

interface DeferredRender {
  task: RenderTask;
  cancel: ReturnType<typeof vi.fn>;
  resolve: () => void;
  reject: (error: Error) => void;
}

function deferredRender(): DeferredRender {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  const cancel = vi.fn();
  return {
    task: { promise, cancel } as unknown as RenderTask,
    cancel,
    resolve,
    reject,
  };
}

describe('PdfScoreAdapter rendering', () => {
  it('waits for a canceled render to settle before reusing the canvas', async () => {
    const renders = [deferredRender(), deferredRender()];
    let renderIndex = 0;
    const page = {
      getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
      render: vi.fn(() => renders[renderIndex++].task),
    } as unknown as PDFPageProxy;
    const pdfDocument = {
      numPages: 1,
      getPage: vi.fn(async () => page),
    } as unknown as PDFDocumentProxy;
    const loadingTask = {
      promise: Promise.resolve(pdfDocument),
      destroy: vi.fn(async () => undefined),
    } as unknown as PDFDocumentLoadingTask;
    const adapter = new PdfScoreAdapter(() => loadingTask);
    const canvas = document.createElement('canvas');
    Object.defineProperty(canvas, 'getContext', {
      value: vi.fn(() => ({}) as CanvasRenderingContext2D),
    });
    await adapter.load('/api/assets/pdf/content');

    const first = adapter.render(canvas, 1, 'width', 700, 900);
    await Promise.resolve();
    await Promise.resolve();
    expect(page.render).toHaveBeenCalledTimes(1);

    const second = adapter.render(canvas, 1, 'page', 700, 900);
    await Promise.resolve();
    await Promise.resolve();
    expect(renders[0].cancel).toHaveBeenCalledOnce();
    expect(page.render).toHaveBeenCalledTimes(1);

    const cancellation = new Error('Rendering cancelled');
    cancellation.name = 'RenderingCancelledException';
    renders[0].reject(cancellation);
    await first;
    await Promise.resolve();
    await Promise.resolve();
    expect(page.render).toHaveBeenCalledTimes(2);

    renders[1].resolve();
    await second;
    await adapter.dispose();
  });
});
