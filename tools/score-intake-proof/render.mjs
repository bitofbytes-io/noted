import { createCanvas, DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";
import { fileURLToPath } from "node:url";
globalThis.DOMMatrix = DOMMatrix;
globalThis.ImageData = ImageData;
globalThis.Path2D = Path2D;
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const base = fileURLToPath(
  new URL("./node_modules/pdfjs-dist/", import.meta.url),
);
export async function render(bytes, scale = 1) {
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    wasmUrl: base + "wasm/",
    standardFontDataUrl: base + "standard_fonts/",
    useSystemFonts: false,
  });
  const doc = await task.promise;
  const images = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const p = await doc.getPage(n),
        v = p.getViewport({ scale }),
        canvas = createCanvas(Math.ceil(v.width), Math.ceil(v.height));
      await p.render({ canvasContext: canvas.getContext("2d"), viewport: v })
        .promise;
      images.push(canvas);
    }
  } finally {
    await task.destroy();
  }
  return images;
}
export function pixels(canvas) {
  return canvas
    .getContext("2d")
    .getImageData(0, 0, canvas.width, canvas.height);
}
export function canvasFrom(image) {
  const c = createCanvas(image.width, image.height);
  c.getContext("2d").putImageData(
    new ImageData(image.data, image.width, image.height),
    0,
    0,
  );
  return c;
}
export async function textContent(bytes) {
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    wasmUrl: base + "wasm/",
    standardFontDataUrl: base + "standard_fonts/",
  });
  const doc = await task.promise;
  let text = "";
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const p = await doc.getPage(i);
      text +=
        (await p.getTextContent()).items.map((v) => v.str).join(" ") + "\n";
    }
  } finally {
    await task.destroy();
  }
  return text;
}
