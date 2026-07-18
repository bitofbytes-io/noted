#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const OUTPUT_ROOT = path.resolve(process.argv[2] ?? SCRIPT_DIR);
const REFERENCE_DIR = path.join(OUTPUT_ROOT, "references");
const INPUT_DIR = path.join(OUTPUT_ROOT, "inputs");
const WEB_REQUIRE = createRequire(
  pathToFileURL(path.join(REPO_ROOT, "web", "package.json")),
);

const ALPHATAB_VERSION = "1.8.4";
const PLAYWRIGHT_VERSION = "1.55.1";

async function locatePackage(packageName) {
  let current = path.dirname(WEB_REQUIRE.resolve(packageName));
  while (current !== path.dirname(current)) {
    const packagePath = path.join(current, "package.json");
    try {
      const metadata = JSON.parse(await fs.readFile(packagePath, "utf8"));
      if (metadata.name === packageName) return { root: current, metadata };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    current = path.dirname(current);
  }
  throw new Error(`Unable to locate ${packageName}`);
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function note({
  step,
  octave,
  duration,
  type,
  voice = 1,
  staff = 1,
  alter = 0,
  chord = false,
  rest = false,
  accidental = "",
  tie = "",
}) {
  const pitch = rest
    ? "<rest/>"
    : `<pitch><step>${step}</step>${alter ? `<alter>${alter}</alter>` : ""}<octave>${octave}</octave></pitch>`;
  const tieElements = tie
    ? tie
        .split(",")
        .map((kind) => `<tie type="${kind}"/>`)
        .join("")
    : "";
  return `<note>${chord ? "<chord/>" : ""}${pitch}<duration>${duration}</duration>${tieElements}<voice>${voice}</voice><type>${type}</type>${accidental ? `<accidental>${accidental}</accidental>` : ""}<staff>${staff}</staff></note>`;
}

function scoreHeader(title) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <work><work-title>${xmlEscape(title)}</work-title></work>
  <identification>
    <creator type="composer">Noted Project</creator>
    <rights>CC0-1.0; original synthetic OMR benchmark fixture created for Noted</rights>
    <encoding><software>Noted testdata/omr/generate.mjs</software></encoding>
  </identification>
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">`;
}

function scoreFooter() {
  return "  </part>\n</score-partwise>\n";
}

function attributes(divisions) {
  return `<attributes><divisions>${divisions}</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>`;
}

function cleanSimpleMusicXML() {
  const upper = [
    [
      ["C", 5],
      ["D", 5],
      ["E", 5],
      ["G", 5],
    ],
    [
      ["F", 5],
      ["E", 5],
      ["D", 5],
      ["C", 5],
    ],
    [
      ["G", 4],
      ["C", 5],
      ["E", 5],
      ["G", 5],
    ],
    [
      ["A", 5],
      ["G", 5],
      ["F", 5],
      ["E", 5],
    ],
    [
      ["D", 5],
      ["F", 5],
      ["A", 5],
      ["C", 6],
    ],
    [
      ["B", 5],
      ["A", 5],
      ["G", 5],
      ["F", 5],
    ],
    [
      ["E", 5],
      ["D", 5],
      ["C", 5],
      ["C", 5],
    ],
    [
      ["C", 5],
      ["E", 5],
      ["G", 5],
      ["C", 6],
    ],
  ];
  const bass = [
    [
      ["C", 3],
      ["G", 3],
    ],
    [
      ["F", 2],
      ["C", 3],
    ],
    [
      ["C", 3],
      ["G", 2],
    ],
    [
      ["A", 2],
      ["E", 3],
    ],
    [
      ["D", 3],
      ["A", 2],
    ],
    [
      ["G", 2],
      ["D", 3],
    ],
    [
      ["G", 2],
      ["B", 2],
    ],
    [
      ["C", 3],
      ["C", 2],
    ],
  ];
  let xml = scoreHeader("Noted OMR Clean Exercise");
  for (let index = 0; index < upper.length; index += 1) {
    xml += `\n    <measure number="${index + 1}">${index === 0 ? attributes(4) : ""}`;
    for (let noteIndex = 0; noteIndex < upper[index].length; noteIndex += 1) {
      const [step, octave] = upper[index][noteIndex];
      const sharp = index === 4 && noteIndex === 1;
      xml += note({
        step,
        octave,
        duration: 4,
        type: "quarter",
        alter: sharp ? 1 : 0,
        accidental: sharp ? "sharp" : "",
        tie:
          index === 6 && noteIndex === 3
            ? "start"
            : index === 7 && noteIndex === 0
              ? "stop"
              : "",
      });
      if (noteIndex === 2 && index % 2 === 0) {
        xml += note({
          step: step === "E" ? "G" : "E",
          octave,
          duration: 4,
          type: "quarter",
          chord: true,
        });
      }
    }
    xml += "<backup><duration>16</duration></backup>";
    for (const [step, octave] of bass[index]) {
      xml += note({
        step,
        octave,
        duration: 8,
        type: "half",
        voice: 2,
        staff: 2,
      });
    }
    if (index === upper.length - 1)
      xml +=
        '<barline location="right"><bar-style>light-heavy</bar-style></barline>';
    xml += "</measure>";
  }
  return `${xml}\n${scoreFooter()}`;
}

const SCALE_STEPS = ["C", "D", "E", "F", "G", "A", "B"];

function densePolyphonyMusicXML() {
  let xml = scoreHeader("Noted OMR Dense Polyphony Study");
  for (let measureIndex = 0; measureIndex < 8; measureIndex += 1) {
    xml += `\n    <measure number="${measureIndex + 1}">${measureIndex === 0 ? attributes(8) : ""}`;
    for (let index = 0; index < 16; index += 1) {
      const degree = (measureIndex * 2 + index) % SCALE_STEPS.length;
      const step = SCALE_STEPS[degree];
      const octave = 4 + (Math.floor((measureIndex + index) / 9) % 2);
      const accidental = (measureIndex + index) % 11 === 5;
      xml += note({
        step,
        octave,
        duration: 2,
        type: "16th",
        alter: accidental ? 1 : 0,
        accidental: accidental ? "sharp" : "",
      });
      if (index % 2 === 1) {
        xml += note({
          step: SCALE_STEPS[(degree + 2) % SCALE_STEPS.length],
          octave,
          duration: 2,
          type: "16th",
          chord: true,
        });
      }
    }
    xml += "<backup><duration>32</duration></backup>";
    for (let beat = 0; beat < 4; beat += 1) {
      if ((measureIndex + beat) % 5 === 0) {
        xml += note({ rest: true, duration: 8, type: "quarter", voice: 2 });
      } else {
        const degree = (measureIndex + beat + 2) % SCALE_STEPS.length;
        xml += note({
          step: SCALE_STEPS[degree],
          octave: 4,
          duration: 8,
          type: "quarter",
          voice: 2,
        });
      }
    }
    xml += "<backup><duration>32</duration></backup>";
    for (let index = 0; index < 8; index += 1) {
      const degree = (measureIndex * 3 + index * 2) % SCALE_STEPS.length;
      xml += note({
        step: SCALE_STEPS[degree],
        octave: 2 + (index % 3 === 0 ? 1 : 0),
        duration: 4,
        type: "eighth",
        voice: 3,
        staff: 2,
      });
      if (index % 2 === 0) {
        xml += note({
          step: SCALE_STEPS[(degree + 4) % SCALE_STEPS.length],
          octave: 3,
          duration: 4,
          type: "eighth",
          voice: 3,
          staff: 2,
          chord: true,
        });
      }
    }
    if (measureIndex === 7)
      xml +=
        '<barline location="right"><bar-style>light-heavy</bar-style></barline>';
    xml += "</measure>";
  }
  return `${xml}\n${scoreFooter()}`;
}

function multipageStudyMusicXML() {
  let xml = scoreHeader("Noted OMR Multi-page Study");
  for (let measureIndex = 0; measureIndex < 40; measureIndex += 1) {
    xml += `\n    <measure number="${measureIndex + 1}">${measureIndex === 0 ? attributes(4) : ""}`;
    for (let index = 0; index < 8; index += 1) {
      const degree = (measureIndex + index) % SCALE_STEPS.length;
      xml += note({
        step: SCALE_STEPS[degree],
        octave: 4 + (Math.floor((measureIndex + index) / 7) % 2),
        duration: 2,
        type: "eighth",
      });
    }
    xml += "<backup><duration>16</duration></backup>";
    const bassDegree = (measureIndex * 4) % SCALE_STEPS.length;
    xml += note({
      step: SCALE_STEPS[bassDegree],
      octave: 2,
      duration: 16,
      type: "whole",
      voice: 2,
      staff: 2,
    });
    if (measureIndex === 39)
      xml +=
        '<barline location="right"><bar-style>light-heavy</bar-style></barline>';
    xml += "</measure>";
  }
  return `${xml}\n${scoreFooter()}`;
}

function renderPageHTML() {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Noted synthetic OMR fixture</title><style>
@page { size: letter; margin: 0.34in; }
html, body { margin: 0; padding: 0; background: #fff; }
body { font-family: Arial, sans-serif; color: #000; }
#score { width: 740px; margin: 0 auto; background: #fff; }
.at-surface { break-inside: avoid; page-break-inside: avoid; }
</style><script src="/alphaTab.js"></script></head>
<body><div id="score"></div><script>
window.renderMusicXML = (bytes, scale) => new Promise((resolve, reject) => {
  const container = document.getElementById('score');
  container.replaceChildren();
  const api = new alphaTab.AlphaTabApi(container, {
    core: { useWorkers: false, enableLazyLoading: false, fontDirectory: '/font/' },
    display: { layoutMode: alphaTab.LayoutMode.Page, scale, staveProfile: 'Default' },
    player: { enablePlayer: false }
  });
  let scoreLoaded = false;
  let settled = false;
  const fail = (error) => {
    if (settled) return;
    settled = true;
    reject(new Error(error && error.message ? error.message : String(error)));
  };
  api.error.on(fail);
  api.scoreLoaded.on((score) => {
    scoreLoaded = true;
    score.stylesheet.barNumberDisplay = alphaTab.model.BarNumberDisplay.AllBars;
    score.style ??= new alphaTab.model.ScoreStyle();
    score.style.headerAndFooter.set(
      alphaTab.model.ScoreSubElement.CopyrightSecondLine,
      new alphaTab.model.HeaderFooterStyle('', false)
    );
  });
  api.renderFinished.on(() => {
    if (!scoreLoaded || settled) return;
    setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({
        bars: api.score.masterBars.length,
        width: Math.ceil(container.getBoundingClientRect().width),
        height: Math.ceil(container.getBoundingClientRect().height)
      });
    }, 100);
  });
  if (!api.load(Uint8Array.from(bytes))) fail(new Error('alphaTab rejected the MusicXML bytes'));
});
</script></body></html>`;
}

async function startAssetServer(alphaTabRoot) {
  const alphaTabScript = path.join(alphaTabRoot, "dist", "alphaTab.js");
  const fontRoot = path.join(alphaTabRoot, "dist", "font");
  const html = renderPageHTML();
  const server = http.createServer(async (request, response) => {
    try {
      if (request.url === "/" || request.url === "/render.html") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(html);
        return;
      }
      if (request.url === "/alphaTab.js") {
        response.writeHead(200, {
          "Content-Type": "text/javascript; charset=utf-8",
        });
        response.end(await fs.readFile(alphaTabScript));
        return;
      }
      if (request.url?.startsWith("/font/")) {
        const filename = path.basename(
          new URL(request.url, "http://localhost").pathname,
        );
        const extension = path.extname(filename).toLowerCase();
        const contentTypes = {
          ".woff2": "font/woff2",
          ".woff": "font/woff",
          ".otf": "font/otf",
          ".svg": "image/svg+xml",
        };
        response.writeHead(200, {
          "Content-Type": contentTypes[extension] ?? "application/octet-stream",
        });
        response.end(await fs.readFile(path.join(fontRoot, filename)));
        return;
      }
      response.writeHead(404);
      response.end("not found");
    } catch (error) {
      response.writeHead(500);
      response.end(error.message);
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/render.html`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function normalizePDF(pdf) {
  let contents = pdf.toString("latin1");
  contents = contents.replace(
    /\/(CreationDate|ModDate) \(([^)]*)\)/g,
    (match, field, value) => {
      const fixed = "D:20000101000000+00'00'"
        .padEnd(value.length, " ")
        .slice(0, value.length);
      return `/${field} (${fixed})`;
    },
  );
  return Buffer.from(contents, "latin1");
}

async function renderScore(page, serverURL, musicXML, scale = 0.72) {
  await page.goto(serverURL, { waitUntil: "load" });
  return page.evaluate(
    ({ bytes, requestedScale }) => window.renderMusicXML(bytes, requestedScale),
    { bytes: [...Buffer.from(musicXML)], requestedScale: scale },
  );
}

async function writeScorePDF(page, serverURL, musicXML, destination, scale, pageRanges) {
  await renderScore(page, serverURL, musicXML, scale);
  await page.emulateMedia({ media: "print" });
  const pdf = await page.pdf({
    format: "Letter",
    printBackground: true,
    displayHeaderFooter: false,
    margin: {
      top: "0.34in",
      right: "0.34in",
      bottom: "0.34in",
      left: "0.34in",
    },
    preferCSSPageSize: true,
    tagged: false,
    outline: false,
    ...(pageRanges ? { pageRanges } : {}),
  });
  await fs.writeFile(destination, normalizePDF(pdf));
}

async function writeNoisyPDF(page, serverURL, musicXML, destination) {
  await renderScore(page, serverURL, musicXML, 0.72);
  const score = page.locator("#score");
  const raster = await score.screenshot({ type: "jpeg", quality: 48 });
  const noiseMarks = Array.from({ length: 90 }, (_, index) => {
    const x = (index * 73 + 19) % 760;
    const y = (index * 137 + 41) % 960;
    const opacity = 0.02 + ((index * 17) % 7) / 200;
    return `<i style="left:${x}px;top:${y}px;opacity:${opacity}"></i>`;
  }).join("");
  await page.setContent(`<!doctype html><html><head><title>Noted synthetic OMR fixture</title><style>
    @page { size: letter; margin: 0; }
    html,body { width: 8.5in; height: 11in; margin: 0; overflow: hidden; background: #d9d4c8; }
    .scan { position: relative; box-sizing: border-box; width: 7.85in; height: 10.35in; margin: .31in; overflow: hidden;
      background: #efede4; transform: rotate(.55deg); box-shadow: inset 10px 0 20px rgba(45,35,20,.18); }
    img { position: absolute; width: 7.45in; left: .2in; top: .38in; filter: grayscale(1) contrast(.78) brightness(1.08) blur(.22px); opacity: .9; }
    .scan::after { content: ''; position:absolute; inset:0; background: linear-gradient(104deg, rgba(70,55,35,.11), transparent 15%, transparent 72%, rgba(80,60,35,.09)); mix-blend-mode:multiply; }
    i { position:absolute; width:2px; height:2px; border-radius:50%; background:#201c18; }
    .pencil { position:absolute; width:95px; height:1px; background:rgba(40,40,40,.25); transform:rotate(-14deg); left:590px; top:580px; }
  </style></head><body><div class="scan"><img src="data:image/jpeg;base64,${raster.toString("base64")}">${noiseMarks}<span class="pencil"></span></div></body></html>`);
  await page.waitForFunction(
    () => document.images.length === 1 && document.images[0].complete,
  );
  const pdf = await page.pdf({
    format: "Letter",
    printBackground: true,
    margin: { top: "0", right: "0", bottom: "0", left: "0" },
  });
  await fs.writeFile(destination, normalizePDF(pdf));
}

function pdfPageCount(contents) {
  return (contents.toString("latin1").match(/\/Type\s*\/Page\b/g) ?? []).length;
}

async function sha256(filename) {
  return crypto
    .createHash("sha256")
    .update(await fs.readFile(filename))
    .digest("hex");
}

async function main() {
  const alphaTabPackage = await locatePackage("@coderline/alphatab");
  const playwrightPackage = await locatePackage("@playwright/test");
  if (alphaTabPackage.metadata.version !== ALPHATAB_VERSION) {
    throw new Error(
      `Expected alphaTab ${ALPHATAB_VERSION}, found ${alphaTabPackage.metadata.version}`,
    );
  }
  if (playwrightPackage.metadata.version !== PLAYWRIGHT_VERSION) {
    throw new Error(
      `Expected Playwright ${PLAYWRIGHT_VERSION}, found ${playwrightPackage.metadata.version}`,
    );
  }

  await fs.mkdir(REFERENCE_DIR, { recursive: true });
  await fs.mkdir(INPUT_DIR, { recursive: true });
  const references = {
    "clean-simple.musicxml": cleanSimpleMusicXML(),
    "dense-polyphony.musicxml": densePolyphonyMusicXML(),
    "multipage-study.musicxml": multipageStudyMusicXML(),
  };
  for (const [filename, contents] of Object.entries(references)) {
    await fs.writeFile(path.join(REFERENCE_DIR, filename), contents);
  }

  const { chromium } = WEB_REQUIRE("@playwright/test");
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    try {
      browser = await chromium.launch({ headless: true, channel: "chrome" });
    } catch {
      throw new Error(
        `Unable to launch pinned Playwright Chromium or installed Chrome: ${error.message}`,
      );
    }
  }
  const assetServer = await startAssetServer(alphaTabPackage.root);
  try {
    const page = await browser.newPage({
      viewport: { width: 900, height: 1200 },
      deviceScaleFactor: 1,
    });
    await writeScorePDF(
      page,
      assetServer.url,
      references["clean-simple.musicxml"],
      path.join(INPUT_DIR, "clean-simple.pdf"),
      0.72,
    );
    await writeNoisyPDF(
      page,
      assetServer.url,
      references["clean-simple.musicxml"],
      path.join(INPUT_DIR, "noisy-simple.pdf"),
    );
    await writeScorePDF(
      page,
      assetServer.url,
      references["dense-polyphony.musicxml"],
      path.join(INPUT_DIR, "dense-polyphony.pdf"),
      0.62,
    );
    await writeScorePDF(
      page,
      assetServer.url,
      references["multipage-study.musicxml"],
      path.join(INPUT_DIR, "multipage-study.pdf"),
      0.68,
      "1-2",
    );
    await page.close();

    const generatedFiles = {
      cleanReference: path.join(REFERENCE_DIR, "clean-simple.musicxml"),
      denseReference: path.join(REFERENCE_DIR, "dense-polyphony.musicxml"),
      multipageReference: path.join(REFERENCE_DIR, "multipage-study.musicxml"),
      cleanInput: path.join(INPUT_DIR, "clean-simple.pdf"),
      noisyInput: path.join(INPUT_DIR, "noisy-simple.pdf"),
      denseInput: path.join(INPUT_DIR, "dense-polyphony.pdf"),
      multipageInput: path.join(INPUT_DIR, "multipage-study.pdf"),
    };
    const hashes = Object.fromEntries(
      await Promise.all(
        Object.entries(generatedFiles).map(async ([key, filename]) => [
          key,
          await sha256(filename),
        ]),
      ),
    );
    const pages = Object.fromEntries(
      await Promise.all(
        ["cleanInput", "noisyInput", "denseInput", "multipageInput"].map(
          async (key) => [
            key,
            pdfPageCount(await fs.readFile(generatedFiles[key])),
          ],
        ),
      ),
    );
    const sharedProvenance = {
      creator: "Noted Project",
      license: "CC0-1.0",
      sourceType: "project-authored synthetic notation",
      thirdPartyScoreSource: false,
      generationCommand: "node testdata/omr/generate.mjs",
      renderer: `@coderline/alphatab ${ALPHATAB_VERSION} via @playwright/test ${PLAYWRIGHT_VERSION}`,
    };
    const manifest = {
      schemaVersion: 1,
      corpus: "Noted synthetic OMR benchmark corpus",
      license: "CC0-1.0",
      generatedBy: "testdata/omr/generate.mjs",
      toolVersions: {
        alphaTab: ALPHATAB_VERSION,
        playwright: PLAYWRIGHT_VERSION,
        browser: browser.version(),
      },
      fixtures: [
        {
          id: "clean-simple",
          title: "Clean simple piano engraving",
          input: "inputs/clean-simple.pdf",
          reference: "references/clean-simple.musicxml",
          traits: [
            "clean",
            "piano",
            "grand-staff",
            "chords",
            "accidental",
            "tie",
          ],
          expected: { parts: 1, measures: 8, pages: pages.cleanInput },
          sha256: {
            input: hashes.cleanInput,
            reference: hashes.cleanReference,
          },
          provenance: sharedProvenance,
        },
        {
          id: "noisy-simple",
          title: "Rasterized low-quality scan simulation",
          input: "inputs/noisy-simple.pdf",
          reference: "references/clean-simple.musicxml",
          traits: [
            "noisy",
            "raster",
            "low-contrast",
            "skew",
            "synthetic-marks",
            "piano",
          ],
          expected: { parts: 1, measures: 8, pages: pages.noisyInput },
          sha256: {
            input: hashes.noisyInput,
            reference: hashes.cleanReference,
          },
          provenance: {
            ...sharedProvenance,
            degradation:
              "deterministic JPEG rasterization, skew, contrast loss, shading, speckle, and synthetic pencil mark",
          },
        },
        {
          id: "dense-polyphony",
          title: "Dense multi-voice piano texture",
          input: "inputs/dense-polyphony.pdf",
          reference: "references/dense-polyphony.musicxml",
          traits: [
            "clean",
            "dense",
            "polyphonic",
            "three-voices",
            "16th-notes",
            "chords",
            "rests",
            "accidentals",
          ],
          expected: { parts: 1, measures: 8, pages: pages.denseInput },
          sha256: {
            input: hashes.denseInput,
            reference: hashes.denseReference,
          },
          provenance: sharedProvenance,
        },
        {
          id: "multipage-study",
          title: "Forty-measure multi-page piano study",
          input: "inputs/multipage-study.pdf",
          reference: "references/multipage-study.musicxml",
          traits: ["clean", "multipage", "piano", "grand-staff", "40-measures"],
          expected: {
            parts: 1,
            measures: 40,
            pages: pages.multipageInput,
            minimumPages: 2,
          },
          sha256: {
            input: hashes.multipageInput,
            reference: hashes.multipageReference,
          },
          provenance: sharedProvenance,
        },
      ],
    };
    await fs.writeFile(
      path.join(OUTPUT_ROOT, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  } finally {
    await assetServer.close();
    await browser.close();
  }
}

await main();
