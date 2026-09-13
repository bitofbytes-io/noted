import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PDFDocument, PDFName, PDFNumber, PDFDict, PDFRawStream } from 'pdf-lib';

test.skip(!process.env['NOTED_E2E_REAL_API'], 'Requires the private API and PostgreSQL.');

test('20MP correction bounds working canvases while retaining JPEG originals and faint detail', async ({
  page,
  request,
}, testInfo) => {
  const original = await readFile(resolve('../testdata/fixtures/noted-photo-20mp.jpg'));
  let d = await (await request.post('/api/imports/', { data: {} })).json();
  try {
    const upload = await request.post(`/api/imports/${d.id}/sources`, {
      multipart: {
        revision: String(d.revision),
        file: { name: 'original-cc0-20mp.jpg', mimeType: 'image/jpeg', buffer: original },
      },
    });
    expect(upload.ok()).toBeTruthy();
    d = await upload.json();
    await page.route('**/intake/processing-worker.js', async (route) => {
      const source = await (await route.fetch()).text();
      // Observe real worker surfaces and bitmap lifetime without substituting processing.
      const probe = `const metrics={maxCanvasPixels:0,maxCanvasEdge:0,openBitmaps:0,cvStartedWithBitmap:false};
   const NativeCanvas=self.OffscreenCanvas;
   self.OffscreenCanvas=class extends NativeCanvas{constructor(w,h){super(w,h);this.record();}record(){metrics.maxCanvasPixels=Math.max(metrics.maxCanvasPixels,this.width*this.height);metrics.maxCanvasEdge=Math.max(metrics.maxCanvasEdge,this.width,this.height);}get width(){return super.width;}set width(v){super.width=v;this.record();}get height(){return super.height;}set height(v){super.height=v;this.record();}};
   const nativeBitmap=self.createImageBitmap;self.createImageBitmap=async(...args)=>{const b=await nativeBitmap(...args);metrics.openBitmaps++;const close=b.close.bind(b);b.close=()=>{metrics.openBitmaps--;close();};return b;};
   const nativeImports=self.importScripts;self.importScripts=(...args)=>{if(args.some(a=>String(a).includes('opencv')))metrics.cvStartedWithBitmap=metrics.openBitmaps>0;return nativeImports(...args);};
   const nativePost=self.postMessage;self.postMessage=(message,transfer)=>nativePost.call(self,message.bytes?{...message,metrics:{...metrics,wasmHeapBytes:self.cv?.HEAPU8?.buffer?.byteLength}}:message,transfer);\n`;
      await route.fulfill({ contentType: 'application/javascript', body: probe + source });
    });
    await page.goto('/');
    const result = await page.evaluate(async (d) => {
      const result = await new Promise<any>((resolve, reject) => {
        const w = new Worker('/intake/processing-worker.js');
        w.onerror = (e) => reject(Error(e.message));
        w.onmessage = ({ data }) => {
          if (data.error) {
            w.terminate();
            reject(Error(data.error));
          } else if (data.bytes) {
            w.terminate();
            resolve(data);
          }
        };
        const base = d.manifest.pages[0],
          corners = [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
          ];
        w.postMessage({
          kind: 'build',
          draftId: d.id,
          sources: d.sources,
          manifest: {
            version: 1,
            pages: [
              base,
              { ...base, id: crypto.randomUUID(), fitEdges: true, corners },
              {
                ...base,
                id: crypto.randomUUID(),
                fitEdges: true,
                corners,
                paperCleanupStrength: 0.5,
              },
            ],
          },
        });
      });
      // @ts-ignore production PDF.js module
      const pdfjs = await import('/pdfjs/pdf.min.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';
      const task = pdfjs.getDocument({
          data: new Uint8Array(result.bytes.slice(0)),
          wasmUrl: '/pdfjs/wasm/',
        }),
        doc = await task.promise,
        pages = [];
      for (let i = 1; i <= 3; i++) {
        const p = await doc.getPage(i),
          base = p.getViewport({ scale: 1 }),
          v = p.getViewport({ scale: 1400 / base.width }),
          canvas = document.createElement('canvas');
        canvas.width = Math.ceil(v.width);
        canvas.height = Math.ceil(v.height);
        const ctx = canvas.getContext('2d')!;
        await p.render({ canvas, canvasContext: ctx, viewport: v }).promise;
        const sample = (x: number, y: number) =>
          Array.from(
            ctx.getImageData(Math.round(x * canvas.width), Math.round(y * canvas.height), 1, 1)
              .data,
          ).slice(0, 3);
        const darkLine = (fraction: number) => {
          let min = 255;
          for (let offset = -3; offset <= 3; offset++) {
            const pixel = ctx.getImageData(
              Math.round(canvas.width * 0.4),
              Math.round(canvas.height * fraction) + offset,
              1,
              1,
            ).data;
            min = Math.min(min, pixel[0]);
          }
          return min;
        };
        pages.push({
          width: base.width,
          height: base.height,
          paper: sample(0.4, 0.47)[0],
          pencil: darkLine(0.5),
          faint: darkLine(0.508),
          staff: darkLine(0.1),
          color: sample(0.5, 0.66),
          image: canvas.toDataURL('image/png').split(',')[1],
        });
        canvas.width = canvas.height = 1;
      }
      await task.destroy();
      let binary = '';
      const bytes = new Uint8Array(result.bytes);
      for (let i = 0; i < bytes.length; i += 65536)
        binary += String.fromCharCode(...bytes.subarray(i, i + 65536));
      return { pdf: btoa(binary), metrics: result.metrics, pages };
    }, d);
    const bytes = Buffer.from(result.pdf, 'base64');
    expect(bytes.includes(original)).toBe(true);
    expect(bytes.length).toBeLessThan(5 * 1024 * 1024);
    expect(result.metrics.maxCanvasPixels).toBeLessThanOrEqual(4_000_000);
    expect(result.metrics.maxCanvasPixels).toBeGreaterThan(3_900_000);
    expect(result.metrics.maxCanvasEdge).toBeLessThanOrEqual(2800);
    expect(result.metrics.cvStartedWithBitmap).toBe(false);
    expect(result.metrics.openBitmaps).toBe(0);
    const pdf = await PDFDocument.load(bytes);
    const embeddedImages = pdf.getPages().map((page) => {
      const images: { width: number; height: number }[] = [];
      const inspect = (resources: PDFDict | undefined) => {
        const objects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
        if (!objects) return;
        for (const [, ref] of objects.entries()) {
          const stream = pdf.context.lookup(ref);
          if (!(stream instanceof PDFRawStream)) continue;
          if (stream.dict.get(PDFName.of('Subtype')) === PDFName.of('Image'))
            images.push({
              width: stream.dict.lookup(PDFName.of('Width'), PDFNumber).asNumber(),
              height: stream.dict.lookup(PDFName.of('Height'), PDFNumber).asNumber(),
            });
          else inspect(stream.dict.lookupMaybe(PDFName.of('Resources'), PDFDict));
        }
      };
      inspect(page.node.Resources());
      expect(images).toHaveLength(1);
      return images[0];
    });
    expect(embeddedImages[0].width * embeddedImages[0].height).toBe(20_000_000);
    for (const image of embeddedImages.slice(1)) {
      expect(image.width * image.height).toBeLessThanOrEqual(4_000_000);
      expect(Math.max(image.width, image.height)).toBeLessThanOrEqual(2800);
    }
    for (const p of result.pages) {
      expect(p.width / p.height).toBeCloseTo(0.8, 2);
      expect(p.paper - p.pencil).toBeGreaterThan(12);
      expect(p.paper - p.faint).toBeGreaterThan(5);
      expect(p.staff).toBeLessThan(130);
      expect(p.color[0] - p.color[1]).toBeGreaterThan(80);
    }
    expect(Math.abs(result.pages[1].pencil - result.pages[0].pencil)).toBeLessThan(15);
    expect(Math.abs(result.pages[1].faint - result.pages[0].faint)).toBeLessThan(12);
    for (let i = 0; i < 3; i++)
      await testInfo.attach(`20mp-page-${i + 1}`, {
        body: Buffer.from(result.pages[i].image, 'base64'),
        contentType: 'image/png',
      });
    await writeFile(
      testInfo.outputPath('20mp-metrics.json'),
      JSON.stringify(
        {
          bytes: bytes.length,
          metrics: result.metrics,
          pages: result.pages.map(({ image, ...p }) => p),
        },
        null,
        2,
      ),
    );
    await testInfo.attach('20mp-metrics', {
      body: JSON.stringify(
        {
          bytes: bytes.length,
          metrics: result.metrics,
          pages: result.pages.map(({ image, ...p }) => p),
        },
        null,
        2,
      ),
      contentType: 'application/json',
    });
  } finally {
    await request.delete(`/api/imports/${d.id}/`);
  }
});

test('typed angles clamp to both limits and repeated overflow displays the saved value', async ({
  page,
  request,
}) => {
  let d = await (await request.post('/api/imports/', { data: {} })).json();
  try {
    d = await (
      await request.post(`/api/imports/${d.id}/sources`, {
        multipart: {
          revision: String(d.revision),
          file: {
            name: 'score.pdf',
            mimeType: 'application/pdf',
            buffer: await readFile(resolve('../testdata/fixtures/noted-exercise.pdf')),
          },
        },
      })
    ).json();
    await page.goto(`/prepare/${d.id}`);
    await expect(page.locator('.page-surface img')).toBeVisible();
    const number = page.getByLabel('Angle in degrees'),
      slider = page.getByLabel('Straighten angle');
    await number.fill('');
    await number.pressSequentially('-4');
    await expect(number).toHaveValue('-4');
    await expect(slider).toHaveValue('-4');
    for (const [typed, value] of [
      ['99', '10'],
      ['23', '10'],
      ['-42', '-10'],
      ['-11', '-10'],
    ]) {
      await number.fill(typed);
      await expect(number).toHaveValue(value);
      await expect(slider).toHaveValue(value);
      await number.blur();
    }
    await page.getByRole('button', { name: 'Save draft & close' }).click();
    await expect(page).toHaveURL(/\/$/);
    const saved = await (await request.get(`/api/imports/${d.id}/`)).json();
    expect(saved.manifest.pages[0].angle).toBe(-10);
    await page.goto(`/prepare/${d.id}`);
    await expect(number).toHaveValue('-10');
    await expect(page.getByRole('alert')).not.toBeVisible();
  } finally {
    await request.delete(`/api/imports/${d.id}/`);
  }
});
