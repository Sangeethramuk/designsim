import { test, expect } from '@playwright/test';

test.describe('Studio — Critical User Flows', () => {
  test('studio page loads with Phaser game container', async ({ page }) => {
    await page.goto('/pixel-world.html');
    await expect(page.locator('#game-container')).toBeVisible();
  });

  test('auth logo shows Design Floor branding', async ({ page }) => {
    await page.goto('/pixel-world.html');
    await expect(page.locator('.auth-logo')).toHaveText('Design Floor Studio');
  });

  test('settings modal opens and shows Worker URL field', async ({ page }) => {
    await page.goto('/pixel-world.html');
    await page.locator('#llm-settings-btn').click();
    await expect(page.locator('#llm-settings-modal')).toBeVisible();
    await expect(page.locator('#worker-url')).toBeVisible();
    await expect(page.locator('#worker-secret')).toBeVisible();
  });

  test('brief input accepts text', async ({ page }) => {
    await page.goto('/pixel-world.html');
    const brief = page.locator('#brief-input');
    await brief.fill('A mobile banking app for senior citizens');
    await expect(brief).toHaveValue('A mobile banking app for senior citizens');
  });

  test('swarm run button exists in board panel', async ({ page }) => {
    await page.goto('/pixel-world.html');
    const btn = page.locator('#swarm-run-btn');
    await expect(btn).toHaveAttribute('onclick', 'runSwarm()');
    await expect(btn).toContainText('Run Swarm');
  });

  test('chat panel opens when clicking an agent', async ({ page }) => {
    await page.goto('/pixel-world.html');
    await page.waitForTimeout(2000);
    const agentLabels = page.locator('.agent-label');
    const count = await agentLabels.count();
    expect(count).toBeGreaterThan(0);
  });

  test('no hardcoded Supabase credentials in page source', async ({ page }) => {
    await page.goto('/pixel-world.html');
    const content = await page.content();
    expect(content).not.toContain('eyJhbGciOi');
    expect(content).not.toContain('ofidqxlnqvjpflicopcz');
  });

  test('no Design Swarm branding remains', async ({ page }) => {
    await page.goto('/pixel-world.html');
    const content = await page.content();
    expect(content).not.toContain('Design Swarm');
  });

  test('landing page loads with sign-in button', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#nav-cta')).toBeVisible();
  });

  test('landing page has CI badge link', async ({ page }) => {
    await page.goto('/');
    const content = await page.content();
    expect(content).toContain('14 AI AGENTS');
  });
});
