# App icons

`web/public/noted-favicon-v3.svg` is the icon source. It keeps the Title Page
ivory paper, green binder spine and ink N. The opaque square artwork runs to
all four edges; iPadOS supplies the Home Screen corner mask. Do not add an
outer border, transparent padding or baked-in rounded corners. The N stays
inside the central area so the operating-system mask cannot clip it.

To regenerate the exports from the repository root with Python 3 and the
**development-only** Pillow package available:

```sh
python3 scripts/generate-icons.py
```

The generator supports the source's rectangles and polygon, renders each
size with 8x supersampling, and writes:

- `noted-apple-touch-icon-v3.png`: opaque RGB, 180 × 180.
- `noted-favicon-v3-32.png`: opaque RGB, 32 × 32.
- `noted-favicon-v3.ico`: 16 × 16, 32 × 32 and 48 × 48 entries.
- Matching `favicon.svg`, `favicon.ico` and `apple-touch-icon.png` fallbacks.

No image-generation package is needed by the app, its build or production.
Keep the versioned URLs in `web/src/index.html` and the auth marks in
`web/src/app/app.html` aligned. Older v2 assets remain for cached clients.

The new URL refreshes browser icon discovery. An existing iPad Home Screen
shortcut may retain its saved image; remove and add that shortcut again after
deployment if necessary. Physical iPad appearance is a separate manual check.
