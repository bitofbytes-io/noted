#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXPECTED_VERSION = "1.8.4";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const requireFromWeb = createRequire(
  pathToFileURL(path.join(REPO_ROOT, "web", "package.json")),
);

async function packageVersion(packageName) {
  let current = path.dirname(requireFromWeb.resolve(packageName));
  while (current !== path.dirname(current)) {
    const packagePath = path.join(current, "package.json");
    if (fs.existsSync(packagePath)) {
      const metadata = JSON.parse(fs.readFileSync(packagePath, "utf8"));
      if (metadata.name === packageName) return metadata.version;
    }
    current = path.dirname(current);
  }
  throw new Error(`Unable to locate ${packageName} package metadata`);
}

async function main() {
  const filename = process.argv[2];
  if (!filename) throw new Error("usage: alphatab-check.mjs MUSICXML_OR_MXL");
  const version = await packageVersion("@coderline/alphatab");
  if (version !== EXPECTED_VERSION) {
    throw new Error(`Expected alphaTab ${EXPECTED_VERSION}, found ${version}`);
  }
  const alphaTab = requireFromWeb("@coderline/alphatab");
  const score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(
    new Uint8Array(fs.readFileSync(filename)),
  );
  const tickTotals = score.masterBars.map((bar) => bar.calculateDuration());
  const startTicks = score.masterBars.map((bar) => bar.start);
  const saneTickTotals =
    tickTotals.length > 0 &&
    tickTotals.every((ticks) => Number.isFinite(ticks) && ticks > 0) &&
    startTicks.every(
      (ticks, index) =>
        Number.isFinite(ticks) &&
        (index === 0 || ticks >= startTicks[index - 1]),
    );
  let playablePitchedNotes = false;
  let saneStaffTiming = Array.isArray(score.tracks) && score.tracks.length > 0;
  for (const track of score.tracks ?? []) {
    if (!Array.isArray(track.staves) || track.staves.length < 1) {
      saneStaffTiming = false;
      continue;
    }
    for (const staff of track.staves) {
      if (!Array.isArray(staff.bars) || staff.bars.length !== score.masterBars.length) {
        saneStaffTiming = false;
        continue;
      }
      for (const bar of staff.bars) {
        const measureDuration = Number(score.masterBars[bar.index]?.calculateDuration());
        for (const voice of bar.voices ?? []) {
          for (const beat of voice.beats ?? []) {
            const start = Number(beat.displayStart);
            const duration = Number(beat.displayDuration);
            if (
              !Number.isFinite(start) ||
              !Number.isFinite(duration) ||
              start < 0 ||
              duration < 0 ||
              !Number.isFinite(measureDuration) ||
              start + duration > measureDuration
            ) {
              saneStaffTiming = false;
            }
            if (Array.isArray(beat.notes) && beat.notes.length > 0) {
              playablePitchedNotes = true;
            }
          }
        }
      }
    }
  }
  return {
    parseSuccess: true,
    alphaTabVersion: version,
    measureCount: score.masterBars.length,
    tickTotals,
    startTicks,
    saneTickTotals,
    saneStaffTiming,
    playablePitchedNotes,
    playabilitySuccess: saneTickTotals && saneStaffTiming && playablePitchedNotes,
  };
}

try {
  process.stdout.write(`${JSON.stringify(await main())}\n`);
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({ parseSuccess: false, alphaTabVersion: EXPECTED_VERSION, saneTickTotals: false, error: error.message })}\n`,
  );
  process.exitCode = 1;
}
