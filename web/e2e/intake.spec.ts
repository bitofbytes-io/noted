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
  test('photo source choice goes directly to capture controls', async ({ page, request }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Add piece', exact: true }).click();
    await page.getByRole('button', { name: 'Photos from your books' }).click();
    await expect(page).toHaveURL(/prepare\/[0-9a-f-]+\?source=photos/);
    const id = new URL(page.url()).pathname.split('/').at(-1)!;
    try {
      await expect(page.getByRole('button', { name: 'Take a photo' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Choose PDF', exact: true })).not.toBeVisible();
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
    const saved = await (await request.get(`/api/imports/${d.id}/`)).json();
    expect(saved.metadata.sourceUrl).toBe('https://example.test/my-edition');
  } finally {
    await request.delete(`/api/imports/${d.id}/`);
  }
});
