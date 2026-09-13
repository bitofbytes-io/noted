import { test, expect, Page, APIRequestContext } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PDFDocument, rgb } from 'pdf-lib';

test.skip(!process.env['NOTED_E2E_REAL_API'], 'Requires the private API and PostgreSQL.');
const fixture = resolve('../testdata/fixtures/noted-exercise.pdf');
async function upload(
  request: APIRequestContext,
  buffer: Buffer,
  name = 'score.pdf',
  mimeType = 'application/pdf',
) {
  let d = await (await request.post('/api/imports/', { data: {} })).json();
  d = await (
    await request.post(`/api/imports/${d.id}/sources`, {
      multipart: { revision: String(d.revision), file: { name, mimeType, buffer } },
    })
  ).json();
  return d;
}
async function worker(page: Page, d: any, edits: any[]) {
  return page.evaluate(
    async ({ d, edits }) => {
      const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
        const w = new Worker('/intake/processing-worker.js');
        w.onmessage = ({ data }) => {
          if (data.error) {
            w.terminate();
            reject(Error(data.error));
          } else if (data.bytes) {
            w.terminate();
            resolve(data.bytes);
          }
        };
        w.postMessage({
          kind: 'build',
          draftId: d.id,
          sources: d.sources,
          manifest: { version: 1, pages: edits },
        });
      });
      // @ts-ignore shipped PDF.js display module
      const pdfjs = await import('/pdfjs/pdf.min.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';
      const task = pdfjs.getDocument({
        data: new Uint8Array(bytes.slice(0)),
        wasmUrl: '/pdfjs/wasm/',
      });
      const doc = await task.promise,
        results = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const p = await doc.getPage(i),
          v = p.getViewport({ scale: 1 }),
          canvas = document.createElement('canvas');
        canvas.width = Math.ceil(v.width);
        canvas.height = Math.ceil(v.height);
        const ctx = canvas.getContext('2d')!;
        await p.render({ canvas, canvasContext: ctx, viewport: v }).promise;
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        const pixel = (x: number, y: number) =>
          Array.from(pixels.slice((y * canvas.width + x) * 4, (y * canvas.width + x) * 4 + 3));
        let l = canvas.width,
          t = canvas.height,
          r = 0,
          b = 0;
        for (let y = 0; y < canvas.height; y++)
          for (let x = 0; x < canvas.width; x++) {
            const n = (y * canvas.width + x) * 4;
            if (pixels[n] > 180 && pixels[n + 1] < 120 && pixels[n + 2] < 120) {
              l = Math.min(l, x);
              r = Math.max(r, x);
              t = Math.min(t, y);
              b = Math.max(b, y);
            }
          }
        const ops = await p.getOperatorList();
        results.push({
          width: v.width,
          height: v.height,
          redBounds: [l, t, r + 1, b + 1],
          corners: [
            pixel(1, 1),
            pixel(canvas.width - 2, 1),
            pixel(canvas.width - 2, canvas.height - 2),
            pixel(1, canvas.height - 2),
          ],
          center: pixel(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2)),
          images: ops.fnArray.filter(
            (n: number) =>
              n === pdfjs.OPS.paintImageXObject || n === pdfjs.OPS.paintInlineImageXObject,
          ).length,
        });
        canvas.width = canvas.height = 1;
      }
      await task.destroy();
      return { bytes: bytes.byteLength, pages: results };
    },
    { d, edits },
  );
}

test('edge fitting preserves vector crop, zero borders, asymmetric margins and rotated bounds', async ({
  page,
  request,
}) => {
  const pdf = await PDFDocument.create(),
    p = pdf.addPage([400, 600]);
  p.drawRectangle({ x: 0, y: 0, width: 400, height: 600, color: rgb(0.9, 0.1, 0.1) });
  p.drawText('Original CC0 vector artwork', { x: 50, y: 300, size: 15 });
  const d = await upload(request, Buffer.from(await pdf.save()));
  try {
    await page.goto('/');
    const base = { ...d.manifest.pages[0], fitEdges: true, crop: [0.1, 0.2, 0.9, 0.8] };
    const result = await worker(page, d, [
      base,
      { ...base, id: crypto.randomUUID(), margins: [10, 20, 30, 40] },
      { ...base, id: crypto.randomUUID(), angle: 10, rotation: 90 },
    ]);
    const [zero, margin, rotated] = result.pages;
    expect(zero.width).toBeCloseTo(320, 5);
    expect(zero.height).toBeCloseTo(360, 5);
    expect(zero.images).toBe(0);
    for (const c of zero.corners) {
      expect(c[0]).toBeGreaterThan(180);
      expect(c[1]).toBeLessThan(120);
    }
    expect(margin.width).toBeCloseTo(380, 5);
    expect(margin.height).toBeCloseTo(400, 5);
    expect(margin.redBounds).toEqual([40, 10, 360, 370]);
    for (const c of margin.corners) expect(Math.min(...c)).toBeGreaterThan(245);
    const r = (100 * Math.PI) / 180;
    expect(rotated.width).toBeCloseTo(Math.abs(320 * Math.cos(r)) + Math.abs(360 * Math.sin(r)), 4);
    expect(rotated.height).toBeCloseTo(
      Math.abs(320 * Math.sin(r)) + Math.abs(360 * Math.cos(r)),
      4,
    );
  } finally {
    await request.delete(`/api/imports/${d.id}/`);
  }
});

test('photo edges use selected natural aspect and cleanup strength blends without PNG expansion', async ({
  page,
  request,
}) => {
  await page.goto('/');
  const image = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 400;
    c.height = 600;
    const x = c.getContext('2d')!;
    x.fillStyle = 'rgb(180,180,180)';
    x.fillRect(0, 0, 400, 600);
    x.fillStyle = 'rgb(220,30,30)';
    x.fillRect(42, 122, 316, 6);
    x.fillRect(42, 472, 316, 6);
    return c.toDataURL('image/jpeg', 0.98).split(',')[1];
  });
  const d = await upload(request, Buffer.from(image, 'base64'), 'cc0-paper.jpg', 'image/jpeg');
  try {
    const base = {
      ...d.manifest.pages[0],
      fitEdges: true,
      corners: [
        [0.1, 0.2],
        [0.9, 0.2],
        [0.9, 0.8],
        [0.1, 0.8],
      ],
    };
    const result = await worker(page, d, [
      { ...base, paperCleanup: true, paperCleanupStrength: 0 },
      { ...base, id: crypto.randomUUID(), paperCleanupStrength: 0.5 },
      { ...base, id: crypto.randomUUID(), paperCleanup: true },
      { ...base, id: crypto.randomUUID(), paperCleanupStrength: 1 },
    ]);
    for (const p of result.pages) {
      expect(p.width / p.height).toBeCloseTo((0.8 * 399) / (0.6 * 599), 2);
      expect(p.redBounds[2] - p.redBounds[0]).toBeGreaterThan(570);
    }
    const levels = result.pages.map((p) => p.center[0]);
    expect(levels[0]).toBeCloseTo(180, 0);
    expect(levels[2]).toBeGreaterThan(248);
    expect(Math.abs(levels[1] - (levels[0] + levels[2]) / 2)).toBeLessThan(4);
    expect(levels[3]).toBe(levels[2]);
    expect(result.bytes).toBeLessThan(500000);
  } finally {
    await request.delete(`/api/imports/${d.id}/`);
  }
});

test('edge editor keeps pending changes local, constrains handles, applies once and restores legacy on Undo', async ({
  page,
  request,
}) => {
  let d = await upload(
    request,
    await readFile(resolve('../testdata/fixtures/noted-photo-exif-6.jpg')),
    'photo.jpg',
    'image/jpeg',
  );
  try {
    d.manifest.pages[0] = {
      ...d.manifest.pages[0],
      corners: [
        [0.05, 0.05],
        [0.95, 0.05],
        [0.95, 0.95],
        [0.05, 0.95],
      ],
      crop: [0.03, 0.03, 0.97, 0.97],
      scale: 0.9,
      x: 0.01,
      outputWidth: 600,
      outputHeight: 800,
    };
    d = await (
      await request.patch(`/api/imports/${d.id}/`, {
        data: { revision: d.revision, metadata: d.metadata, manifest: d.manifest },
      })
    ).json();
    const legacy = JSON.stringify(d.manifest);
    await page.goto(`/prepare/${d.id}`);
    await expect(page.locator('.page-surface img')).toBeVisible();
    await page.getByRole('button', { name: 'Adjust page edges', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Apply edges', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(
      JSON.stringify((await (await request.get(`/api/imports/${d.id}/`)).json()).manifest),
    ).toBe(legacy);
    await page.getByRole('button', { name: 'Adjust page edges', exact: true }).click();
    await page.getByRole('button', { name: 'Start edges from original' }).click();
    const handle = page.getByRole('button', { name: 'Adjust corner 1 with arrow keys or drag' });
    await expect(handle).toBeEnabled();
    await expect(page.locator('.edge-overlay polygon')).toBeVisible();
    await handle.evaluate((el) => {
      for (let i = 0; i < 120; i++)
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    const outline = await page.locator('.edge-overlay polygon').getAttribute('points');
    expect(Number(outline!.split(',')[0])).toBeLessThan(96);
    const bounds = await handle.boundingBox();
    expect(bounds!.width).toBe(44);
    expect(bounds!.height).toBe(44);
    const drag = page.getByRole('button', { name: 'Adjust corner 4 with arrow keys or drag' });
    await drag.scrollIntoViewIfNeeded();
    const hit = await drag.boundingBox(),
      surface = await page.locator('.page-surface img').boundingBox();
    const beforeDrag = await page.locator('.edge-overlay polygon').getAttribute('points');
    await page.mouse.move(hit!.x + 22, hit!.y + 22);
    await page.mouse.down();
    await page.mouse.move(
      hit!.x + 22 + surface!.width * 0.03,
      hit!.y + 22 - surface!.height * 0.03,
    );
    await expect(page.locator('.edge-overlay polygon')).not.toHaveAttribute('points', beforeDrag!);
    await drag.dispatchEvent('pointercancel');
    const cancelled = await page.locator('.edge-overlay polygon').getAttribute('points');
    await page.mouse.move(
      hit!.x + 22 + surface!.width * 0.08,
      hit!.y + 22 - surface!.height * 0.08,
    );
    await page.mouse.up();
    await expect(page.locator('.edge-overlay polygon')).toHaveAttribute('points', cancelled!);
    expect(
      JSON.stringify((await (await request.get(`/api/imports/${d.id}/`)).json()).manifest),
    ).toBe(legacy);
    await page.getByRole('button', { name: 'Apply edges', exact: true }).click();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await page.getByRole('button', { name: 'Save draft & close' }).click();
    await expect(page).toHaveURL(/\/$/);
    expect(
      JSON.stringify((await (await request.get(`/api/imports/${d.id}/`)).json()).manifest),
    ).toBe(legacy);
  } finally {
    await request.delete(`/api/imports/${d.id}/`);
  }
});

test('IMSLP PDF pages remove, reorder and extract with source and metadata retained; margins persist and undo', async ({
  page,
  request,
}) => {
  let d = await upload(request, await readFile(fixture));
  try {
    const source = d.sources[0].id,
      checksum = d.sources[0].checksum,
      url = 'https://imslp.org/wiki/Sonata_(Beethoven,_Ludwig_van)';
    d.metadata.sourceUrl = url;
    d.metadata.title = 'Edition review';
    d = await (
      await request.patch(`/api/imports/${d.id}/`, {
        data: { revision: d.revision, metadata: d.metadata, manifest: d.manifest },
      })
    ).json();
    await page.goto(`/prepare/${d.id}`);
    await expect(page.locator('.page-surface img')).toBeVisible();
    await page.getByRole('button', { name: 'Remove from this copy', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Preview page 2' })).not.toBeVisible();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await page.getByRole('button', { name: 'Move page later' }).click();
    await expect(page.locator('.thumbnail.active button')).toHaveAttribute(
      'aria-label',
      'Preview page 2',
    );
    await page.getByLabel('Select page 1', { exact: true }).check();
    await page.getByRole('button', { name: 'Keep selected only' }).click();
    await page.getByText('Margins · optional', { exact: true }).click();
    await page.getByLabel('Left margin in millimetres').fill('10');
    await page.getByLabel('Left margin in millimetres').blur();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.getByLabel('Left margin in millimetres')).toHaveValue('0');
    await page.getByLabel('Top margin in millimetres').fill('5');
    await page.getByLabel('Top margin in millimetres').blur();
    await page.getByRole('button', { name: 'Save draft & close' }).click();
    await expect(page).toHaveURL(/\/$/);
    const saved = await (await request.get(`/api/imports/${d.id}/`)).json();
    expect(saved.metadata.sourceUrl).toBe(url);
    expect(saved.metadata.title).toBe('Edition review');
    expect(saved.manifest.pages).toHaveLength(1);
    expect(saved.manifest.pages[0].page).toBe(1);
    expect(saved.manifest.pages[0].margins[0]).toBeCloseTo((5 * 72) / 25.4);
    expect(saved.sources[0].checksum).toBe(checksum);
    const original = await request.get(`/api/imports/${d.id}/sources/${source}`);
    expect(await original.body()).toEqual(await readFile(fixture));
    await page.goto(`/prepare/${d.id}`);
    await page.getByText('Margins · optional', { exact: true }).click();
    await expect(page.getByLabel('Top margin in millimetres')).toHaveValue('5');
  } finally {
    await request.delete(`/api/imports/${d.id}/`);
  }
});

test('library actions are labelled and contained on touch layouts without opening the reader', async ({
  page,
  request,
}, testInfo) => {
  const title = 'Controls label review ' + crypto.randomUUID();
  const created = await request.post('/api/pieces/', {
    data: {
      title,
      composer: 'Original fixture',
      favorite: false,
      sourceUrl: '',
      listeningUrl: '',
      notes: '',
    },
  });
  expect(created.ok()).toBeTruthy();
  const piece = await created.json();
  let draftId: string | undefined;
  try {
    await page.goto('/');
    const row = page.locator('.piece-row').filter({ has: page.getByText(title, { exact: true }) });
    await row.getByRole('button', { name: 'Edit details', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    const favorite = row.getByRole('button', { name: 'Add to favorites' });
    await favorite.click();
    await expect(
      row.getByRole('button', { name: 'Remove from favorites' }).locator('svg'),
    ).toHaveClass(/filled-heart/);
    await expect(page).toHaveURL(/\/$/);
    for (const label of ['Edit pages', 'Edit details']) {
      const b = await row.getByRole('button', { name: label, exact: true }).boundingBox();
      expect(b!.width).toBeGreaterThan(70);
      expect(b!.height).toBeGreaterThanOrEqual(44);
      expect(b!.x + b!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    }
    const rowBox = await row.boundingBox(),
      markBox = await row.locator('.piece-mark').boundingBox();
    expect(markBox!.x - rowBox!.x).toBeGreaterThanOrEqual(12);
    const detailBox = await row
      .getByRole('button', { name: 'Edit details', exact: true })
      .boundingBox();
    expect(rowBox!.x + rowBox!.width - (detailBox!.x + detailBox!.width)).toBeGreaterThanOrEqual(
      12,
    );
    await row.hover();
    await page.screenshot({ path: testInfo.outputPath('library-row-hover.png'), fullPage: true });
    await row.getByRole('button', { name: 'Edit pages', exact: true }).focus();
    await page.keyboard.press('Tab');
    const detailsButton = row.getByRole('button', { name: 'Edit details', exact: true });
    await detailsButton.focus();
    await expect(detailsButton).toBeFocused();
    await expect(detailsButton).toHaveJSProperty('tabIndex', 0);
    expect(await detailsButton.evaluate((element) => element.matches(':focus-visible'))).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('library-row-focus.png'), fullPage: true });
    await row.getByRole('button', { name: 'Edit pages', exact: true }).click();
    await expect(page).toHaveURL(/prepare\//);
    draftId = new URL(page.url()).pathname.split('/').at(-1);
    await expect(page.getByRole('heading', { name: 'Add a score' })).toBeVisible();
  } finally {
    if (draftId) await request.delete(`/api/imports/${draftId}/`);
    await request.delete(`/api/pieces/${piece.id}/`);
  }
});

test('Shift drag anchors a rectangle, releasing Shift restores free corners, and Apply persists it', async ({
  page,
  request,
}) => {
  const d = await upload(
    request,
    await readFile(resolve('../testdata/fixtures/noted-photo-exif-6.jpg')),
    'photo.jpg',
    'image/jpeg',
  );
  try {
    await page.goto(`/prepare/${d.id}`);
    await expect(page.locator('.page-surface img')).toBeVisible();
    await page.getByRole('button', { name: 'Adjust page edges', exact: true }).click();
    const handle = page.getByRole('button', { name: 'Adjust corner 1 with arrow keys or drag' });
    await expect(handle).toBeEnabled();
    await handle.scrollIntoViewIfNeeded();
    const rect = await page.locator('.page-surface img').boundingBox(),
      box = await handle.boundingBox();
    const points = async () =>
      (await page.locator('.edge-overlay polygon').getAttribute('points'))!
        .split(' ')
        .map((p) => p.split(',').map(Number));
    const expectRectangle = (p: number[][]) => {
      expect(p[0][1]).toBeCloseTo(p[1][1], 6);
      expect(p[1][0]).toBeCloseTo(p[2][0], 6);
      expect(p[2][1]).toBeCloseTo(p[3][1], 6);
      expect(p[3][0]).toBeCloseTo(p[0][0], 6);
    };
    await page.mouse.move(box!.x + 22, box!.y + 22);
    await page.mouse.down();
    await page.keyboard.down('Shift');
    await page.mouse.move(rect!.x + rect!.width * 0.08, rect!.y + rect!.height * 0.1);
    expectRectangle(await points());
    expect((await points())[2]).toEqual([100, 100]);
    await page.keyboard.up('Shift');
    await page.mouse.move(rect!.x + rect!.width * 0.12, rect!.y + rect!.height * 0.15);
    const free = await points();
    expect(free[0][1]).toBeGreaterThan(free[1][1] + 2);
    await page.keyboard.down('Shift');
    await page.mouse.move(rect!.x + rect!.width * 0.16, rect!.y + rect!.height * 0.2);
    expectRectangle(await points());
    await page.mouse.up();
    await page.keyboard.up('Shift');
    await page.getByRole('button', { name: 'Apply edges', exact: true }).click();
    await page.getByRole('button', { name: 'Save draft & close' }).click();
    await expect(page).toHaveURL(/\/$/);
    const saved = await (await request.get(`/api/imports/${d.id}/`)).json();
    expectRectangle(saved.manifest.pages[0].corners);
    expect(saved.manifest.pages[0].corners[0][0]).toBeCloseTo(0.16, 1);
    expect(saved.manifest.pages[0].fitEdges).toBe(true);
  } finally {
    await page.keyboard.up('Shift');
    await page.mouse.up();
    await request.delete(`/api/imports/${d.id}/`);
  }
});

test('Back saves existing preparation to library while new scores and Details keep their step navigation', async ({
  page,
  request,
}) => {
  const d = await upload(request, await readFile(fixture));
  let existing: any, piece: any;
  try {
    await page.goto(`/prepare/${d.id}`);
    await expect(page.locator('.page-surface img')).toBeVisible();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Choose PDF', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Make it easy to find.' })).toBeVisible();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Adjust page edges', exact: true }),
    ).toBeVisible();
    const final = await request.post(`/api/imports/${d.id}/finalize`, {
      multipart: {
        revision: String(d.revision),
        file: { name: 'fixture.pdf', mimeType: 'application/pdf', buffer: await readFile(fixture) },
      },
    });
    expect(final.ok()).toBeTruthy();
    piece = await final.json();
    existing = await (await request.post('/api/imports/', { data: { pieceId: piece.id } })).json();
    await page.goto(`/prepare/${existing.id}`);
    await expect(page.locator('.page-surface img')).toBeVisible();
    await page.getByLabel('Angle in degrees').fill('2');
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    const saved = await (await request.get(`/api/imports/${existing.id}/`)).json();
    expect(saved.manifest.pages[0].angle).toBe(2);
    expect(saved.finalized).toBe(false);
    expect((await (await request.get(`/api/pieces/${piece.id}/`)).json()).pdf.checksumSha256).toBe(
      piece.pdf.checksumSha256,
    );
  } finally {
    if (existing) await request.delete(`/api/imports/${existing.id}/`);
    await request.delete(`/api/imports/${d.id}/`);
    if (piece) await request.delete(`/api/pieces/${piece.id}/`);
  }
});

test('rapid adjustments debounce to latest snapshot and immediately discard an in-flight stale preview', async ({
  page,
  request,
}) => {
  const d = await upload(
    request,
    await readFile(resolve('../testdata/fixtures/noted-photo-exif-6.jpg')),
    'photo.jpg',
    'image/jpeg',
  );
  await page.addInitScript(() => {
    const state = {
      builds: [] as any[],
      terminated: [] as number[],
      held: false,
      release: () => {},
    };
    (window as any).__previewProbe = state;
    const Native = window.Worker;
    window.Worker = class extends Native {
      intake: boolean;
      index = -1;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.intake = String(url).includes('/intake/processing-worker.js');
      }
      override postMessage(message: any, transfer?: any) {
        if (this.intake) {
          this.index = state.builds.length;
          state.builds.push(structuredClone(message));
        }
        super.postMessage(message, transfer);
      }
      override set onmessage(handler: ((this: Worker, event: MessageEvent) => any) | null) {
        super.onmessage = (event) => {
          if (this.intake && this.index === 0 && event.data.bytes) {
            state.held = true;
            state.release = () => handler?.call(this, event);
          } else handler?.call(this, event);
        };
      }
      override terminate() {
        if (this.intake && !state.terminated.includes(this.index))
          state.terminated.push(this.index);
        super.terminate();
      }
    };
  });
  try {
    await page.goto(`/prepare/${d.id}`);
    await expect(page.locator('.page-surface img')).toBeVisible();
    await page.getByLabel('Angle in degrees').fill('1');
    await expect.poll(() => page.evaluate(() => (window as any).__previewProbe.held)).toBe(true);
    await page.getByText('Margins · optional', { exact: true }).click();
    await page.evaluate(() => {
      const input = (label: string, value: string) => {
        const el = document.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const rotate = Array.from(document.querySelectorAll('button')).find(
        (b) => b.textContent?.trim() === 'Rotate 90°',
      )!;
      for (let i = 0; i < 3; i++) rotate.click();
      input('Angle in degrees', '2');
      input('Angle in degrees', '4');
      input('Left margin in millimetres', '3');
      input('Left margin in millimetres', '7');
      input('Lighten paper strength', '30');
      input('Lighten paper strength', '60');
    });
    expect(await page.evaluate(() => (window as any).__previewProbe.terminated)).toContain(0);
    await expect
      .poll(() => page.evaluate(() => (window as any).__previewProbe.builds.length))
      .toBe(2);
    await expect
      .poll(() => page.evaluate(() => (window as any).__previewProbe.terminated.includes(1)))
      .toBe(true);
    await expect(page.getByRole('status').filter({ hasText: 'Preparing' })).not.toBeVisible();
    const latest = await page.evaluate(
      () => (window as any).__previewProbe.builds[1].manifest.pages[0],
    );
    expect(latest.angle).toBe(4);
    expect(latest.rotation).toBe(270);
    expect(latest.paperCleanupStrength).toBe(0.6);
    expect(latest.margins[3]).toBeCloseTo((7 * 72) / 25.4);
    const image = page.locator('.page-surface img');
    await expect.poll(() => image.getAttribute('src')).not.toBeNull();
    const before = await image.getAttribute('src');
    await page.evaluate(() => (window as any).__previewProbe.release());
    await page.getByLabel('Angle in degrees').blur();
    await expect(image).toHaveAttribute('src', before!);
    await page.getByRole('button', { name: 'Save draft & close' }).click();
    await expect(page).toHaveURL(/\/$/);
    const saved = await (await request.get(`/api/imports/${d.id}/`)).json();
    expect(saved.manifest.pages[0]).toEqual(latest);
    expect(await page.evaluate(() => (window as any).__previewProbe.builds.length)).toBe(2);
  } finally {
    await request.delete(`/api/imports/${d.id}/`);
  }
});

test('Noted wordmark preserves pending edges and flushes normal changes before returning to library', async ({
  page,
  request,
}) => {
  const d = await upload(
    request,
    await readFile(resolve('../testdata/fixtures/noted-photo-exif-6.jpg')),
    'photo.jpg',
    'image/jpeg',
  );
  try {
    await page.goto(`/prepare/${d.id}`);
    await expect(page.locator('.page-surface img')).toBeVisible();
    await page.getByRole('button', { name: 'Adjust page edges', exact: true }).click();
    const corner = page.getByRole('button', { name: 'Adjust corner 1 with arrow keys or drag' });
    await expect(corner).toBeEnabled();
    const initialPolygon = await page.locator('.edge-overlay polygon').getAttribute('points');
    await corner.press('ArrowRight');
    await expect(page.locator('.edge-overlay polygon')).not.toHaveAttribute(
      'points',
      initialPolygon!,
    );
    const polygon = await page.locator('.edge-overlay polygon').getAttribute('points'),
      wordmark = page.getByRole('link', { name: 'Noted', exact: true });
    await expect(wordmark).toHaveAttribute('aria-disabled', 'true');
    await wordmark.scrollIntoViewIfNeeded();
    const box = await wordmark.boundingBox();
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await expect(page).toHaveURL(new RegExp(`/prepare/${d.id}$`));
    await wordmark.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/prepare/${d.id}$`));
    await expect(page.locator('.edge-overlay polygon')).toHaveAttribute('points', polygon!);
    expect((await (await request.get(`/api/imports/${d.id}/`)).json()).manifest).toEqual(
      d.manifest,
    );
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByLabel('Angle in degrees').fill('2');
    await expect(wordmark).toHaveAttribute('aria-disabled', 'false');
    // Hold the draft PATCH: the wordmark must wait for persistence, not route independently.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let patchStarted = false;
    await page.route(`**/api/imports/${d.id}/`, async (route) => {
      if (route.request().method() === 'PATCH') {
        patchStarted = true;
        await held;
      }
      await route.continue();
    });
    await wordmark.click();
    await expect.poll(() => patchStarted).toBe(true);
    await expect(page).toHaveURL(new RegExp(`/prepare/${d.id}$`));
    release();
    await expect(page).toHaveURL(/\/$/);
    const saved = await (await request.get(`/api/imports/${d.id}/`)).json();
    expect(saved.manifest.pages[0].angle).toBe(2);
    expect(saved.manifest.pages[0].corners).toBeUndefined();
  } finally {
    await request.delete(`/api/imports/${d.id}/`);
  }
});
