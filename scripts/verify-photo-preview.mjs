import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";

const baseURL = process.env.NOTED_E2E_BASE_URL || "http://localhost:4200";
const repository = process.env.NOTED_REPOSITORY_ROOT;
if (!repository) throw new Error("NOTED_REPOSITORY_ROOT is required.");

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();
let draftID;

try {
  const created = await context.request.post(`${baseURL}/api/imports/`, {
    data: {},
  });
  if (!created.ok())
    throw new Error(`Draft creation failed with ${created.status()}.`);
  let draft = await created.json();
  draftID = draft.id;
  const uploaded = await context.request.post(
    `${baseURL}/api/imports/${draft.id}/sources`,
    {
      multipart: {
        revision: String(draft.revision),
        file: {
          name: "noted-photo-20mp.jpg",
          mimeType: "image/jpeg",
          buffer: await readFile(
            join(repository, "testdata/fixtures/noted-photo-20mp.jpg"),
          ),
        },
      },
    },
  );
  if (!uploaded.ok())
    throw new Error(`Fixture upload failed with ${uploaded.status()}.`);
  draft = await uploaded.json();
  await page.goto(`${baseURL}/prepare/${draft.id}`);

  const result = await page.evaluate(async (current) => {
    const source = current.sources[0];
    const sourceResponse = await fetch(
      `/api/imports/${current.id}/sources/${source.id}`,
    );
    const sourceBitmap = await createImageBitmap(await sourceResponse.blob());
    const sourceScale = Math.min(
      1,
      1050 / Math.max(sourceBitmap.width, sourceBitmap.height),
    );
    const sourceCanvas = new OffscreenCanvas(
      Math.round(sourceBitmap.width * sourceScale),
      Math.round(sourceBitmap.height * sourceScale),
    );
    sourceCanvas
      .getContext("2d")
      .drawImage(sourceBitmap, 0, 0, sourceCanvas.width, sourceCanvas.height);
    sourceBitmap.close();
    const raster = await sourceCanvas.convertToBlob({ type: "image/png" });
    sourceCanvas.width = sourceCanvas.height = 1;

    const run = (payload) =>
      new Promise((resolve, reject) => {
        const worker = new Worker("/intake/processing-worker.js");
        const requestId = crypto.randomUUID();
        const timer = setTimeout(() => {
          worker.terminate();
          reject(
            new Error(
              `The processing worker did not answer ${payload.kind} in 120 seconds.`,
            ),
          );
        }, 120_000);
        worker.onerror = () => {
          clearTimeout(timer);
          worker.terminate();
          reject(new Error("The processing worker failed."));
        };
        worker.onmessage = ({ data }) => {
          if (data.requestId !== requestId || data.progress) return;
          clearTimeout(timer);
          worker.terminate();
          if (data.error) reject(new Error(data.error));
          else resolve(data);
        };
        try {
          worker.postMessage({ ...payload, requestId });
        } catch (error) {
          clearTimeout(timer);
          worker.terminate();
          reject(error);
        }
      });
    const edit = {
      ...current.manifest.pages[0],
      paperCleanupStrength: 0.55,
      corners: [
        [0.03, 0.02],
        [0.98, 0.04],
        [0.97, 0.98],
        [0.02, 0.96],
      ],
      fitEdges: true,
      angle: 1.5,
      margins: [5, 7, 9, 11],
    };
    const preview = await run({ kind: "preview", raster, edit, maxEdge: 1050 });
    const prepared = await run({
      kind: "build",
      draftId: current.id,
      sources: current.sources,
      manifest: { version: 1, pages: [edit] },
    });
    // A source descriptor with no uploaded object proves that the first final
    // page is copied from the prepared PDF rather than fetched or transformed.
    const absentSource = {
      ...source,
      id: crypto.randomUUID(),
      checksum: "rights-safe-harness-absent-source",
    };
    const preparedKey = "rights-safe-harness-prepared-page";
    const final = await run({
      kind: "build",
      draftId: current.id,
      sources: [...current.sources, absentSource],
      manifest: {
        version: 1,
        pages: [
          { ...edit, sourceId: absentSource.id },
          { ...edit, id: crypto.randomUUID(), rotation: 90 },
        ],
      },
      prepared: [{ key: preparedKey, bytes: prepared.bytes }],
      preparedKeys: [preparedKey, ""],
    });
    const pdfjs = await import("/pdfjs/pdf.min.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
    const task = pdfjs.getDocument({
      data: new Uint8Array(final.bytes),
      wasmUrl: "/pdfjs/wasm/",
    });

    try {
      const pdf = await task.promise;
      const render = async (pageNumber) => {
        const pdfPage = await pdf.getPage(pageNumber);
        const base = pdfPage.getViewport({ scale: 1 });
        const viewport = pdfPage.getViewport({
          scale: 1050 / Math.max(base.width, base.height),
        });
        const canvas = new OffscreenCanvas(
          Math.round(viewport.width),
          Math.round(viewport.height),
        );
        await pdfPage.render({
          canvas,
          canvasContext: canvas.getContext("2d"),
          viewport,
        }).promise;
        return canvas;
      };
      const finalFirst = await render(1);
      const finalSecond = await render(2);
      const previewBitmap = await createImageBitmap(preview.blob);
      const sampleSize = 160;
      const sample = (image) => {
        const canvas = new OffscreenCanvas(sampleSize, sampleSize);
        const context = canvas.getContext("2d");
        context.fillStyle = "white";
        context.fillRect(0, 0, sampleSize, sampleSize);
        context.drawImage(image, 0, 0, sampleSize, sampleSize);
        return context.getImageData(0, 0, sampleSize, sampleSize).data;
      };
      const previewPixels = sample(previewBitmap);
      const finalPixels = sample(finalFirst);
      previewBitmap.close();
      let difference = 0;
      let dark = 0;
      let faint = 0;
      let red = 0;
      let brightness = 0;
      for (let index = 0; index < finalPixels.length; index += 4) {
        const r = finalPixels[index];
        const g = finalPixels[index + 1];
        const b = finalPixels[index + 2];
        const gray = (r + g + b) / 3;
        brightness += gray;
        if (gray < 120) dark++;
        if (
          gray >= 145 &&
          gray < 230 &&
          Math.max(r, g, b) - Math.min(r, g, b) < 15
        )
          faint++;
        if (r - g > 45 && r - b > 30) red++;
        difference +=
          Math.abs(r - previewPixels[index]) +
          Math.abs(g - previewPixels[index + 1]) +
          Math.abs(b - previewPixels[index + 2]);
      }
      return {
        pages: pdf.numPages,
        previewAspect: preview.width / preview.height,
        firstAspect: finalFirst.width / finalFirst.height,
        secondAspect: finalSecond.width / finalSecond.height,
        meanDifference: difference / (sampleSize * sampleSize * 3),
        meanBrightness: brightness / (sampleSize * sampleSize),
        dark,
        faint,
        red,
      };
    } finally {
      await task.destroy();
    }
  }, draft);

  const failures = [];
  if (result.pages !== 2)
    failures.push(`expected 2 ordered pages, received ${result.pages}`);
  if (result.firstAspect >= 1 || result.secondAspect <= 1)
    failures.push("quarter-turn page order or geometry is wrong");
  if (Math.abs(result.previewAspect - result.firstAspect) > 0.015)
    failures.push("preview and final page geometry differ");
  if (result.meanDifference > 24)
    failures.push("preview and final pixels differ too much");
  if (result.meanBrightness < 225)
    failures.push("paper cleanup did not lighten the page");
  if (result.dark < 80) failures.push("dark staff and note detail was lost");
  if (result.faint < 8) failures.push("faint pencil detail was lost");
  if (result.red < 8) failures.push("the color detail was lost");
  if (failures.length) throw new Error(failures.join("; "));
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (draftID)
    await context.request.delete(`${baseURL}/api/imports/${draftID}/`);
  await context.close();
  await browser.close();
}
