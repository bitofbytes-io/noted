import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const piece = {
  id: '4f607127-fb97-4b22-90f5-1b9bec77b739',
  title: 'Prelude in C',
  composer: 'J. S. Bach',
  favorite: true,
  sourceUrl: '',
  notes: '',
  createdAt: '2026-07-23T12:00:00Z',
  updatedAt: '2026-07-23T12:00:00Z',
  pdf: {
    originalFilename: 'prelude.pdf',
    sizeBytes: 1024,
    checksumSha256: '0'.repeat(64),
    pageCount: 2,
    uploadedAt: '2026-07-23T12:00:00Z',
    contentUrl: `/api/pieces/4f607127-fb97-4b22-90f5-1b9bec77b739/pdf`,
  },
};

test.beforeEach(async ({ page }) => {
  const pdf = await readFile(resolve('../testdata/fixtures/noted-exercise.pdf'));
  await page.route('**/api/session', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        authenticated: true,
        authMode: 'development',
        development: true,
        user: {
          id: 'db53bb2a-b720-407a-8941-cd4459f69e79',
          email: 'learner@noted.local',
          displayName: 'Local learner',
        },
      }),
    });
  });
  await page.route('**/api/pieces/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith('/pdf')) {
      if (request.method() === 'POST') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(piece),
        });
      } else {
        await route.fulfill({ status: 200, contentType: 'application/pdf', body: pdf });
      }
      return;
    }
    if (url.pathname.endsWith('/reader-state')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          pieceId: piece.id,
          mode: 'page',
          lastPage: 1,
          scrollPosition: 0,
          zoom: 1,
          scrollSpeed: 32,
          scrollPaused: true,
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(piece),
    });
  });
  await page.route('**/api/pieces/?**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([piece]),
    });
  });
  await page.route('**/api/pieces/', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ ...piece, pdf: null }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([piece]),
    });
  });
});

test('unauthenticated visitors see the Google sign-in gate', async ({ page }) => {
  await page.route('**/api/session', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        authenticated: false,
        authMode: 'google',
        development: false,
      }),
    });
  });
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Continue with Google' })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Your scores, ready when you are.' }),
  ).toBeVisible();
});

test('adds a PDF with a filename-prefilled title and opens it', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Add piece' }).click();
  const dialog = page.getByRole('dialog');
  await dialog
    .locator('input[type="file"]')
    .setInputFiles(resolve('../testdata/fixtures/noted-exercise.pdf'));
  await expect(dialog.getByLabel('Title')).toHaveValue('noted exercise');
  await dialog.getByLabel('Composer').fill('Fixture composer');
  await dialog.getByRole('button', { name: 'Add piece' }).click();
  await expect(page).toHaveURL(new RegExp(`/reader/${piece.id}$`));
  await expect(page.locator('canvas')).toBeVisible();
});

test('search-first library opens directly into the score reader', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Library' })).toBeVisible();
  await expect(page.getByPlaceholder('Search title or composer')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('library.png'), fullPage: true });
  await page.getByRole('article').click();
  await expect(page).toHaveURL(new RegExp(`/reader/${piece.id}$`));
  await expect(page.getByText('Prelude in C')).toBeVisible();
  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();
  await expect
    .poll(() => canvas.evaluate((element) => (element as HTMLCanvasElement).width))
    .toBeGreaterThan(100);
  await expect
    .poll(() =>
      canvas.evaluate((element) => {
        const source = element as HTMLCanvasElement;
        const pixels = source
          .getContext('2d')
          ?.getImageData(0, 0, source.width, source.height).data;
        if (!pixels) return 0;
        let inkPixels = 0;
        for (let index = 0; index < pixels.length; index += 64) {
          if (pixels[index + 3] > 0 && pixels[index] < 245) inkPixels += 1;
        }
        return inkPixels;
      }),
    )
    .toBeGreaterThan(50);
  await page.screenshot({ path: testInfo.outputPath('page-reader.png') });
  await page.keyboard.press('PageDown');
  await expect(page.getByText('2 / 2').first()).toBeVisible();
  await page.keyboard.press('PageUp');
});

test('reader exposes page and auto-scroll controls', async ({ page }, testInfo) => {
  await page.goto(`/reader/${piece.id}`);
  await expect(page.getByRole('button', { name: 'Scroll' })).toBeVisible();
  await page.getByRole('button', { name: 'Scroll' }).click();
  await expect(page.getByRole('slider')).toHaveValue('32');
  await expect(page.getByRole('button', { name: 'Resume auto-scroll' })).toBeVisible();
  await expect(page.locator('.reader-controls')).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Zoom in' })).toBeInViewport();
  const saveRequest = page.waitForRequest(
    (request) =>
      request.url().endsWith('/reader-state') &&
      request.method() === 'PUT' &&
      request.postData()?.includes('"scrollSpeed":48') === true,
  );
  await page.getByRole('slider').fill('48');
  const savedState = (await saveRequest).postDataJSON() as {
    mode: string;
    scrollSpeed: number;
  };
  expect(savedState.mode).toBe('scroll');
  expect(savedState.scrollSpeed).toBe(48);
  await page.getByRole('button', { name: 'Resume auto-scroll' }).click();
  const pauseButton = page.getByRole('button', { name: 'Pause auto-scroll' });
  await expect(pauseButton).toBeVisible();
  await expect
    .poll(() => page.locator('.reader').evaluate((reader) => reader.scrollTop))
    .toBeGreaterThan(0);
  await page.waitForTimeout(250);
  await expect(pauseButton).toBeVisible();
  const canvas = page.locator('.scroll-page canvas').first();
  await expect
    .poll(() =>
      canvas.evaluate((element) => {
        const source = element as HTMLCanvasElement;
        const pixels = source
          .getContext('2d')
          ?.getImageData(0, 0, source.width, source.height).data;
        if (!pixels) return 0;
        let inkPixels = 0;
        for (let index = 0; index < pixels.length; index += 64) {
          if (pixels[index + 3] > 0 && pixels[index] < 245) inkPixels += 1;
        }
        return inkPixels;
      }),
    )
    .toBeGreaterThan(50);
  await page.screenshot({ path: testInfo.outputPath('scroll-reader.png') });
});
