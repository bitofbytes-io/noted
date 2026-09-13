import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PDFDocument } from 'pdf-lib';
const fixture = resolve('../testdata/fixtures/noted-exercise.pdf');
test.describe('intake with private API and PostgreSQL', () => {
  test.skip(
    !process.env['NOTED_E2E_REAL_API'],
    'Set NOTED_E2E_REAL_API=1 with the local API and migrated database.',
  );
  test('upload, reorder, undo, worker correction, save and retained-source resume', async ({
    page,
    request,
  }) => {
    const created = await request.post('/api/imports/', { data: {} });
    expect(created.ok()).toBeTruthy();
    const initial = await created.json();
    let pieceId: string | undefined;
    try {
      await page.goto(`/prepare/${initial.id}`);
      await page.locator('input[type=file][accept="application/pdf"]').setInputFiles(fixture);
      await expect(page.getByRole('heading', { name: 'Prepare pages' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Preview page 2' })).toBeVisible();
      await page.getByRole('button', { name: 'Preview page 2' }).click();
      await page.getByRole('button', { name: 'Move page earlier' }).click();
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await page.getByLabel('Angle in degrees').fill('1');
      await expect(page.locator('.page-surface img')).toBeVisible();
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await page.getByLabel('Title', { exact: true }).fill(`Intake browser ${Date.now()}`);
      await page.getByLabel('Composer', { exact: true }).fill('Fixture composer');
      await page.getByLabel('Listening URL').fill('https://example.test/recording');
      await page.getByRole('button', { name: 'Save & open' }).click();
      await expect(page).toHaveURL(/\/reader\/[0-9a-f-]+$/);
      pieceId = page.url().split('/').at(-1)!;
      const saved = await (await request.get(`/api/pieces/${pieceId}/`)).json();
      expect(saved.pdf.pageCount).toBe(2);
      expect(saved.listeningUrl).toBe('https://example.test/recording');
      const reopened = await (await request.post('/api/imports/', { data: { pieceId } })).json();
      expect(reopened.sources).toHaveLength(1);
      expect(reopened.manifest.pages.some((p: { angle?: number }) => p.angle === 1)).toBe(true);
      await request.delete(`/api/imports/${reopened.id}/`);
    } finally {
      await request.delete(`/api/imports/${initial.id}/`);
      if (pieceId) await request.delete(`/api/pieces/${pieceId}/`);
    }
  });
  test('real worker preserves untouched PDF, orders pages, rejects unsupported geometry, and loads OpenCV', async ({
    page,
    request,
  }) => {
    const initial = await (await request.post('/api/imports/', { data: {} })).json();
    try {
      const uploaded = await request.post(`/api/imports/${initial.id}/sources`, {
        multipart: {
          revision: '0',
          file: { name: 'score.pdf', mimeType: 'application/pdf', buffer: await readFile(fixture) },
        },
      });
      expect(uploaded.ok()).toBeTruthy();
      const d = await uploaded.json();
      await page.goto(`/prepare/${d.id}`);
      await expect(page.getByRole('heading', { name: 'Prepare pages' })).toBeVisible();
      const result = await page.evaluate(async (d) => {
        const run = (payload: object) =>
          new Promise<{ bytes?: ArrayBuffer; result?: { confident: boolean }; error?: string }>(
            (resolve, reject) => {
              const worker = new Worker('/intake/processing-worker.js');
              worker.onerror = () => reject(Error('worker failed'));
              worker.onmessage = ({ data }) => {
                if (data.progress) return;
                worker.terminate();
                resolve(data);
              };
              worker.postMessage(payload);
            },
          );
        const unchanged = await run({
          kind: 'build',
          draftId: d.id,
          sources: d.sources,
          manifest: d.manifest,
        });
        const source = await (
          await fetch(`/api/imports/${d.id}/sources/${d.sources[0].id}`)
        ).arrayBuffer();
        const digest = async (b: ArrayBuffer) =>
          Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', b))).join(',');
        const canvas = document.createElement('canvas');
        canvas.width = 800;
        canvas.height = 1000;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = 'white';
        ctx.fillRect(0, 0, 800, 1000);
        ctx.strokeStyle = 'black';
        for (let y = 100; y < 900; y += 20) {
          ctx.beginPath();
          ctx.moveTo(80, y);
          ctx.lineTo(720, y);
          ctx.stroke();
        }
        const analysis = await run({ kind: 'analyze', image: ctx.getImageData(0, 0, 800, 1000) });
        const reordered = await run({
          kind: 'build',
          draftId: d.id,
          sources: d.sources,
          manifest: { version: 1, pages: [...d.manifest.pages].reverse() },
        });
        return {
          same: (await digest(source)) === (await digest(unchanged.bytes!)),
          cv: analysis.result?.confident,
          reordered: Array.from(new Uint8Array(reordered.bytes!)),
        };
      }, d);
      expect(result.same).toBe(true);
      expect(result.cv).toBe(true);
      expect((await PDFDocument.load(new Uint8Array(result.reordered))).getPageCount()).toBe(2);
    } finally {
      await request.delete(`/api/imports/${initial.id}/`);
    }
  });
  for (const orientation of [6, 8])
    test(`photo EXIF ${orientation} stays portrait in preview and worker PDF`, async ({
      page,
      request,
    }) => {
      const initial = await (await request.post('/api/imports/', { data: {} })).json();
      try {
        const uploaded = await request.post(`/api/imports/${initial.id}/sources`, {
          multipart: {
            revision: '0',
            file: {
              name: 'photo.jpg',
              mimeType: 'image/jpeg',
              buffer: await readFile(
                resolve(`../testdata/fixtures/noted-photo-exif-${orientation}.jpg`),
              ),
            },
          },
        });
        expect(uploaded.ok()).toBeTruthy();
        const d = await uploaded.json();
        await page.goto(`/prepare/${d.id}`);
        await expect(page.locator('.page-surface img')).toBeVisible();
        const bytes = await page.evaluate(
          async (d) =>
            new Promise<number[]>((resolve, reject) => {
              const worker = new Worker('/intake/processing-worker.js');
              worker.onerror = () => reject(Error('worker failed'));
              worker.onmessage = ({ data }) => {
                if (data.progress) return;
                worker.terminate();
                if (data.error) reject(Error(data.error));
                else resolve(Array.from(new Uint8Array(data.bytes)));
              };
              worker.postMessage({
                kind: 'build',
                draftId: d.id,
                sources: d.sources,
                manifest: {
                  version: 1,
                  pages: d.manifest.pages.map((p: object) => ({
                    ...p,
                    corners: [
                      [0, 0],
                      [1, 0],
                      [1, 1],
                      [0, 1],
                    ],
                  })),
                },
              });
            }),
          d,
        );
        const pdf = await PDFDocument.load(new Uint8Array(bytes));
        expect(pdf.getPage(0).getHeight()).toBeGreaterThan(pdf.getPage(0).getWidth());
      } finally {
        await request.delete(`/api/imports/${initial.id}/`);
      }
    });
});

test.describe('worker PDF geometry regression with real sources', () => {
  test.skip(!process.env['NOTED_E2E_REAL_API'], 'Requires isolated intake API.');
  test('copy/extract retains source rotation and crop while fine edits fail explicitly', async ({
    page,
    request,
  }) => {
    const doc = await PDFDocument.load(await readFile(fixture));
    const { degrees } = await import('pdf-lib');
    doc.getPage(0).setRotation(degrees(90));
    doc.getPage(0).setCropBox(10, 20, 500, 650);
    const data = await doc.save();
    const initial = await (await request.post('/api/imports/', { data: {} })).json();
    try {
      const upload = await request.post(`/api/imports/${initial.id}/sources`, {
        multipart: {
          revision: '0',
          file: { name: 'rotated.pdf', mimeType: 'application/pdf', buffer: Buffer.from(data) },
        },
      });
      expect(upload.ok()).toBeTruthy();
      const d = await upload.json();
      await page.goto(`/prepare/${d.id}`);
      const result = await page.evaluate(async (d) => {
        const run = (manifest: object) =>
          new Promise<{ bytes?: ArrayBuffer; error?: string }>((resolve) => {
            const w = new Worker('/intake/processing-worker.js');
            w.onmessage = ({ data }) => {
              if (data.progress) return;
              w.terminate();
              resolve(data);
            };
            w.postMessage({ kind: 'build', draftId: d.id, sources: d.sources, manifest });
          });
        const copy = await run({ version: 1, pages: [d.manifest.pages[0]] }),
          edit = await run({ version: 1, pages: [{ ...d.manifest.pages[0], angle: 1 }] });
        return { copy: Array.from(new Uint8Array(copy.bytes!)), error: edit.error };
      }, d);
      expect(result.error).toContain('already has a page rotation or crop');
      const copied = await PDFDocument.load(new Uint8Array(result.copy));
      expect(copied.getPage(0).getRotation().angle).toBe(90);
      expect(copied.getPage(0).getCropBox()).toEqual({ x: 10, y: 20, width: 500, height: 650 });
    } finally {
      await request.delete(`/api/imports/${initial.id}/`);
    }
  });
  test('Add piece goes directly to Source with all source choices', async ({ page, request }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Add piece', exact: true }).click();
    await expect(page).toHaveURL(/prepare\/[0-9a-f-]+\?source=all/);
    const id = new URL(page.url()).pathname.split('/').at(-1)!;
    try {
      await expect(page.getByRole('button', { name: 'Take a photo' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Choose PDF', exact: true })).toBeVisible();
      await expect(
        page.getByRole('heading', { name: 'Bring an edition from IMSLP' }),
      ).toBeVisible();
      await expect(page.getByRole('dialog')).not.toBeVisible();
      await expect(page.locator('input[capture="environment"]')).toHaveAttribute('hidden', '');
    } finally {
      await request.delete(`/api/imports/${id}/`);
    }
  });
});

test.describe('review regressions', () => {
  test.skip(!process.env['NOTED_E2E_REAL_API'], 'Requires real API.');
  test('fixed physical canvas, rendered enlargement, clipping and adjusted-reference matching', async ({
    page,
    request,
  }) => {
    test.setTimeout(60000);
    const doc = await PDFDocument.create();
    for (const [w, h, l, r] of [
      [612, 792, 206, 406],
      [400, 600, 110, 290],
    ]) {
      const p = doc.addPage([w, h]);
      for (let s = 0; s < 4; s++)
        for (let n = 0; n < 5; n++) {
          const y = h * 0.3 + s * 50 + n * 5;
          p.drawLine({ start: { x: l, y }, end: { x: r, y }, thickness: 1 });
        }
    }
    const initial = await (await request.post('/api/imports/', { data: {} })).json();
    try {
      const d = await (
        await request.post(`/api/imports/${initial.id}/sources`, {
          multipart: {
            revision: '0',
            file: {
              name: 'cc0-staves.pdf',
              mimeType: 'application/pdf',
              buffer: Buffer.from(await doc.save()),
            },
          },
        })
      ).json();
      await page.goto(`/prepare/${d.id}`);
      const r = await page.evaluate(async (d) => {
        const run = (payload: object) =>
          new Promise<any>((resolve, reject) => {
            const w = new Worker('/intake/processing-worker.js');
            w.onerror = () => reject(Error('worker failed'));
            w.onmessage = ({ data }) => {
              if (!('bytes' in data || 'result' in data || 'error' in data)) return;
              w.terminate();
              resolve(data);
            };
            w.postMessage({ draftId: d.id, sources: d.sources, ...payload });
          });
        const build = async (edit: object) => {
          const r = await run({ kind: 'build', manifest: { version: 1, pages: [edit] } });
          if (r.error) throw Error(r.error);
          return r.bytes;
        };
        const pdfjs = await new Function('return import("/pdfjs/pdf.min.mjs")')();
        pdfjs.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';
        const bounds = async (bytes: ArrayBuffer) => {
          const task = pdfjs.getDocument({ data: new Uint8Array(bytes), wasmUrl: '/pdfjs/wasm/' });
          try {
            const pdf = await task.promise,
              p = await pdf.getPage(1),
              v = p.getViewport({ scale: 2 }),
              c = document.createElement('canvas');
            c.width = Math.ceil(v.width);
            c.height = Math.ceil(v.height);
            await p.render({ canvas: c, canvasContext: c.getContext('2d'), viewport: v }).promise;
            const a = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
            let l = c.width,
              t = c.height,
              r = 0,
              b = 0;
            for (let y = 0; y < c.height; y++)
              for (let x = 0; x < c.width; x++)
                if (a[(y * c.width + x) * 4] < 180) {
                  l = Math.min(l, x);
                  r = Math.max(r, x);
                  t = Math.min(t, y);
                  b = Math.max(b, y);
                }
            return { w: v.width / 2, h: v.height / 2, ink: [l / 2, t / 2, r / 2, b / 2] };
          } finally {
            await task.destroy();
          }
        };
        const original = await bounds(await build(d.manifest.pages[0])),
          enlarged = await bounds(await build({ ...d.manifest.pages[0], scale: 1.5, x: 0.03 }));
        const clipped = await run({
          kind: 'build',
          manifest: { version: 1, pages: [{ ...d.manifest.pages[0], scale: 3 }] },
        });
        const cropped = await bounds(
          await build({ ...d.manifest.pages[0], crop: [0.4, 0.1, 0.6, 0.9] }),
        );
        const ref = {
          ...d.manifest.pages[0],
          crop: [0.05, 0.05, 0.95, 0.95],
          scale: 1.2,
          x: 0.04,
          y: -0.03,
          angle: 1,
        };
        const matched = await run({
          kind: 'match',
          reference: ref,
          targets: [d.manifest.pages[1]],
        });
        if (matched.error) throw Error(matched.error);
        return {
          original,
          enlarged,
          clipped: clipped.error,
          cropped,
          reference: await bounds(await build(ref)),
          target: await bounds(await build(matched.result[0])),
          edit: matched.result[0],
        };
      }, d);
      await test.info().attach('rendered-intake-geometry', {
        body: JSON.stringify(r, null, 2),
        contentType: 'application/json',
      });
      expect(r.enlarged.w).toBe(612);
      expect(r.enlarged.h).toBe(792);
      expect(
        (r.enlarged.ink[2] - r.enlarged.ink[0]) / (r.original.ink[2] - r.original.ink[0]),
      ).toBeCloseTo(1.5, 2);
      expect((r.enlarged.ink[0] + r.enlarged.ink[2]) / 2).toBeCloseTo(306 + 0.03 * 612, 0);
      expect(r.clipped).toContain('would cut off page content');
      expect(r.cropped.w).toBeCloseTo(122.4, 0);
      expect(r.target.w).toBeCloseTo(r.reference.w, 3);
      expect(r.target.h).toBeCloseTo(r.reference.h, 3);
      expect(Math.abs(r.target.ink[0] - r.reference.ink[0])).toBeLessThan(2);
      expect(Math.abs(r.target.ink[1] - r.reference.ink[1])).toBeLessThan(2);
      expect(
        Math.abs(
          (r.target.ink[2] - r.target.ink[0]) / (r.reference.ink[2] - r.reference.ink[0]) - 1,
        ),
      ).toBeLessThan(0.01);
      expect(
        (
          await request.patch(`/api/imports/${d.id}/`, {
            data: {
              revision: d.revision,
              metadata: d.metadata,
              manifest: { version: 1, pages: [r.edit] },
            },
          })
        ).ok(),
      ).toBeTruthy();
    } finally {
      await request.delete(`/api/imports/${initial.id}/`);
    }
  });
  test('cancel waits for delayed upload reconciliation before edits', async ({ page, request }) => {
    const d = await (await request.post('/api/imports/', { data: {} })).json();
    let release!: () => void, arrived!: () => void;
    const held = new Promise<void>((r) => (release = r)),
      received = new Promise<void>((r) => (arrived = r));
    try {
      await page.goto(`/prepare/${d.id}`);
      await page.route(`**/api/imports/${d.id}/sources`, async (route) => {
        // Relay the selected fixture through the real multipart API. Browser routing
        // does not retain uploaded file bytes in postDataBuffer on every engine.
        const response = await request.post(`/api/imports/${d.id}/sources`, {
          multipart: {
            revision: String(d.revision),
            file: {
              name: 'score.pdf',
              mimeType: 'application/pdf',
              buffer: await readFile(fixture),
            },
          },
        });
        expect(response.ok()).toBeTruthy();
        arrived();
        await held;
        await route.fulfill({ response });
      });
      await page.locator('input[type=file][accept="application/pdf"]').setInputFiles(fixture);
      await received;
      await page.getByRole('button', { name: 'Cancel processing' }).click();
      await expect(page.getByRole('button', { name: 'Choose PDF', exact: true })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Save draft & close' })).toBeDisabled();
      release();
      await expect(page.getByRole('heading', { name: 'Prepare pages' })).toBeVisible();
      await page.getByLabel('Angle in degrees').fill('2');
      await page.getByRole('button', { name: 'Save draft & close' }).click();
      await expect(page).toHaveURL(/\/$/);
      const saved = await (await request.get(`/api/imports/${d.id}/`)).json();
      expect(saved.sources).toHaveLength(1);
      expect(saved.manifest.pages[0].angle).toBe(2);
    } finally {
      release();
      await request.delete(`/api/imports/${d.id}/`);
    }
  });
  test('replace at 100 pages changes source identity and retains count', async ({
    page,
    request,
  }) => {
    test.setTimeout(60000);
    const doc = await PDFDocument.create();
    for (let i = 0; i < 100; i++) doc.addPage([612, 792]);
    const initial = await (await request.post('/api/imports/', { data: {} })).json();
    try {
      const d = await (
        await request.post(`/api/imports/${initial.id}/sources`, {
          multipart: {
            revision: '0',
            file: {
              name: 'cc0-blank-pages.pdf',
              mimeType: 'application/pdf',
              buffer: Buffer.from(await doc.save()),
            },
          },
        })
      ).json();
      await page.goto(`/prepare/${d.id}`);
      await page
        .locator('input[type=file][accept="application/pdf,image/jpeg,image/png"]:not([multiple])')
        .setInputFiles(fixture);
      await expect(page.getByRole('button', { name: 'Save draft & close' })).toBeEnabled();
      await page.getByRole('button', { name: 'Save draft & close' }).click();
      await expect(page).toHaveURL(/\/$/);
      const saved = await (await request.get(`/api/imports/${d.id}/`)).json();
      expect(saved.manifest.pages).toHaveLength(100);
      expect(saved.manifest.pages[0].id).toBe(d.manifest.pages[0].id);
      expect(saved.manifest.pages[0].sourceId).not.toBe(d.manifest.pages[0].sourceId);
      expect(saved.manifest.pages[0].page).toBe(0);
    } finally {
      await request.delete(`/api/imports/${initial.id}/`);
    }
  });
});

test('IMSLP metadata is retained when uploading an already downloaded PDF', async ({
  page,
  request,
}) => {
  test.skip(!process.env['NOTED_E2E_REAL_API'], 'Requires real API.');
  const d = await (await request.post('/api/imports/', { data: {} })).json();
  try {
    await page.goto(`/prepare/${d.id}?source=imslp`);
    const url =
      'https://imslp.org/wiki/Prelude_and_Fugue_in_C_major,_BWV_846_(Bach,_Johann_Sebastian)';
    await page.getByLabel('IMSLP work link').fill(url);
    await page.locator('input[type=file][accept="application/pdf"]').setInputFiles(fixture);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByLabel('Source link')).toHaveValue(url);
    await expect(page.getByLabel('Title', { exact: true })).toHaveValue(
      'Prelude and Fugue in C major, BWV 846',
    );
    await expect(page.getByLabel('Composer', { exact: true })).toHaveValue(
      'Bach, Johann Sebastian',
    );
    await page.getByLabel('Source link').fill('https://example.test/my-edition');
    await page.getByRole('button', { name: 'Save draft & close' }).click();
    await expect(page).toHaveURL(/\/$/);
    const saved = await (await request.get(`/api/imports/${d.id}/`)).json();
    expect(saved.metadata.sourceUrl).toBe('https://example.test/my-edition');
  } finally {
    await request.delete(`/api/imports/${d.id}/`);
  }
});

function withExifOrientation(input: Buffer, orientation: number): Buffer {
  const data = Buffer.from(input),
    t = data.indexOf(Buffer.from('Exif\0\0')) + 6;
  if (t < 6) throw Error('EXIF missing');
  const little = data.toString('ascii', t, t + 2) === 'II';
  const u16 = (p: number) => (little ? data.readUInt16LE(p) : data.readUInt16BE(p)),
    u32 = (p: number) => (little ? data.readUInt32LE(p) : data.readUInt32BE(p)),
    ifd = t + u32(t + 4);
  for (let i = 0; i < u16(ifd); i++) {
    const q = ifd + 2 + i * 12;
    if (u16(q) === 274) {
      if (little) data.writeUInt16LE(orientation, q + 8);
      else data.writeUInt16BE(orientation, q + 8);
      return data;
    }
  }
  throw Error('Orientation missing');
}
test.describe('photo content and source reuse', () => {
  test.skip(!process.env['NOTED_E2E_REAL_API'], 'Requires real API');
  test('all JPEG orientations retain bytes and real pixels through copy, crop and perspective', async ({
    page,
    request,
  }) => {
    test.setTimeout(120000);
    let d = await (await request.post('/api/imports/', { data: {} })).json();
    const original = await readFile(resolve('../testdata/fixtures/noted-photo-exif-6.jpg')),
      files: Buffer[] = [];
    try {
      for (let n = 1; n <= 8; n++) {
        const buffer = withExifOrientation(original, n);
        files.push(buffer);
        const r = await request.post(`/api/imports/${d.id}/sources`, {
          multipart: {
            revision: String(d.revision),
            file: { name: `exif-${n}.jpg`, mimeType: 'image/jpeg', buffer },
          },
        });
        expect(r.ok()).toBeTruthy();
        d = await r.json();
      }
      await page.goto('/');
      const results = await page.evaluate(async (d) => {
        const run = (edit: object) =>
          new Promise<ArrayBuffer>((resolve, reject) => {
            const w = new Worker('/intake/processing-worker.js');
            w.onerror = () => reject(Error('worker failed'));
            w.onmessage = ({ data }) => {
              if (!('bytes' in data || 'error' in data)) return;
              w.terminate();
              if (data.error) reject(Error(data.error));
              else resolve(data.bytes);
            };
            w.postMessage({
              kind: 'build',
              draftId: d.id,
              sources: d.sources,
              manifest: { version: 1, pages: [edit] },
            });
          });
        const pdfjs = await new Function('return import("/pdfjs/pdf.min.mjs")')();
        pdfjs.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';
        const render = async (bytes: ArrayBuffer) => {
          const task = pdfjs.getDocument({ data: new Uint8Array(bytes), wasmUrl: '/pdfjs/wasm/' });
          try {
            const pdf = await task.promise,
              p = await pdf.getPage(1),
              v = p.getViewport({ scale: 0.8 }),
              c = document.createElement('canvas');
            c.width = Math.ceil(v.width);
            c.height = Math.ceil(v.height);
            await p.render({ canvas: c, canvasContext: c.getContext('2d'), viewport: v }).promise;
            return c;
          } finally {
            await task.destroy();
          }
        };
        const coverage = (c: HTMLCanvasElement) => {
          const a = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
          let n = 0;
          for (let i = 0; i < a.length; i += 4) if (a[i] < 180 && a[i + 3] > 128) n++;
          return n / (c.width * c.height);
        };
        const results = [];
        for (const edit of d.manifest.pages) {
          const bytes = await run(edit),
            copy = Array.from(new Uint8Array(bytes)),
            c = await render(bytes),
            source = await createImageBitmap(
              await (await fetch(`/api/imports/${d.id}/sources/${edit.sourceId}`)).blob(),
            ),
            expected = document.createElement('canvas');
          expected.width = c.width;
          expected.height = c.height;
          expected.getContext('2d')!.drawImage(source, 0, 0, c.width, c.height);
          source.close();
          const a = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data,
            b = expected.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
          let difference = 0;
          for (let n = 0; n < a.length; n += 4)
            difference +=
              Math.abs(a[n] - b[n]) + Math.abs(a[n + 1] - b[n + 1]) + Math.abs(a[n + 2] - b[n + 2]);
          const crop = await render(
              await run({ ...edit, crop: [0.02, 0.02, 0.98, 0.98], scale: 0.9 }),
            ),
            perspective = await render(
              await run({
                ...edit,
                corners: [
                  [0.005, 0.005],
                  [0.995, 0.005],
                  [0.995, 0.995],
                  [0.005, 0.995],
                ],
                crop: [0.01, 0.01, 0.99, 0.99],
                scale: 0.95,
              }),
            );
          results.push({
            copy,
            mae: difference / ((a.length / 4) * 3),
            coverage: coverage(c),
            cropCoverage: coverage(crop),
            perspectiveCoverage: coverage(perspective),
            w: c.width,
            h: c.height,
          });
          for (const canvas of [c, expected, crop, perspective]) canvas.width = canvas.height = 1;
        }
        return results;
      }, d);
      for (const [i, r] of results.entries()) {
        expect(Buffer.from(r.copy).includes(files[i])).toBeTruthy();
        expect(r.copy.length).toBeLessThan(files[i].length + 10000);
        expect(r.mae).toBeLessThan(12);
        expect(r.coverage).toBeGreaterThan(0.005);
        expect(r.cropCoverage).toBeGreaterThan(0.005);
        expect(r.perspectiveCoverage).toBeGreaterThan(0.005);
        if (i >= 4) expect(r.h).toBeGreaterThan(r.w);
        else expect(r.w).toBeGreaterThan(r.h);
      }
    } finally {
      await request.delete(`/api/imports/${d.id}/`);
    }
  });
  test('worker and thumbnails reuse a repeated PDF source', async ({ page, request }) => {
    let d = await (await request.post('/api/imports/', { data: {} })).json();
    try {
      d = await (
        await request.post(`/api/imports/${d.id}/sources`, {
          multipart: {
            revision: String(d.revision),
            file: {
              name: 'score.pdf',
              mimeType: 'application/pdf',
              buffer: await readFile(fixture),
            },
          },
        })
      ).json();
      await page.goto('/');
      let reads = 0;
      const source = `/api/imports/${d.id}/sources/${d.sources[0].id}`;
      page.on('request', (r) => {
        if (r.url().endsWith(source) && r.method() === 'GET') reads++;
      });
      const count = await page.evaluate(async (d) => {
        const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
          const w = new Worker('/intake/processing-worker.js');
          w.onmessage = ({ data }) => {
            if (!('bytes' in data || 'error' in data)) return;
            w.terminate();
            if (data.error) reject(Error(data.error));
            else resolve(data.bytes);
          };
          w.postMessage({
            kind: 'build',
            draftId: d.id,
            sources: d.sources,
            manifest: {
              version: 1,
              pages: [
                { ...d.manifest.pages[1], angle: 0.5 },
                { ...d.manifest.pages[0], angle: -0.5 },
                { ...d.manifest.pages[1], angle: 0.5 },
              ],
            },
          });
        });
        return bytes.byteLength;
      }, d);
      expect(count).toBeGreaterThan(1000);
      expect(reads).toBe(1);
      reads = 0;
      await page.goto(`/prepare/${d.id}`);
      await expect(
        page.getByRole('button', { name: 'Preview page 2' }).locator('img'),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Preview page 2' }).click();
      await expect(page.locator('.page-surface img')).toBeVisible();
      expect(reads).toBe(1);
    } finally {
      await request.delete(`/api/imports/${d.id}/`);
    }
  });
  test('keyboard crop stops before edges cross and saves', async ({ page, request }) => {
    let d = await (await request.post('/api/imports/', { data: {} })).json();
    try {
      d = await (
        await request.post(`/api/imports/${d.id}/sources`, {
          multipart: {
            revision: String(d.revision),
            file: {
              name: 'score.pdf',
              mimeType: 'application/pdf',
              buffer: await readFile(fixture),
            },
          },
        })
      ).json();
      d.manifest.pages[0].crop = [0.45, 0.45, 0.51, 0.51];
      d = await (
        await request.patch(`/api/imports/${d.id}/`, {
          data: { revision: d.revision, metadata: d.metadata, manifest: d.manifest },
        })
      ).json();
      await page.goto(`/prepare/${d.id}`);
      await expect(page.locator('.page-surface img')).toBeVisible();
      await expect(page.locator('.page-surface img')).toHaveJSProperty('complete', true);
      await page.getByRole('button', { name: 'Adjust page edges', exact: true }).click();
      const corner = page.getByRole('button', { name: 'Adjust corner 1 with arrow keys or drag' });
      await expect(corner).toBeEnabled();
      await corner.evaluate((element) => {
        for (let n = 0; n < 4; n++) {
          element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
          element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        }
      });
      await page.getByRole('button', { name: 'Apply edges', exact: true }).click();
      await page.getByRole('button', { name: 'Save draft & close' }).click();
      await expect(page).toHaveURL(/\/$/);
      const saved = await (await request.get(`/api/imports/${d.id}/`)).json(),
        c = saved.manifest.pages[0].crop;
      expect(c[2] - c[0]).toBeGreaterThanOrEqual(0.05);
      expect(c[3] - c[1]).toBeGreaterThanOrEqual(0.05);
      expect(c[0]).toBeGreaterThan(0.455);
    } finally {
      await request.delete(`/api/imports/${d.id}/`);
    }
  });
});

test('Lighten paper preserves faint strokes and color in a compact four-photo PDF', async ({
  page,
  request,
}) => {
  test.skip(!process.env['NOTED_E2E_REAL_API'], 'Requires real API');
  test.setTimeout(60000);
  let d = await (await request.post('/api/imports/', { data: {} })).json();
  try {
    await page.goto('/');
    const data = await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 720;
      c.height = 960;
      const x = c.getContext('2d')!,
        g = x.createLinearGradient(0, 0, 720, 0);
      g.addColorStop(0, 'rgb(180,185,190)');
      g.addColorStop(1, 'rgb(235,235,235)');
      x.fillStyle = g;
      x.fillRect(0, 0, 720, 960);
      x.fillStyle = 'rgb(155,65,80)';
      x.fillRect(60, 60, 60, 25);
      x.strokeStyle = 'rgb(150,150,150)';
      x.lineWidth = 2;
      x.beginPath();
      x.moveTo(260, 100);
      x.lineTo(360, 100);
      x.stroke();
      x.strokeStyle = 'rgb(25,25,25)';
      x.lineWidth = 1;
      for (let s = 0; s < 6; s++)
        for (let l = 0; l < 5; l++) {
          x.beginPath();
          x.moveTo(100, 200.5 + s * 110 + l * 6);
          x.lineTo(620, 200.5 + s * 110 + l * 6);
          x.stroke();
        }
      return c.toDataURL('image/png').split(',')[1];
    });
    d = await (
      await request.post(`/api/imports/${d.id}/sources`, {
        multipart: {
          revision: String(d.revision),
          file: {
            name: 'original-cc0-shadow-study.png',
            mimeType: 'image/png',
            buffer: Buffer.from(data, 'base64'),
          },
        },
      })
    ).json();
    const checksum = d.sources[0].checksum;
    await page.goto(`/prepare/${d.id}`);
    await page.getByLabel('Lighten paper strength').fill('100');
    await page.getByLabel('Lighten paper strength').blur();
    await page.getByRole('button', { name: 'Save draft & close' }).click();
    await expect(page).toHaveURL(/\/$/);
    d = await (await request.get(`/api/imports/${d.id}/`)).json();
    expect(d.manifest.pages[0].paperCleanupStrength).toBe(1);
    expect(d.sources[0].checksum).toBe(checksum);
    const result = await page.evaluate(async (d) => {
      const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
        const w = new Worker('/intake/processing-worker.js');
        w.onmessage = ({ data }) => {
          if (!('bytes' in data || 'error' in data)) return;
          w.terminate();
          if (data.error) reject(Error(data.error));
          else resolve(data.bytes);
        };
        w.postMessage({
          kind: 'build',
          draftId: d.id,
          sources: d.sources,
          manifest: {
            version: 1,
            pages: Array.from({ length: 4 }, () => ({
              ...d.manifest.pages[0],
              id: crypto.randomUUID(),
            })),
          },
        });
      });
      const size = bytes.byteLength,
        pdfjs = await new Function('return import("/pdfjs/pdf.min.mjs")')();
      pdfjs.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';
      const task = pdfjs.getDocument({ data: new Uint8Array(bytes), wasmUrl: '/pdfjs/wasm/' });
      try {
        const pdf = await task.promise,
          p = await pdf.getPage(1),
          v = p.getViewport({ scale: 1.2 }),
          c = document.createElement('canvas');
        c.width = Math.ceil(v.width);
        c.height = Math.ceil(v.height);
        await p.render({ canvas: c, canvasContext: c.getContext('2d'), viewport: v }).promise;
        const ctx = c.getContext('2d')!,
          sample = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data);
        return {
          size,
          pages: pdf.numPages,
          paper: sample(300, 90),
          pencil: sample(300, 100),
          color: sample(80, 70),
          staff: sample(300, 200),
        };
      } finally {
        await task.destroy();
      }
    }, d);
    expect(result.pages).toBe(4);
    expect(result.size).toBeLessThan(4 * 1024 * 1024);
    expect(result.paper[0]).toBeGreaterThan(245);
    expect(result.pencil[0]).toBeGreaterThan(130);
    expect(result.pencil[0]).toBeLessThan(230);
    expect(result.staff[0]).toBeLessThan(100);
    expect(result.color[0] - result.color[1]).toBeGreaterThan(50);
    expect(result.color[2]).toBeGreaterThan(40);
  } finally {
    await request.delete(`/api/imports/${d.id}/`);
  }
});

test('short EXIF APP1 headers abstain safely and valid JPEGs render via fallback', async ({
  page,
  request,
}) => {
  test.skip(!process.env['NOTED_E2E_REAL_API'], 'Requires real API');
  const { runInNewContext } = await import('node:vm');
  const workerCode = await readFile(resolve('public/intake/processing-worker.js'), 'utf8');
  const parse = runInNewContext(`${workerCode}\njpegOrientation`, {
    self: {},
    importScripts: () => {},
  });
  const original = await readFile(resolve('../testdata/fixtures/noted-photo-exif-6.jpg'));
  let d = await (await request.post('/api/imports/', { data: {} })).json();
  try {
    for (const length of [14, 15]) {
      const short = Buffer.alloc(length + 4);
      short.writeUInt16BE(0xffd8, 0);
      short.writeUInt16BE(0xffe1, 2);
      short.writeUInt16BE(length, 4);
      short.write('Exif\0\0II', 6, 'binary');
      short.writeUInt16LE(42, 14);
      const buffer = short.buffer.slice(short.byteOffset, short.byteOffset + short.byteLength);
      expect(parse(buffer)).toBeUndefined();
      const jpeg = Buffer.concat([short, original.subarray(2)]);
      expect(
        parse(jpeg.buffer.slice(jpeg.byteOffset, jpeg.byteOffset + jpeg.byteLength)),
      ).toBeUndefined();
      const response = await request.post(`/api/imports/${d.id}/sources`, {
        multipart: {
          revision: String(d.revision),
          file: { name: `short-exif-${length}.jpg`, mimeType: 'image/jpeg', buffer: jpeg },
        },
      });
      expect(response.ok()).toBeTruthy();
      d = await response.json();
    }
    await page.goto('/');
    const result = await page.evaluate(async (d) => {
      const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
        const w = new Worker('/intake/processing-worker.js');
        w.onmessage = ({ data }) => {
          if (!('bytes' in data || 'error' in data)) return;
          w.terminate();
          if (data.error) reject(Error(data.error));
          else resolve(data.bytes);
        };
        w.postMessage({ kind: 'build', draftId: d.id, sources: d.sources, manifest: d.manifest });
      });
      const pdfjs = await new Function('return import("/pdfjs/pdf.min.mjs")')();
      pdfjs.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';
      const task = pdfjs.getDocument({ data: new Uint8Array(bytes), wasmUrl: '/pdfjs/wasm/' });
      try {
        const doc = await task.promise,
          coverage = [];
        for (let i = 1; i <= doc.numPages; i++) {
          const p = await doc.getPage(i),
            v = p.getViewport({ scale: 0.5 }),
            c = document.createElement('canvas');
          c.width = Math.ceil(v.width);
          c.height = Math.ceil(v.height);
          await p.render({ canvas: c, canvasContext: c.getContext('2d'), viewport: v }).promise;
          const a = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
          let dark = 0;
          for (let n = 0; n < a.length; n += 4) if (a[n] < 180 && a[n + 3] > 128) dark++;
          coverage.push(dark / (c.width * c.height));
        }
        return coverage;
      } finally {
        await task.destroy();
      }
    }, d);
    expect(result).toHaveLength(2);
    for (const coverage of result) expect(coverage).toBeGreaterThan(0.005);
  } finally {
    await request.delete(`/api/imports/${d.id}/`);
  }
});

test('Lighten paper undo restores the toggle without undoing earlier geometry', async ({
  page,
  request,
}) => {
  test.skip(!process.env['NOTED_E2E_REAL_API'], 'Requires real API');
  let d = await (await request.post('/api/imports/', { data: {} })).json();
  try {
    d = await (
      await request.post(`/api/imports/${d.id}/sources`, {
        multipart: {
          revision: String(d.revision),
          file: {
            name: 'photo.jpg',
            mimeType: 'image/jpeg',
            buffer: await readFile(resolve('../testdata/fixtures/noted-photo-exif-6.jpg')),
          },
        },
      })
    ).json();
    await page.goto(`/prepare/${d.id}`);
    await expect(page.locator('.page-surface img')).toBeVisible();
    await page.getByLabel('Angle in degrees').fill('0.5');
    await page.getByLabel('Lighten paper strength').dispatchEvent('pointerdown');
    await page.getByLabel('Lighten paper strength').fill('30');
    await page.getByLabel('Lighten paper strength').fill('100');
    await page.getByLabel('Lighten paper strength').dispatchEvent('pointerup');
    await page.getByLabel('Lighten paper strength').blur();
    await expect(page.getByLabel('Lighten paper strength')).toHaveValue('100');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.getByLabel('Lighten paper strength')).toHaveValue('0');
    await expect(page.getByLabel('Angle in degrees')).toHaveValue('0.5');
    await page.getByRole('button', { name: 'Save draft & close' }).click();
    await expect(page).toHaveURL(/\/$/);
    const saved = await (await request.get(`/api/imports/${d.id}/`)).json();
    expect(saved.manifest.pages[0].paperCleanupStrength ?? 0).toBe(0);
    expect(saved.manifest.pages[0].angle).toBe(0.5);
  } finally {
    await request.delete(`/api/imports/${d.id}/`);
  }
});
