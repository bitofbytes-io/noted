import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
// Original score-like test artwork dedicated to CC0-1.0. Not a transcription.
export async function detailScore() {
  const d = await PDFDocument.create(),
    f = await d.embedFont(StandardFonts.Helvetica);
  for (let pageID = 1; pageID <= 3; pageID++) {
    const p = d.addPage([600, 800]);
    p.drawText(`NOTED DETAIL STUDY / PAGE ${pageID}`, {
      x: 60,
      y: 750,
      size: 13,
      font: f,
    });
    p.drawText(
      "Original test notation - CC0 - inspect tiny details at playing size",
      { x: 60, y: 730, size: 9, font: f },
    );
    for (let system = 0; system < 6; system++) {
      const y = 660 - system * 98;
      for (let line = 0; line < 5; line++)
        p.drawLine({
          start: { x: 60, y: y + line * 7 },
          end: { x: 540, y: y + line * 7 },
          thickness: 0.55,
        });
      for (let n = 0; n < 9; n++) {
        const x = 82 + n * 50,
          ny = y + ((n + system + pageID) % 7) * 3.5;
        p.drawEllipse({
          x,
          y: ny,
          xScale: 3.7,
          yScale: 2.5,
          color: rgb(0, 0, 0),
        });
        p.drawLine({
          start: { x: x + 3.2, y: ny },
          end: { x: x + 3.2, y: ny + 26 },
          thickness: 0.65,
        });
        if (n % 3 === 0)
          p.drawCircle({ x: x + 8, y: ny + 2, size: 1.1, color: rgb(0, 0, 0) });
        if (n === 2 || n === 6)
          p.drawText(n === 2 ? "#" : "b", {
            x: x - 13,
            y: ny - 3,
            size: 13,
            font: f,
          });
        if (n % 4 === 0)
          p.drawText(String((n % 5) + 1), {
            x: x - 2,
            y: y + 39,
            size: 6,
            font: f,
          });
        if (n === 8) {
          p.drawLine({
            start: { x: x - 7, y: y - 7 },
            end: { x: x + 7, y: y - 7 },
            thickness: 0.55,
          });
          p.drawEllipse({
            x,
            y: y - 7,
            xScale: 3.7,
            yScale: 2.5,
            color: rgb(0, 0, 0),
          });
        }
      }
      p.drawSvgPath("M 0 0 C 18 -12 48 -12 68 0", {
        x: 220,
        y: y + 44,
        borderWidth: 0.6,
        borderColor: rgb(0, 0, 0),
      });
    }
    p.drawText(`EDGE DETAIL ${pageID} . # b 1 2 3`, {
      x: 60,
      y: 55,
      size: 8,
      font: f,
    });
  }
  return d.save({ useObjectStreams: false });
}
