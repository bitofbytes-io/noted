import { describe, expect, it, vi } from 'vitest';
import { PdfDocument } from './pdf-document.service';

function fakeDocument() {
  const renders: { finish: () => void; cancel: ReturnType<typeof vi.fn> }[] = [];
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({ width: 100 * scale, height: 200 * scale }),
    render: vi.fn(() => {
      let finish!: () => void;
      let fail!: (error: Error) => void;
      const promise = new Promise<void>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      });
      const cancel = vi.fn(() => {
        const error = new Error('cancelled');
        error.name = 'RenderingCancelledException';
        fail(error);
      });
      renders.push({ finish, cancel });
      return { promise, cancel };
    }),
    cleanup: vi.fn(),
  };
  return { renders, page, document: { numPages: 2, getPage: vi.fn(async () => page) } };
}

function canvas(): HTMLCanvasElement {
  const element = document.createElement('canvas');
  vi.spyOn(element, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
  return element;
}

describe('PdfDocument', () => {
  it('shares an identical in-flight render instead of restarting it', async () => {
    const pdf = new PdfDocument();
    const fake = fakeDocument();
    Reflect.set(pdf, 'document', fake.document);
    const target = canvas();

    const first = pdf.renderPage(target, 1, 300);
    const repeated = pdf.renderPage(target, 1, 300);
    expect(repeated).toBe(first);
    await vi.waitFor(() => expect(fake.renders).toHaveLength(1));
    expect(pdf.renderPage(target, 1, 300)).toBe(first);

    fake.renders[0].finish();
    await first;
    expect(fake.renders[0].cancel).not.toHaveBeenCalled();
    expect(fake.page.render).toHaveBeenCalledTimes(1);
    expect(target.width).toBeGreaterThan(0);
  });

  it('cancels an in-flight render only when the requested output changes', async () => {
    const pdf = new PdfDocument();
    const fake = fakeDocument();
    Reflect.set(pdf, 'document', fake.document);
    const target = canvas();

    const narrow = pdf.renderPage(target, 1, 300);
    await vi.waitFor(() => expect(fake.renders).toHaveLength(1));
    const wide = pdf.renderPage(target, 1, 400);
    expect(wide).not.toBe(narrow);
    expect(fake.renders[0].cancel).toHaveBeenCalled();
    await narrow;
    await vi.waitFor(() => expect(fake.renders).toHaveLength(2));
    fake.renders[1].finish();
    await wide;

    // The reload of a document never shares work started for the previous one.
    await pdf.dispose();
    Reflect.set(pdf, 'document', fake.document);
    const reloaded = pdf.renderPage(target, 1, 400);
    await vi.waitFor(() => expect(fake.renders).toHaveLength(3));
    fake.renders[2].finish();
    await reloaded;
  });
});
