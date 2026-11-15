import { expect, test, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MOUSE_WHEEL_ZOOM_LEVELS } from '../src/stream/reframe.ts';

const hosted = Boolean(process.env.PLAYWRIGHT_BASE_URL);
function completeLifePublication() {
  const pointer = 'public/data/life/manifest.json';
  try {
    const manifest = JSON.parse(readFileSync(pointer, 'utf8'));
    return /^[a-f0-9]{16}$/.test(manifest.version) &&
      existsSync(join('public/data/life', manifest.version, 'manifest.json')) &&
      existsSync(join('public/data/life', manifest.version, manifest.overview?.file ?? 'overview.json'));
  } catch { return false; }
}
const hasLifePublication = completeLifePublication();
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
  const header = page.locator('header.top-bar');
  await header.getByRole('button', { name: 'Explore' }).click();
  const explore = header.getByRole('menu', { name: 'Explore the Tree of Life' });
  const menuBox = await explore.boundingBox();
  expect(menuBox?.x).toBeGreaterThanOrEqual(0);
  expect((menuBox?.x ?? 0) + (menuBox?.width ?? 0)).toBeLessThanOrEqual(page.viewportSize()?.width ?? Infinity);
  expect((menuBox?.y ?? 0) + (menuBox?.height ?? 0)).toBeLessThanOrEqual(page.viewportSize()?.height ?? Infinity);
  await expect(explore.getByRole('menuitem', { name: /All Life/ })).toContainText('Eukaryota, Archaea, and Bacteria');
  await expect(explore.getByRole('menuitem', { name: /Birds/ })).toContainText('Aves');
  await expect(explore.getByRole('menuitem', { name: /Mammals/ })).toContainText('Mammalia');
  await expect(explore.getByRole('menuitem', { name: /Primates/ })).toBeVisible();
  await page.keyboard.press('Escape');
  expect(browserErrors).toEqual([]);
});

test('complete-tree broad zoom switches to spatial tiles without a blank canvas', async ({ page }) => {
  test.skip(!hasLifePublication, 'Complete OpenTree publication is not available');
  const browserErrors: string[] = [], tileRequests: string[] = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  page.on('response', response => { if (/\/tiles\/\d+\/\d+\/\d+\.json/.test(response.url())) tileRequests.push(response.url()); });
  await page.goto('/?dataset=life', { waitUntil: 'domcontentloaded' });
  const app = page.locator('main.app'), canvas = page.locator('canvas').first();
  await expect(app).toHaveAttribute('data-tree-ready', 'true', { timeout: 30_000 });
  const box = await canvas.boundingBox(); expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width * 0.28, box!.y + box!.height * 0.42);
  for (let attempt = 0; attempt < 4 && tileRequests.length === 0; attempt++) {
    await page.mouse.wheel(0, -900);
    await page.waitForTimeout(180);
  }
  await expect.poll(() => tileRequests.length, { timeout: 15_000 }).toBeGreaterThan(0);
  await expect.poll(async () => Number(await app.getAttribute('data-scene-node-count'))).toBeGreaterThan(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(browserErrors).toEqual([]);
});

test('search, deep focus, wheel zoom, pan, and home stay responsive', async ({ page }) => {
  const { app, browserErrors } = await openTree(page);
  const search = page.getByRole('combobox', { name: 'Search taxa' });
  await search.fill(taxon);
  await expect(page.getByRole('group', { name: 'Search by name type' })).toBeVisible();
  const exactResult = page.getByRole('option').filter({ has: page.locator('span', { hasText: new RegExp(`^${taxon}$`) }) });
  await expect(exactResult).toHaveAttribute('aria-selected', 'true');
  await search.press('Enter');
  const details = page.getByRole('complementary', { name: 'Taxon details' });
  await expect(details.getByRole('heading', { name: taxon })).toBeVisible({ timeout: hosted ? 30_000 : 15_000 });
  await expect(details.getByRole('heading', { name: 'Evolutionary context' })).toBeVisible();
  await expect(details.getByRole('heading', { name: 'Scientific record' })).toBeVisible();
  await expect(app).not.toHaveAttribute('data-pending-taxon', taxon, { timeout: hosted ? 30_000 : 15_000 });
  await expect.poll(async () => Number(await app.getAttribute('data-scene-node-count'))).toBeGreaterThan(0);

  const beforeZoom = Number(await app.getAttribute('data-camera-zoom'));
  const canvas = page.locator('canvas').first();
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.wheel(0, -100);
  const minimumWheelZoom = (page.viewportSize()?.width ?? 1000) < 700 ? 0.1 : MOUSE_WHEEL_ZOOM_LEVELS - 0.01;
  if (Number.isFinite(beforeZoom)) await expect.poll(async () =>
    Math.abs(Number(await app.getAttribute('data-camera-zoom')) - beforeZoom))
    .toBeGreaterThanOrEqual(minimumWheelZoom);

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
    await expect(app).toHaveAttribute('data-map-loading', 'navigation');
    await expect(app).toHaveAttribute('data-scene-held', 'true');
    await expect(page.getByRole('status').filter({ hasText: `Opening ${taxon}` })).toBeVisible();
    await expect.poll(async () => Number(await app.getAttribute('data-scene-node-count'))).toBeGreaterThan(0);
    release();
    await expect(app).not.toHaveAttribute('data-pending-taxon', taxon, { timeout: hosted ? 30_000 : 15_000 });
    await expect(page.getByRole('status').filter({ hasText: `Opening ${taxon}` })).toHaveCount(0);
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

test('common names discover the corresponding scientific taxon', async ({ page }) => {
  test.skip(hosted, 'This assertion targets the checked-in profile publication.');
  const { browserErrors } = await openTree(page);
  const search = page.getByRole('combobox', { name: 'Search taxa' });
  await search.fill('red junglefowl');
  const result = page.getByRole('option').filter({ hasText: 'Gallus gallus' });
  await expect(result).toContainText('Matched common name: Red Junglefowl');
  await search.press('Enter');
  const details = page.getByRole('complementary', { name: 'Taxon details' });
  await expect(details.getByRole('heading', { name: 'Gallus gallus' })).toBeVisible();
  await expect(details.getByRole('link', { name: /IUCN Red List Least Concern LC/ })).toBeVisible();
  expect(browserErrors).toEqual([]);
});

test('two taxa can be compared, shared by URL, and restored with browser history', async ({ page }) => {
  const { app, browserErrors } = await openTree(page);
  const search = page.getByRole('combobox', { name: 'Search taxa' });
  const open = async (name: string) => {
    await search.fill(name);
    const result = page.getByRole('option').filter({ has: page.locator('span', { hasText: new RegExp(`^${name}$`) }) });
    await expect(result).toBeVisible();
    await result.click();
    await expect(page.getByRole('complementary', { name: 'Taxon details' }).getByRole('heading', { name })).toBeVisible();
  };
  await open('Gallus gallus');
  await page.getByRole('button', { name: 'Compare this taxon' }).click();
  const compareMenu = page.getByRole('dialog', { name: 'Compare taxa' });
  await expect(compareMenu).toBeVisible();
  const menuBox = await compareMenu.boundingBox();
  expect(menuBox?.x).toBeGreaterThanOrEqual(0);
  expect((menuBox?.x ?? 0) + (menuBox?.width ?? 0)).toBeLessThanOrEqual(page.viewportSize()?.width ?? Infinity);
  await expect(compareMenu.getByText('Gallus gallus', { exact: true })).toBeVisible();
  await compareMenu.getByRole('textbox', { name: 'Second taxon' }).fill('Camarhynchus psittacula');
  const second = compareMenu.getByRole('option').filter({ hasText: 'Camarhynchus psittacula' });
  await expect(second).toBeVisible();
  await second.click();
  await compareMenu.getByRole('button', { name: 'Compare lineages' }).click();
  const panel = page.getByRole('complementary', { name: 'Taxon comparison' });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'Gallus gallus', exact: true })).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'Camarhynchus psittacula', exact: true })).toBeVisible();
  await expect(app).toHaveAttribute('data-comparison', /\d+:\d+/);
  await expect.poll(() => new URL(page.url()).searchParams.get('compare')).toMatch(/^ott\d+$/);
  await page.locator('header.top-bar').getByRole('button', { name: /^Compare/ }).click();
  const activeMenu = page.getByRole('dialog', { name: 'Compare taxa' });
  await expect(activeMenu.getByRole('button', { name: 'Update comparison' })).toBeVisible();
  await expect(activeMenu.getByRole('button', { name: 'Copy comparison link' })).toBeVisible();
  await expect(activeMenu.getByRole('button', { name: 'End comparison' })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.goBack();
  await expect(page.getByRole('complementary', { name: 'Taxon details' })
    .getByRole('heading', { name: 'Gallus gallus' })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole('complementary', { name: 'Taxon comparison' })).toBeVisible();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('complementary', { name: 'Taxon comparison' })).toBeVisible({ timeout: 15_000 });
  expect(browserErrors).toEqual([]);
});

test('search waits for common-name ranking instead of flashing raw terminal matches', async ({ page }) => {
  test.skip(hosted, 'This assertion controls the checked-in profile search response.');
  let releaseSearch = () => {};
  const searchGate = new Promise<void>(resolve => { releaseSearch = resolve; });
  await page.route(/\/data\/profiles\/[a-f0-9]{16}\/search\.json$/, async route => {
    await searchGate;
    await route.continue();
  });
  try {
    await openTree(page);
    const search = page.getByRole('combobox', { name: 'Search taxa' });
    await search.fill('bird');
    await expect(page.locator('.search-results [role="status"]')).toHaveText('Searching…');
    await expect(page.getByRole('option')).toHaveCount(0);
    releaseSearch();
    await expect(page.getByRole('option').filter({ hasText: 'Elephant Bird' })).toBeVisible();
    await expect(page.getByRole('option').filter({ hasText: 'Bald Eagle' })).toBeVisible();
  } finally { releaseSearch(); }
});

test('bird-flight journey navigates real OpenTree evidence and can be paused', async ({ page, browserName }) => {
  test.skip(hosted || browserName !== 'chromium' || !hasLifePublication,
    'The full pilot runs once when the complete local life publication is available.');
  const journeyRequests: string[] = [];
  page.on('request', request => { if (request.url().includes('/data/journeys/')) journeyRequests.push(request.url()); });
  await page.goto('/?dataset=life', { waitUntil: 'domcontentloaded' });
  const app = page.locator('main.app');
  await expect(app).toHaveAttribute('data-tree-ready', 'true', { timeout: 20_000 });
  expect(journeyRequests).toEqual([]);
  const header = page.locator('header.top-bar');
  await expect(header.getByText('Tree of Life', { exact: true })).toBeVisible();
  await expect(header.getByRole('combobox', { name: 'Search taxa' })).toBeVisible();
  await expect(page.locator('.explore-hint')).toHaveCount(0);
  await header.getByRole('button', { name: 'Explore' }).click();
  const explore = header.getByRole('menu', { name: 'Explore the Tree of Life' });
  await expect(explore.getByRole('menuitem', { name: /All Life/ })).toBeVisible();
  await expect(explore.getByRole('group', { name: 'Domains' }).getByRole('menuitem')).toHaveCount(3);
  await expect(explore.getByRole('menuitem', { name: /Birds/ })).toContainText('Aves');
  await header.getByRole('button', { name: 'Explore' }).press('Escape');
  await header.getByRole('button', { name: /Journeys/ }).click();
  await expect(header.getByRole('menuitem')).toHaveCount(3);
  expect(journeyRequests.some(url => url.endsWith('/data/journeys/manifest.json'))).toBe(true);
  expect(journeyRequests.some(url => url.endsWith('/catalog.json'))).toBe(true);
  expect(journeyRequests.some(url => /\/(?:birds-flight|vertebrate-vision|human-bipedalism)\.json$/.test(url))).toBe(false);
  await expect(header.getByRole('menuitem', { name: /Vision · From Light-Sensitive Cells/ })).toBeVisible();
  await expect(header.getByRole('menuitem', { name: /Bipedalism · From Climbing Apes/ })).toBeVisible();
  await header.getByRole('menuitem', { name: /From Feathered Dinosaurs to Modern Birds/ }).click();
  const library = page.getByLabel('Evolutionary journeys');
  await expect(library.getByRole('heading', { name: 'Flight' })).toBeVisible();
  expect(journeyRequests.filter(url => url.endsWith('/birds-flight.json'))).toHaveLength(1);
  await expect(library.getByRole('heading', { name: 'From Feathered Dinosaurs to Modern Birds' })).toBeVisible();
  await expect(library.getByRole('img', { name: /Sinosauropteryx/ })).toBeVisible();
  await library.getByRole('button', { name: /Begin journey/ }).click();
  const player = page.getByLabel('Evolutionary journey');
  await expect(player.getByRole('heading', { name: 'Feathers before flight' })).toBeVisible();
  await expect(player.getByRole('img', { name: /Sinosauropteryx/ })).toBeVisible();
  await expect(app).not.toHaveAttribute('data-pending-taxon', 'Sinosauropteryx', { timeout: 20_000 });
  await expect.poll(async () => Number(await app.getAttribute('data-camera-zoom'))).toBeLessThanOrEqual(11);
  await player.getByRole('button', { name: /Next: Vaned feathers become versatile/ }).click();
  await expect(player.getByRole('heading', { name: 'Vaned feathers become versatile' })).toBeVisible();
  await expect(player.getByRole('img', { name: /Caudipteryx/ })).toBeVisible();
  await expect(page).toHaveURL(/journey=birds-flight.*step=1/);
  for (const step of [3, 4, 6]) {
    await player.getByRole('button', { name: new RegExp(`Go to step ${step}:`) }).click();
    await expect(page).toHaveURL(new RegExp(`journey=birds-flight.*step=${step - 1}`));
    await expect(app).not.toHaveAttribute('data-pending-taxon', /.+/, { timeout: 20_000 });
    await expect.poll(async () => Number(await app.getAttribute('data-camera-zoom'))).toBeLessThanOrEqual(11);
  }
  await player.getByRole('button', { name: 'Explore from here' }).click();
  await expect(page.getByRole('button', { name: /Resume: From Feathered Dinosaurs/ })).toBeVisible();
});

test('a newly published scientific Journey loads its media and navigates a real taxon', async ({ page, browserName }) => {
  test.skip(hosted || browserName !== 'chromium' || !hasLifePublication,
    'Editorial Journey navigation runs once when the complete local life publication is available.');
  await page.goto('/?dataset=life', { waitUntil: 'domcontentloaded' });
  const app = page.locator('main.app');
  await expect(app).toHaveAttribute('data-tree-ready', 'true', { timeout: 20_000 });
  const header = page.locator('header.top-bar');
  await header.getByRole('button', { name: /Journeys/ }).click();
  await header.getByRole('menuitem', { name: /Vision · From Light-Sensitive Cells/ }).click();
  const library = page.getByLabel('Evolutionary journeys');
  await expect(library.getByRole('heading', { name: 'Vision' })).toBeVisible();
  const image = library.getByRole('img', { name: /European lancelet/ });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await library.getByRole('button', { name: /Begin journey/ }).click();
  await expect(page).toHaveURL(/journey=vertebrate-vision.*step=0/);
  await expect(app).not.toHaveAttribute('data-pending-taxon', 'Branchiostoma lanceolatum', { timeout: 20_000 });
  await expect(page.getByLabel('Evolutionary journey').getByRole('heading', { name: 'A direction for light' })).toBeVisible();
});
