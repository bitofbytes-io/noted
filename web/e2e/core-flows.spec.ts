import { expect, test } from '@playwright/test';
import path from 'node:path';

const seededWork = 'Noted POC Exercise in C';
const fixtureRoot = path.resolve(process.cwd(), '../testdata/fixtures');

test.describe.serial('Noted core POC flows', () => {
  test('Flow A: open a seeded PDF and render/play a measure range', async ({ page }, testInfo) => {
    await page.goto('/home');
    await expect(page.getByRole('heading', { name: 'Pick up where you left off.' })).toBeVisible();
    await expect(page.getByText('Monday–Sunday')).toBeVisible();
    await expect(page.getByRole('link', { name: seededWork })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('dashboard.png'), fullPage: true });

    await page.getByRole('link', { name: seededWork }).click();
    await expect(page.getByRole('heading', { name: seededWork })).toBeVisible();
    await expect(
      page.getByText('Original fixture dedicated to the public domain').first(),
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('work-details.png'), fullPage: true });

    await page.getByRole('link', { name: 'Read' }).click();
    const canvas = page.locator('.pdf-stage canvas');
    await expect(canvas).toBeVisible();
    await expect
      .poll(async () => canvas.evaluate((node: HTMLCanvasElement) => node.width))
      .toBeGreaterThan(100);
    await page.screenshot({ path: testInfo.outputPath('pdf-reader.png') });

    await page.getByLabel('Back to work').click();
    await page.getByRole('link', { name: 'Play' }).click();
    await expect(page.locator('.topbar')).toHaveCount(0);
    await expect(page.locator('.bottom-nav')).toHaveCount(0);
    const playerShell = page.locator('.player-shell');
    await expect(playerShell).toBeVisible();
    await expect
      .poll(async () => (await playerShell.boundingBox())?.height ?? 0)
      .toBeGreaterThanOrEqual((page.viewportSize()?.height ?? 1) - 1);
    await expect(page.getByRole('button', { name: /Measures 1–8/ })).toBeVisible();
    await expect(page.locator('.notation-canvas').locator('svg, canvas').first()).toBeVisible();
    await expect(page.locator('.player-error')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled({
      timeout: 30_000,
    });
    await page.locator('.notation-viewport').click({ position: { x: 20, y: 180 } });
    await expect(playerShell).toHaveClass(/controls-hidden/, { timeout: 5000 });
    await page.locator('.notation-viewport').click({ position: { x: 20, y: 180 } });
    await expect(playerShell).not.toHaveClass(/controls-hidden/);
    await page.getByLabel('BPM').fill('108');
    await page.getByLabel('BPM').press('Tab');
    await page.getByRole('button', { name: /Measures 1–8/ }).click();
    await page.getByLabel('Start', { exact: true }).fill('7');
    await page.getByLabel('End', { exact: true }).fill('4');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(
      page.getByText('End measure must be the same as or after the start.'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: /Measures 1–8/ })).toBeVisible();
    await page.waitForTimeout(3200);
    await expect(playerShell).not.toHaveClass(/controls-hidden/);
    await page.getByLabel('Start', { exact: true }).fill('2');
    await page.getByLabel('End', { exact: true }).fill('4');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByRole('button', { name: /Measures 2–4/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Loop/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    {
      const beatCursor = page.locator('.at-cursor-beat');
      await page.getByRole('button', { name: 'Play', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
      await expect(beatCursor).toBeVisible();
      await expect.poll(async () => page.locator('.at-highlight').count()).toBeGreaterThan(0);
      const before = await beatCursor.boundingBox();
      await page.waitForTimeout(650);
      const advanced = await beatCursor.boundingBox();
      expect(advanced?.x !== before?.x || advanced?.y !== before?.y).toBe(true);
      await page.locator('.notation-viewport').click({ position: { x: 20, y: 180 } });
      await expect(playerShell).not.toHaveClass(/controls-hidden/);
      await page.getByRole('button', { name: 'Pause', exact: true }).click();
      await page.waitForTimeout(150);
      const paused = await beatCursor.boundingBox();
      await page.waitForTimeout(500);
      const stillPaused = await beatCursor.boundingBox();
      expect(Math.abs((stillPaused?.x ?? 0) - (paused?.x ?? 0))).toBeLessThan(1);
      expect(Math.abs((stillPaused?.y ?? 0) - (paused?.y ?? 0))).toBeLessThan(1);
      await page.locator('.notation-viewport').click({ position: { x: 20, y: 180 } });
      await expect(playerShell).not.toHaveClass(/controls-hidden/);
      await page.getByRole('button', { name: 'Restart' }).click();

      await page.getByRole('button', { name: /Measures 2–4/ }).click();
      await page.getByLabel('Start', { exact: true }).fill('2');
      await page.getByLabel('End', { exact: true }).fill('2');
      await page.getByRole('button', { name: 'Apply' }).click();
      await page.getByRole('button', { name: 'Play', exact: true }).click();
      const positions: { x: number; y: number }[] = [];
      for (let sample = 0; sample < 14; sample += 1) {
        await page.waitForTimeout(250);
        const box = await beatCursor.boundingBox();
        if (box) positions.push({ x: box.x, y: box.y });
      }
      const wrapped = positions.some((position, index) => {
        if (index === 0) return false;
        const previous = positions[index - 1];
        return (
          position.y < previous.y - 3 ||
          (Math.abs(position.y - previous.y) < 3 && position.x < previous.x - 5)
        );
      });
      expect(wrapped).toBe(true);
      await page.locator('.notation-viewport').click({ position: { x: 20, y: 180 } });
      await expect(playerShell).not.toHaveClass(/controls-hidden/);
      await page.getByRole('button', { name: 'Pause', exact: true }).click();
    }
    await page.screenshot({ path: testInfo.outputPath('score-player.png') });

    await page.getByLabel('Back to work').click();
    await expect(page.locator('.topbar')).toBeVisible();
    await expect(page.locator('.bottom-nav')).toBeVisible();
    await page.getByRole('link', { name: 'Read' }).click();
    await expect(page.locator('.pdf-stage canvas')).toBeVisible();
    await page.getByLabel('Back to work').click();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByRole('link', { name: 'Play' }).click();
    await expect(page.locator('.player-shell.reduced-motion')).toBeVisible();
    await expect(page.locator('.notation-canvas').locator('svg, canvas').first()).toBeVisible();
    await page.getByLabel('Back to work').click();
    await expect(page.locator('.topbar')).toBeVisible();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  });

  test('Flow B: create a work and securely upload PDF and MusicXML assets', async ({
    page,
  }, testInfo) => {
    const title = `Imported E2E Exercise ${Date.now()}`;
    await page.goto('/library');
    await page.getByRole('button', { name: '+ Add a work' }).click();
    await page.getByLabel('Work title').fill(title);
    await page.getByLabel('Composer').fill('E2E Composer');
    await page.getByLabel('Edition name').fill('Test edition');
    await page.getByLabel('Rights note').fill('CC0 test fixture');
    await page.getByRole('button', { name: 'Create work' }).click();
    await expect(page.getByRole('heading', { name: title })).toBeVisible();

    await page.getByLabel('File').setInputFiles(path.join(fixtureRoot, 'noted-exercise.pdf'));
    await page.getByLabel('Rights note', { exact: true }).last().fill('Original CC0 test fixture');
    await page.getByRole('button', { name: 'Upload & verify' }).click();
    await expect(page.getByText('noted-exercise.pdf')).toBeVisible();

    await page.getByLabel('File').setInputFiles(path.join(fixtureRoot, 'noted-exercise.musicxml'));
    await page.getByLabel('Rights note', { exact: true }).last().fill('Original CC0 test fixture');
    await page.getByRole('button', { name: 'Upload & verify' }).click();
    await expect(page.getByText('noted-exercise.musicxml')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Read' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Play' })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('imported-work.png'), fullPage: true });
  });

  test('Flow C: explicitly time practice and see the saved summary', async ({ page }, testInfo) => {
    await page.goto('/practice');
    await expect(page.getByRole('heading', { name: 'Practice', exact: true })).toBeVisible();
    await expect(page.getByText('Loading practice history…')).toBeHidden();
    await page.getByRole('button', { name: 'Start Practice' }).click();
    await expect(page.getByText('Timer active')).toBeVisible();
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Discard timer' }).click();
    await expect(page.getByText('Running timer discarded.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start Practice' })).toBeVisible();
    await page.goto('/home');
    await page.getByRole('link', { name: seededWork }).click();
    await page.getByRole('button', { name: 'Start Practice' }).click();
    await expect(page.getByText('Timer running')).toBeVisible();
    await page.waitForTimeout(1200);
    await page.getByLabel('Ending BPM').fill('104');
    await page.getByLabel('Notes', { exact: true }).fill('E2E focused loop');
    await page.getByRole('button', { name: 'Stop & save practice' }).click();
    await expect(
      page.getByText('Practice saved. Dashboard and work totals are updated.'),
    ).toBeVisible();

    await page.getByRole('link', { name: 'Home', exact: true }).click();
    await expect(page.getByText('sessions')).toBeVisible();
    await page.getByRole('link', { name: 'Practice', exact: true }).click();
    await expect(page.getByText('E2E focused loop').first()).toBeVisible();
    await expect(page.getByText('104 BPM').first()).toBeVisible();

    await page.getByRole('button', { name: '+ Manual entry' }).click();
    const originalStartedAt = '2031-05-06T14:35:12';
    await page.getByLabel('Start date & time').fill(originalStartedAt);
    await page.getByLabel('Movement').selectOption({ label: '1. Complete exercise' });
    await page
      .getByLabel('Score asset')
      .selectOption({ label: 'Noted reference edition — noted-exercise.musicxml' });
    await page.getByLabel('Duration (minutes)').fill('12');
    await page.getByLabel('Start measure', { exact: true }).last().fill('2');
    await page.getByLabel('End measure', { exact: true }).last().fill('4');
    await page.getByLabel('Starting BPM').fill('72');
    await page.getByLabel('Ending BPM').last().fill('84');
    await page.getByLabel('Hand / part').last().fill('RH');
    const completeNote = `E2E complete context ${testInfo.project.name}`;
    const correctedNote = `E2E corrected context ${testInfo.project.name}`;
    await page.getByLabel('Notes', { exact: true }).last().fill(completeNote);
    await page.getByRole('button', { name: 'Save practice' }).click();
    await expect(page.getByText('Manual practice entry saved.')).toBeVisible();

    let manualRow = page.locator('.session-row').filter({ hasText: completeNote });
    await expect(manualRow).toContainText('12m');
    await expect(manualRow).toContainText('Measures 2–4');
    await expect(manualRow).toContainText('72 → 84 BPM');
    await expect(manualRow).toContainText('RH');
    await manualRow.getByRole('button', { name: 'Edit' }).click();
    await expect(page.getByLabel('Start date & time')).toHaveValue(originalStartedAt);
    await expect(page.getByLabel('Movement')).toHaveValue('10000000-0000-4000-8000-000000000004');
    await expect(page.getByLabel('Score asset')).toHaveValue(
      '10000000-0000-4000-8000-000000000008',
    );
    await page.getByLabel('Duration (minutes)').fill('14');
    await page.getByLabel('Notes', { exact: true }).last().fill(correctedNote);
    await page.getByRole('button', { name: 'Save correction' }).click();
    await expect(page.getByText('Practice entry corrected.')).toBeVisible();
    manualRow = page.locator('.session-row').filter({ hasText: correctedNote });
    await expect(manualRow).toContainText('14m');
    await manualRow.getByRole('button', { name: 'Edit' }).click();
    await expect(page.getByLabel('Start date & time')).toHaveValue(originalStartedAt);
    await expect(page.getByLabel('Movement')).toHaveValue('10000000-0000-4000-8000-000000000004');
    await expect(page.getByLabel('Score asset')).toHaveValue(
      '10000000-0000-4000-8000-000000000008',
    );
    await page.screenshot({ path: testInfo.outputPath('practice-summary.png'), fullPage: true });
  });
});
