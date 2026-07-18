#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const EXPECTED_VERSION = '1.8.4';
const MAX_SCORE_BYTES = 25 * 1024 * 1024;

async function loadAlphaTab() {
  const override = process.env.NOTED_ALPHATAB_MODULE;
  if (override) {
    return import(override.startsWith('file:') ? override : pathToFileURL(override).href);
  }
  return import('@coderline/alphatab');
}

export function installedVersion() {
  if (process.env.NOTED_ALPHATAB_MODULE) {
    return process.env.NOTED_ALPHATAB_VERSION || EXPECTED_VERSION;
  }
  const require = createRequire(import.meta.url);
  let directory = path.dirname(require.resolve('@coderline/alphatab'));
  while (directory !== path.dirname(directory)) {
    const packagePath = path.join(directory, 'package.json');
    if (fs.existsSync(packagePath)) {
      const metadata = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
      if (metadata.name === '@coderline/alphatab') {
        return metadata.version;
      }
    }
    directory = path.dirname(directory);
  }
  throw new Error('alphaTab package metadata could not be located');
}

export async function gateBytes(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_SCORE_BYTES) {
    throw new Error('score is empty or exceeds the alphaTab input limit');
  }
  if (installedVersion() !== EXPECTED_VERSION) {
    throw new Error(`alphaTab version mismatch: expected ${EXPECTED_VERSION}`);
  }
  const alphaTab = await loadAlphaTab();
  const settings = new alphaTab.Settings();
  settings.core.useWorkers = false;
  const score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(bytes, settings);
  if (!score || !Array.isArray(score.tracks) || score.tracks.length < 1) {
    throw new Error('alphaTab imported no tracks');
  }
  if (!Array.isArray(score.masterBars) || score.masterBars.length < 1) {
    throw new Error('alphaTab imported no master bars');
  }
  let totalTicks = 0;
  for (const masterBar of score.masterBars) {
    const duration = Number(masterBar.calculateDuration());
    if (!Number.isSafeInteger(duration) || duration <= 0) {
      throw new Error(`alphaTab produced an invalid duration for measure ${masterBar.index + 1}`);
    }
    totalTicks += duration;
    if (!Number.isSafeInteger(totalTicks)) {
      throw new Error('alphaTab total tick count overflowed');
    }
  }
  let playableBeatSeen = false;
  for (const track of score.tracks) {
    if (!Array.isArray(track.staves) || track.staves.length < 1) {
      throw new Error('alphaTab imported a track without staves');
    }
    for (const staff of track.staves) {
      if (!Array.isArray(staff.bars) || staff.bars.length !== score.masterBars.length) {
        throw new Error('alphaTab produced inconsistent measure counts across staves');
      }
      for (const bar of staff.bars) {
        const measureDuration = Number(score.masterBars[bar.index].calculateDuration());
        for (const voice of bar.voices ?? []) {
          for (const beat of voice.beats ?? []) {
            const start = Number(beat.displayStart);
            const duration = Number(beat.displayDuration);
            if (!Number.isFinite(start) || !Number.isFinite(duration) || start < 0 || duration < 0) {
              throw new Error(`alphaTab produced invalid beat timing in measure ${bar.index + 1}`);
            }
            if (start + duration > measureDuration) {
              throw new Error(`alphaTab produced overflowing beat timing in measure ${bar.index + 1}`);
            }
            if (Array.isArray(beat.notes) && beat.notes.length > 0) {
              playableBeatSeen = true;
            }
          }
        }
      }
    }
  }
  if (!playableBeatSeen) {
    throw new Error('alphaTab imported no timed pitched notes');
  }
  return { status: 'passed', measureCount: score.masterBars.length, totalTicks };
}

export async function gateFile(input, output) {
  const stat = fs.statSync(input);
  if (!stat.isFile() || stat.size < 1 || stat.size > MAX_SCORE_BYTES) {
    throw new Error('score is empty or exceeds the alphaTab input limit');
  }
  const result = await gateBytes(new Uint8Array(fs.readFileSync(input)));
  const temporary = `${output}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(result), { mode: 0o600 });
  fs.renameSync(temporary, output);
  return result;
}

async function main(argv) {
  if (argv.length === 1 && argv[0] === '--version') {
    const version = installedVersion();
    if (version !== EXPECTED_VERSION) {
      throw new Error(`alphaTab version mismatch: got ${version}, expected ${EXPECTED_VERSION}`);
    }
    process.stdout.write(`${version}\n`);
    return;
  }
  if (argv.length !== 2) {
    throw new Error('usage: alphatab-gate.mjs SCORE.musicxml RESULT.json');
  }
  await gateFile(argv[0], argv[1]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`alphaTab playability gate failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
