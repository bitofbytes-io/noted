export function inkGrid(image) {
  const grid = new Float64Array(64),
    counts = new Uint32Array(64);
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++) {
      const cell =
          Math.floor((y / image.height) * 8) * 8 +
          Math.floor((x / image.width) * 8),
        i = (y * image.width + x) * 4;
      counts[cell]++;
      grid[cell] += (255 - image.data[i]) / 255;
    }
  return [...grid].map((v, i) => v / counts[i]);
}
export function gridDifference(a, b) {
  const deltas = a.map((v, i) => Math.abs(v - b[i]));
  return {
    mean: deltas.reduce((a, b) => a + b, 0) / deltas.length,
    max: Math.max(...deltas),
  };
}
