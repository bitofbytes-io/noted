import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { gateBytes } from '../pipeline/alphatab-gate.mjs';

const fixture = path.resolve('testdata/fixtures/noted-exercise.musicxml');

test('loads MusicXML with stable master-bar ticks', async () => {
  const result = await gateBytes(new Uint8Array(fs.readFileSync(fixture)));
  assert.deepEqual(result, { status: 'passed', measureCount: 8, totalTicks: 30720 });
});

test('rejects malformed input', async () => {
  await assert.rejects(() => gateBytes(new TextEncoder().encode('<score-partwise>')));
});

test('rejects a rest-only score as unplayable', async () => {
  const rests = `<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Rest</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes><note><rest/><duration>4</duration><type>whole</type></note></measure></part></score-partwise>`;
  await assert.rejects(
    () => gateBytes(new TextEncoder().encode(rests)),
    /no timed pitched notes/,
  );
});
