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
    await expect(page.getByRole('button', { name: /Measures 1–8/ })).toBeVisible();
    await expect(page.locator('.notation-canvas').locator('svg, canvas').first()).toBeVisible();
    await expect(page.locator('.player-error')).toHaveCount(0);
    await page.getByLabel('BPM').fill('108');
    await page.getByLabel('BPM').press('Tab');
    await page.getByRole('button', { name: /Measures 1–8/ }).click();
    await page.getByLabel('Start', { exact: true }).fill('2');
    await page.getByLabel('End', { exact: true }).fill('4');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByRole('button', { name: /Measures 2–4/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Loop/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    if (testInfo.project.name === 'desktop-chrome') {
      await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled({
        timeout: 30_000,
      });
      await page.getByRole('button', { name: 'Play', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Pause', exact: true }).click();
    }
    await page.screenshot({ path: testInfo.outputPath('score-player.png') });
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
    await page.screenshot({ path: testInfo.outputPath('practice-summary.png'), fullPage: true });
  });
});
