import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const fixturePdfPath = resolve('../testdata/fixtures/noted-exercise.pdf');

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
  const pdf = await readFile(fixturePdfPath);
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
    if (url.pathname.endsWith('/pdf/download')) {
      await route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': 'attachment; filename="prelude.pdf"',
          'Cache-Control': 'private, max-age=0, must-revalidate',
        },
        body: pdf,
      });
      return;
    }
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
  await expect(dialog.getByRole('link', { name: 'Download current PDF' })).toHaveCount(0);
  await dialog.locator('input[type="file"]').setInputFiles(fixturePdfPath);
  await expect(dialog.getByLabel('Title')).toHaveValue('noted exercise');
  await dialog.getByLabel('Composer').fill('Fixture composer');
  await dialog.getByRole('button', { name: 'Add piece' }).click();
  await expect(page).toHaveURL(new RegExp(`/reader/${piece.id}$`));
  await expect(page.locator('canvas')).toBeVisible();
});

test('edit makes the current PDF downloadable while keeping replacement available', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Edit piece' }).click();

  const dialog = page.getByRole('dialog');
  const replacementPicker = dialog.locator('input[type="file"]');
  await expect(dialog.getByText('Replace prelude.pdf')).toBeVisible();
  await expect(replacementPicker).toHaveAttribute('accept', 'application/pdf,.pdf');

  const downloadAction = dialog.getByRole('link', { name: 'Download current PDF' });
  await expect(downloadAction).toHaveAttribute('href', `/api/pieces/${piece.id}/pdf/download`);
  const actionBox = await downloadAction.boundingBox();
  expect(actionBox).not.toBeNull();
  expect(actionBox!.height).toBeGreaterThanOrEqual(44);

  await downloadAction.focus();
  await expect(downloadAction).toBeFocused();

  await page.screenshot({ path: testInfo.outputPath('edit-pdf-actions.png') });
});

test('download uses the current PDF filename and exact bytes', async ({ page, browserName }) => {
  test.skip(
    browserName === 'webkit',
    'Headless WebKit bypasses Playwright page routes for attachment downloads.',
  );
  const fixturePdf = await readFile(fixturePdfPath);
  await page.goto('/');
  await page.getByRole('button', { name: 'Edit piece' }).click();

  const dialog = page.getByRole('dialog');
  const replacementPicker = dialog.locator('input[type="file"]');
  const downloadAction = dialog.getByRole('link', { name: 'Download current PDF' });
  const downloadPromise = page.waitForEvent('download');
  await downloadAction.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('prelude.pdf');
  const downloadedPath = await download.path();
  expect(downloadedPath).not.toBeNull();
  expect((await readFile(downloadedPath!)).equals(fixturePdf)).toBe(true);

  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Replace prelude.pdf')).toBeVisible();
  await expect(replacementPicker).toBeAttached();
});

test('keeps Add piece right-aligned when account controls are present', async ({ page }) => {
  await page.route('**/api/session', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        authenticated: true,
        authMode: 'google',
        development: false,
        user: {
          id: 'db53bb2a-b720-407a-8941-cd4459f69e79',
          email: 'danwater1@gmail.com',
          displayName: 'Daniel Waters',
        },
      }),
    });
  });
  await page.goto('/');

  const actions = page.locator('.masthead-actions');
  const addPiece = actions.getByRole('button', { name: 'Add piece' });
  const account = actions.locator('.account');
  await expect(addPiece).toBeVisible();
  await expect(account.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await expect(account).toHaveAttribute('title', 'danwater1@gmail.com');

  const addPieceBox = await addPiece.boundingBox();
  const accountBox = await account.boundingBox();
  const actionsBox = await actions.boundingBox();
  expect(addPieceBox).not.toBeNull();
  expect(accountBox).not.toBeNull();
  expect(actionsBox).not.toBeNull();
  expect(accountBox!.x + accountBox!.width).toBeLessThan(addPieceBox!.x);
  expect(addPieceBox!.x + addPieceBox!.width).toBeCloseTo(actionsBox!.x + actionsBox!.width, 0);
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
      request.postData()?.includes('"scrollSpeed":5') === true,
  );
  await page.getByRole('slider').fill('5');
  const savedState = (await saveRequest).postDataJSON() as {
    mode: string;
    scrollSpeed: number;
  };
  expect(savedState.mode).toBe('scroll');
  expect(savedState.scrollSpeed).toBe(5);
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

test('reader uses a two-stage reveal while auto-scroll keeps moving', async ({
  page,
}, testInfo) => {
  testInfo.setTimeout(45_000);
  await page.route(`**/api/pieces/${piece.id}/reader-state`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        pieceId: piece.id,
        mode: 'scroll',
        lastPage: 1,
        scrollPosition: 0,
        zoom: 1,
        scrollSpeed: 32,
        scrollPaused: false,
      }),
    });
  });

  await page.goto(`/reader/${piece.id}`);
  const reader = page.locator('.reader');
  const controls = page.locator('.reader-controls');
  const topbar = page.locator('.reader-topbar');
  const bubble = page.getByRole('button', { name: 'Show reader controls' });
  await expect(page.locator('.scroll-page canvas').first()).toBeVisible();

  await expect(controls).toBeHidden({ timeout: 5_000 });
  await expect(topbar).toBeHidden();
  const hiddenAtScrollTop = await reader.evaluate((element) => element.scrollTop);
  await expect
    .poll(() => reader.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(hiddenAtScrollTop);

  await reader.evaluate((element) => {
    element.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        clientX: 100,
        clientY: 100,
        pointerType: 'mouse',
      }),
    );
  });
  await page.mouse.wheel(0, 80);
  await expect(controls).toBeHidden();
  await expect(bubble).toBeHidden();

  await page.mouse.move(120, 160);
  await page.mouse.move(140, 160);
  await expect(bubble).toBeVisible();
  await expect(controls).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('reader-controls-bubble.png') });

  await bubble.click();
  await expect(bubble).toBeHidden();
  await expect(topbar).toBeVisible();
  await expect(controls).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pause auto-scroll' })).toBeVisible();

  await page.waitForTimeout(2_000);
  const controlsBox = await controls.boundingBox();
  expect(controlsBox).not.toBeNull();
  await page.mouse.move(controlsBox!.x + 20, controlsBox!.y + 20);
  await page.mouse.move(controlsBox!.x + 28, controlsBox!.y + 20);
  await page.waitForTimeout(1_500);
  await expect(controls).toBeVisible();
  await expect(controls).toBeHidden({ timeout: 4_000 });
  await reader.evaluate((element) => {
    const score = Array.from(
      element.querySelectorAll<HTMLCanvasElement>('.scroll-page canvas'),
    ).find((canvas) => {
      const rect = canvas.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < window.innerHeight;
    });
    if (!score) throw new Error('Expected a visible score canvas');
    const rect = score.getBoundingClientRect();
    const clientX = Math.min(window.innerWidth - 1, Math.max(0, rect.left + 80));
    const clientY = Math.min(window.innerHeight - 1, Math.max(0, rect.top + 80));
    const pointerInit: PointerEventInit = {
      bubbles: true,
      clientX,
      clientY,
      pointerId: 1,
      pointerType: 'touch',
    };
    score.dispatchEvent(new PointerEvent('pointerdown', pointerInit));
    score.dispatchEvent(new PointerEvent('pointerup', pointerInit));
    score.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX, clientY }));
  });
  await expect(bubble).toBeVisible();
  await expect(controls).toBeHidden();

  await bubble.focus();
  await page.keyboard.press('Enter');
  await expect(topbar).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resume auto-scroll' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back to library' })).toBeFocused();
  await page.waitForTimeout(3_200);
  await expect(controls).toBeVisible();
});
