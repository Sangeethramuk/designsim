import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';

const VITE_PORT = 5175;
const BASE_URL = `http://localhost:${VITE_PORT}`;

describe('Studio E2E — Page Load Tests', () => {
  let viteProcess;
  let serverReady = false;

  beforeAll(async () => {
    // Start Vite dev server
    viteProcess = spawn('npx', ['vite', '--port', String(VITE_PORT), '--host'], {
      cwd: process.cwd(),
      shell: true,
      stdio: 'pipe',
    });

    // Wait for server to be ready
    for (let i = 0; i < 30; i++) {
      try {
        const resp = await fetch(`${BASE_URL}/`);
        if (resp.ok) {
          serverReady = true;
          break;
        }
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    if (!serverReady) {
      throw new Error('Vite dev server failed to start');
    }
  }, 30000);

  afterAll(() => {
    if (viteProcess) {
      viteProcess.kill();
    }
  });

  it('serves the landing page', async () => {
    const resp = await fetch(`${BASE_URL}/`);
    const html = await resp.text();

    expect(resp.status).toBe(200);
    expect(html).toContain('Design Floor');
    expect(html).toContain('AI Design Studio');
  });

  it('serves the studio page', async () => {
    const resp = await fetch(`${BASE_URL}/pixel-world.html`);
    const html = await resp.text();

    expect(resp.status).toBe(200);
    expect(html).toContain('game-container');
    expect(html).toContain('pixel-world.js');
    expect(html).toContain('pixel-world.css');
  });

  it('serves the extracted CSS file', async () => {
    const resp = await fetch(`${BASE_URL}/src/styles/pixel-world.css`);
    const css = await resp.text();

    expect(resp.status).toBe(200);
    expect(css).toContain('game-container');
    expect(css).toContain('chat-panel');
  });

  it('serves the extracted JS file', async () => {
    const resp = await fetch(`${BASE_URL}/js/pixel-world.js`);
    const js = await resp.text();

    expect(resp.status).toBe(200);
    expect(js).toContain('MAP_W');
    expect(js).toContain('AGENTS');
    expect(js).toContain('addEventListener');
  });

  it('serves config.local.example.js', async () => {
    const resp = await fetch(`${BASE_URL}/config.local.example.js`);
    expect(resp.status).toBe(200);
  });

  it('serves demo files from public/', async () => {
    const resp = await fetch(`${BASE_URL}/demo-dossier.html`);
    expect(resp.status).toBe(200);
    const html = await resp.text();
    expect(html).toContain('Design Floor');
  });

  it('serves medconnect prototype from public/', async () => {
    const resp = await fetch(`${BASE_URL}/medconnect-prototype.html`);
    expect(resp.status).toBe(200);
  });

  it('returns fallback for non-existent HTML files (Vite SPA mode)', async () => {
    const resp = await fetch(`${BASE_URL}/nonexistent-file.html`);
    // Vite dev server falls back to index.html for unknown routes
    expect(resp.status).toBe(200);
  });
});
