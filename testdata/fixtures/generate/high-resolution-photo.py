"""Original CC0 20MP photo-like detail fixture; requires Pillow."""
from pathlib import Path
from PIL import Image, ImageDraw
image = Image.new('RGB', (4000, 5000), (235, 235, 235))
draw = ImageDraw.Draw(image)
for top in [500, 1100, 1700, 2900, 3500, 4100]:
    for line in range(5):
        draw.line((300, top + line * 28, 3700, top + line * 28), fill=(35, 35, 35), width=3)
    for x in range(500, 3600, 180):
        draw.ellipse((x - 14, top + 34, x + 14, top + 52), fill=(25, 25, 25))
        draw.line((x + 13, top + 44, x + 13, top - 48), fill=(35, 35, 35), width=4)
        draw.ellipse((x + 32, top + 35, x + 40, top + 43), fill=(40, 40, 40))
# Faint pencil, thin strokes, and a color mark at known coordinates.
draw.line((400, 2500, 3600, 2500), fill=(200, 200, 200), width=5)
draw.line((400, 2540, 3600, 2540), fill=(215, 215, 215), width=5)
draw.rectangle((1800, 3250, 2200, 3350), fill=(180, 55, 65))
image.save(Path(__file__).parent.parent / 'noted-photo-20mp.jpg', quality=98, subsampling=0)
