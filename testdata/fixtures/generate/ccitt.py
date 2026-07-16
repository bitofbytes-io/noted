"""Generate the synthetic CCITT Group 4 PDF used by the PDF.js regression test."""

from io import BytesIO
from pathlib import Path

from PIL import Image, ImageDraw


WIDTH, HEIGHT = 1200, 1600
image = Image.new("1", (WIDTH, HEIGHT), 1)
draw = ImageDraw.Draw(image)
draw.text((110, 80), "NOTED CCITT SCORE - CC0 TEST FIXTURE", fill=0)
for system_top in (220, 700):
    for staff_offset in (0, 180):
        for line in range(5):
            y = system_top + staff_offset + line * 20
            draw.line((100, y, 1100, y), fill=0, width=3)
        for measure in range(9):
            x = 100 + measure * 125
            draw.line((x, system_top + staff_offset, x, system_top + staff_offset + 80), fill=0, width=3)
        for note in range(8):
            x = 155 + note * 125
            y = system_top + staff_offset + 60 - (note % 4) * 20
            draw.ellipse((x - 10, y - 7, x + 10, y + 7), fill=0)
            draw.line((x + 9, y, x + 9, y - 60), fill=0, width=3)

tiff_data = BytesIO()
image.save(tiff_data, format="TIFF", compression="group4")
tiff_data.seek(0)
tiff = Image.open(tiff_data)
offsets = tiff.tag_v2[273]
counts = tiff.tag_v2[279]
raw_tiff = tiff_data.getvalue()
ccitt = b"".join(raw_tiff[offset : offset + count] for offset, count in zip(offsets, counts))

content = b"q\n540 0 0 720 36 36 cm\n/Im0 Do\nQ\n"
objects = [
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>",
    (
        f"<< /Type /XObject /Subtype /Image /Width {WIDTH} /Height {HEIGHT} "
        "/ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /CCITTFaxDecode "
        f"/DecodeParms << /K -1 /Columns {WIDTH} /Rows {HEIGHT} /BlackIs1 true >> /Length {len(ccitt)} >>\nstream\n"
    ).encode()
    + ccitt
    + b"\nendstream",
    f"<< /Length {len(content)} >>\nstream\n".encode() + content + b"endstream",
]

pdf = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
offsets = [0]
for number, obj in enumerate(objects, start=1):
    offsets.append(len(pdf))
    pdf.extend(f"{number} 0 obj\n".encode())
    pdf.extend(obj)
    pdf.extend(b"\nendobj\n")
xref = len(pdf)
pdf.extend(f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode())
for offset in offsets[1:]:
    pdf.extend(f"{offset:010d} 00000 n \n".encode())
pdf.extend(
    f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
)

destination = Path(__file__).parents[1] / "noted-ccitt-exercise.pdf"
destination.write_bytes(pdf)
print(destination)
