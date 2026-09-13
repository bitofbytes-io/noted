import { PDFDocument, degrees } from "pdf-lib";
import cvModule from "@techstark/opencv-js";
await new Promise((resolve) => {
  if (cvModule.Mat) resolve();
  else cvModule.onRuntimeInitialized = resolve;
});
export const cv = cvModule;

export function validateManifest(manifest, counts) {
  if (
    manifest?.version !== 1 ||
    !Array.isArray(manifest.pages) ||
    !manifest.pages.length
  )
    throw Error("Invalid manifest");
  for (const p of manifest.pages) {
    if (
      !p ||
      typeof p !== "object" ||
      Object.keys(p).some(
        (k) =>
          ![
            "source",
            "page",
            "angle",
            "x",
            "y",
            "scale",
            "width",
            "height",
            "inkBounds",
          ].includes(k),
      )
    )
      throw Error("Unknown page operation");
    if (
      !Number.isInteger(p.source) ||
      !Number.isInteger(p.page) ||
      p.source < 0 ||
      p.page < 0 ||
      p.page >= (counts[p.source] ?? 0)
    )
      throw Error("Invalid source page");
    for (const key of ["angle", "x", "y", "scale", "width", "height"])
      if (p[key] !== undefined && !Number.isFinite(p[key]))
        throw Error(`Invalid ${key}`);
    if ((p.scale ?? 1) <= 0 || (p.width ?? 1) <= 0 || (p.height ?? 1) <= 0)
      throw Error("Invalid dimensions");
  }
}

// Matrices are applied to embedded original content, never a rendered PDF page.
export async function processPDF(sources, manifest) {
  const docs = await Promise.all(
    sources.map((bytes) => PDFDocument.load(bytes, { updateMetadata: false })),
  );
  validateManifest(
    manifest,
    docs.map((d) => d.getPageCount()),
  );
  if (
    sources.length === 1 &&
    manifest.pages.length === docs[0].getPageCount() &&
    manifest.pages.every(
      (p, i) =>
        p.source === 0 &&
        p.page === i &&
        Object.keys(p).every((k) => ["source", "page"].includes(k)),
    )
  )
    return sources[0];
  const out = await PDFDocument.create();
  for (const p of manifest.pages) {
    const original = docs[p.source].getPage(p.page);
    const media = original.getMediaBox(),
      crop = original.getCropBox();
    if (
      original.getRotation().angle % 360 !== 0 ||
      media.x !== 0 ||
      media.y !== 0 ||
      ["x", "y", "width", "height"].some((k) => crop[k] !== media[k])
    ) {
      throw Error(
        "Unsupported source page geometry: rotated or cropped pages require normalization before editing",
      );
    }
    const embed = await out.embedPage(original);
    const s = p.scale ?? 1,
      a = ((p.angle ?? 0) * Math.PI) / 180;
    const w = original.getWidth(),
      h = original.getHeight();
    const corners = [
      [0, 0],
      [w, 0],
      [w, h],
      [0, h],
    ].map(([x, y]) => [
      s * (x * Math.cos(a) - y * Math.sin(a)),
      s * (x * Math.sin(a) + y * Math.cos(a)),
    ]);
    const minX = Math.min(...corners.map((c) => c[0])),
      minY = Math.min(...corners.map((c) => c[1]));
    const maxX = Math.max(...corners.map((c) => c[0])),
      maxY = Math.max(...corners.map((c) => c[1]));
    const width = p.width ?? maxX - minX,
      height = p.height ?? maxY - minY;
    const x = p.x ?? -minX,
      y = p.y ?? -minY;
    // A crop requires measured ink bounds, otherwise only full-page preservation is allowed.
    const bounds = p.inkBounds ?? [0, 0, w, h];
    if (
      !Array.isArray(bounds) ||
      bounds.length !== 4 ||
      bounds.some((v) => !Number.isFinite(v)) ||
      bounds[2] <= bounds[0] ||
      bounds[3] <= bounds[1]
    )
      throw Error("Invalid ink bounds");
    const ink = [
      [bounds[0], bounds[1]],
      [bounds[2], bounds[1]],
      [bounds[2], bounds[3]],
      [bounds[0], bounds[3]],
    ].map(([u, v]) => [
      x + s * (u * Math.cos(a) - v * Math.sin(a)),
      y + s * (u * Math.sin(a) + v * Math.cos(a)),
    ]);
    if (
      ink.some(
        ([u, v]) =>
          u < -0.01 || v < -0.01 || u > width + 0.01 || v > height + 0.01,
      )
    )
      throw Error("Crop would clip content; expand page or revise crop");
    out.addPage([width, height]).drawPage(embed, {
      x,
      y,
      xScale: s,
      yScale: s,
      rotate: degrees(p.angle ?? 0),
    });
  }
  return out.save({ useObjectStreams: false });
}

// Analysis receives pixels only, never fixture angles or synthetic transformation settings.
export function suggestGeometry(image) {
  const src = cv.matFromImageData(image),
    gray = new cv.Mat(),
    edges = new cv.Mat(),
    lines = new cv.Mat();
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.Canny(gray, edges, 60, 160);
    cv.HoughLinesP(
      edges,
      lines,
      1,
      Math.PI / 3600,
      100,
      image.width * 0.35,
      12,
    );
    const candidates = [];
    for (let i = 0; i < lines.rows; i++) {
      const [x1, y1, x2, y2] = lines.data32S.slice(i * 4, i * 4 + 4);
      const angle = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
      if (Math.abs(angle) <= 10) candidates.push({ angle, x1, y1, x2, y2 });
    }
    if (candidates.length < 10)
      return {
        confident: false,
        reason: "Insufficient consistent staff lines",
      };
    candidates.sort((a, b) => a.angle - b.angle);
    const angle = candidates[Math.floor(candidates.length / 2)].angle;
    const agreeing = candidates.filter((l) => Math.abs(l.angle - angle) < 0.3);
    if (agreeing.length < candidates.length * 0.8)
      return { confident: false, reason: "Ambiguous line angles" };
    return {
      confident: true,
      angle,
      staffWidth: median(
        agreeing.map((l) => Math.hypot(l.x2 - l.x1, l.y2 - l.y1)),
      ),
      staffBounds: [
        Math.min(...agreeing.map((l) => Math.min(l.x1, l.x2))),
        Math.min(...agreeing.map((l) => Math.min(l.y1, l.y2))),
        Math.max(...agreeing.map((l) => Math.max(l.x1, l.x2))),
        Math.max(...agreeing.map((l) => Math.max(l.y1, l.y2))),
      ],
      lineCount: agreeing.length,
    };
  } finally {
    src.delete();
    gray.delete();
    edges.delete();
    lines.delete();
  }
}
export function median(values) {
  const v = [...values].sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
}
export function inkBounds(image) {
  let left = image.width,
    top = image.height,
    right = -1,
    bottom = -1;
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++) {
      const i = (y * image.width + x) * 4;
      if (
        image.data[i] < 220 &&
        image.data[i + 1] < 220 &&
        image.data[i + 2] < 220
      ) {
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
  if (right < 0) return null;
  return [left, top, right + 1, bottom + 1];
}
export function perspective(image, corners, width, height) {
  if (
    !Array.isArray(corners) ||
    corners.length !== 4 ||
    corners.some(
      (p) =>
        !Array.isArray(p) ||
        p.length !== 2 ||
        p.some((v) => !Number.isFinite(v)),
    )
  )
    throw Error("Invalid perspective corners");
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > 20000000
  )
    throw Error("Invalid output dimensions");
  const crosses = corners.map((p, i) => {
    const q = corners[(i + 1) % 4],
      r = corners[(i + 2) % 4];
    return (q[0] - p[0]) * (r[1] - q[1]) - (q[1] - p[1]) * (r[0] - q[0]);
  });
  if (crosses.some((v) => v <= 0))
    throw Error(
      "Perspective corners must form a clockwise convex quadrilateral",
    );
  const src = cv.matFromImageData(image),
    dst = new cv.Mat();
  const a = cv.matFromArray(4, 1, cv.CV_32FC2, corners.flat()),
    b = cv.matFromArray(4, 1, cv.CV_32FC2, [
      0,
      0,
      width - 1,
      0,
      width - 1,
      height - 1,
      0,
      height - 1,
    ]);
  const matrix = cv.getPerspectiveTransform(a, b);
  try {
    cv.warpPerspective(
      src,
      dst,
      matrix,
      new cv.Size(width, height),
      cv.INTER_CUBIC,
      cv.BORDER_CONSTANT,
      new cv.Scalar(255, 255, 255, 255),
    );
    return { data: new Uint8ClampedArray(dst.data), width, height };
  } finally {
    src.delete();
    dst.delete();
    a.delete();
    b.delete();
    matrix.delete();
  }
}
