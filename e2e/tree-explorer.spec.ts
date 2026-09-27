import { expect, test, type Page } from '@playwright/test';

const hosted = Boolean(process.env.PLAYWRIGHT_BASE_URL);
const path = hosted ? '/' : '/?dataset=aves';
const taxon = hosted ? 'Homo sapiens' : 'Camarhynchus psittacula';

async function openTree(page: Page) {
  const browserErrors: string[] = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  const app = page.locator('main.app');
  await expect(page.locator('canvas')).toBeVisible();
  await expect(page.locator('.map-footer')).toBeVisible({ timeout: hosted ? 30_000 : 15_000 });
  if (!hosted) await expect(app).toHaveAttribute('data-tree-ready', 'true');
  await expect(page.getByRole('alert')).toHaveCount(0);
  return { app, browserErrors };
}

test('loads the interactive tree without browser errors', async ({ page }) => {
  const { browserErrors } = await openTree(page);
  await expect(page.getByRole('combobox', { name: 'Search taxa' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Map controls' })).toBeVisible();
  expect(browserErrors).toEqual([]);
});

test('search, deep focus, wheel zoom, pan, and home stay responsive', async ({ page }) => {
  const { app, browserErrors } = await openTree(page);
  const search = page.getByRole('combobox', { name: 'Search taxa' });
  await search.fill(taxon);
  const exactResult = page.getByRole('option').filter({ has: page.locator('span', { hasText: new RegExp(`^${taxon}$`) }) });
  await expect(exactResult).toHaveAttribute('aria-selected', 'true');
  await search.press('Enter');
  const details = page.getByRole('complementary', { name: 'Taxon details' });
  await expect(details.getByRole('heading', { name: taxon })).toBeVisible({ timeout: hosted ? 30_000 : 15_000 });
  await expect(app).not.toHaveAttribute('data-pending-taxon', taxon, { timeout: hosted ? 30_000 : 15_000 });
  await expect.poll(async () => Number(await app.getAttribute('data-scene-node-count'))).toBeGreaterThan(0);

  const beforeZoom = await app.getAttribute('data-camera-zoom');
  const canvas = page.locator('canvas').first();
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.wheel(0, -700);
  if (beforeZoom !== null) await expect.poll(() => app.getAttribute('data-camera-zoom')).not.toBe(beforeZoom);

  const beforePan = await app.getAttribute('data-camera-target');
  await page.mouse.move(box!.x + box!.width * 0.45, box!.y + box!.height * 0.55);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width * 0.6, box!.y + box!.height * 0.65, { steps: 8 });
  await page.mouse.up();
  if (beforePan !== null) await expect.poll(() => app.getAttribute('data-camera-target')).not.toBe(beforePan);

  await page.getByRole('button', { name: /Home/ }).click();
  await expect(details).toHaveCount(0);
  if (await app.getAttribute('data-tree-ready') !== null) await expect(app).toHaveAttribute('data-tree-ready', 'true');
  await expect(page.locator('canvas')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(browserErrors).toEqual([]);
});

test('selection responds before the focused scene finishes loading', async ({ page }) => {
  let release = () => {};
  const ancestryGate = new Promise<void>(resolve => { release = resolve; });
  await page.route(/\/ancestry\/\d+\.json(?:\?.*)?$/, async route => {
    await ancestryGate;
    await route.continue();
  });
  try {
    const { app, browserErrors } = await openTree(page);
    const search = page.getByRole('combobox', { name: 'Search taxa' });
    await search.fill(taxon);
    await expect(page.getByRole('option').filter({ has: page.locator('span', { hasText: new RegExp(`^${taxon}$`) }) }))
      .toHaveAttribute('aria-selected', 'true');
    await search.press('Enter');

    const details = page.getByRole('complementary', { name: 'Taxon details' });
    await expect(details.getByRole('heading', { name: taxon })).toBeVisible({ timeout: 400 });
    await expect(app).toHaveAttribute('data-pending-taxon', taxon);
    await expect(page.locator('.stream-notice[role="status"]').filter({ hasText: `Opening ${taxon}` })).toBeVisible();
    release();
    await expect(app).not.toHaveAttribute('data-pending-taxon', taxon, { timeout: hosted ? 30_000 : 15_000 });
    await expect.poll(async () => Number(await app.getAttribute('data-scene-node-count'))).toBeGreaterThan(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(browserErrors).toEqual([]);
  } finally { release(); }
});

test('scientific profiles stay off the initial path and load after selection', async ({ page }) => {
  test.skip(hosted, 'The deployed profile version advances with this release.');
  const profileRequests: string[] = [];
  page.on('request', request => { if (request.url().includes('/data/profiles/')) profileRequests.push(request.url()); });
  const { app, browserErrors } = await openTree(page);
  expect(profileRequests).toEqual([]);

  const search = page.getByRole('combobox', { name: 'Search taxa' });
  await search.fill(taxon);
  await expect(page.getByRole('option').filter({ has: page.locator('span', { hasText: new RegExp(`^${taxon}$`) }) }))
    .toHaveAttribute('aria-selected', 'true');
  await search.press('Enter');

  await expect(app).toHaveAttribute('data-profile-status', 'ready');
  const details = page.getByRole('complementary', { name: 'Taxon details' });
  await expect(details.getByRole('heading', { name: 'About' })).toBeVisible();
  await expect(details.getByRole('link', { name: /From Wikipedia/ })).toContainText('CC BY-SA 4.0');
  await expect(details.getByRole('heading', { name: 'Sources' })).toBeVisible();
  expect(profileRequests.filter(url => url.endsWith('/data/profiles/manifest.json'))).toHaveLength(1);
  expect(profileRequests.filter(url => /\/data\/profiles\/[a-f0-9]{16}\/shards\/\d{2}\.json$/.test(url))).toHaveLength(1);
  expect(browserErrors).toEqual([]);
});
