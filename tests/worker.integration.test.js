import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the worker's default export for integration testing
// We test the route logic by calling the exported fetch handler with mock Request/Env

describe('Worker Integration Tests', () => {
  let handler;
  let mockEnv;

  beforeEach(async () => {
    // Dynamically import the worker module
    const mod = await import('../worker/src/index.js');
    handler = mod.default;

    mockEnv = {
      WORKER_SECRET: 'test-secret',
      LLM_BASE_URL: 'https://api.test-llm.com',
      LLM_API_KEY: 'test-api-key',
      WORKER_VERSION: '1.0.0-test',
      ALLOWED_ORIGINS: 'http://localhost:5173',
      SHARES: {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
        getWithMetadata: vi.fn().mockResolvedValue({ value: null, metadata: null }),
      },
    };
  });

  describe('GET /health', () => {
    it('returns ok status without auth', async () => {
      const req = new Request('https://worker.test/health', { method: 'GET' });
      const resp = await handler.fetch(req, mockEnv);
      const data = await resp.json();

      expect(resp.status).toBe(200);
      expect(data.status).toBe('ok');
      expect(data.version).toBe('1.0.0-test');
      expect(data.llm).toBe(true);
      expect(data.shares).toBe(true);
    });

    it('does not require WORKER_SECRET', async () => {
      const req = new Request('https://worker.test/health', { method: 'GET' });
      const resp = await handler.fetch(req, { ...mockEnv, WORKER_SECRET: undefined });
      expect(resp.status).toBe(200);
    });
  });

  describe('Auth enforcement', () => {
    it('returns 401 without WORKER_SECRET configured', async () => {
      const req = new Request('https://worker.test/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [] }),
      });
      const resp = await handler.fetch(req, { ...mockEnv, WORKER_SECRET: undefined });
      const data = await resp.json();

      expect(resp.status).toBe(401);
      expect(data.error.message).toContain('WORKER_SECRET not configured');
    });

    it('returns 401 with wrong X-Worker-Secret header', async () => {
      const req = new Request('https://worker.test/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Worker-Secret': 'wrong-secret',
        },
        body: JSON.stringify({ messages: [] }),
      });
      const resp = await handler.fetch(req, mockEnv);
      expect(resp.status).toBe(401);
    });

    it('accepts correct X-Worker-Secret header', async () => {
      global.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: 'test' } }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const req = new Request('https://worker.test/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Worker-Secret': 'test-secret',
        },
        body: JSON.stringify({
          model: 'test-model',
          messages: [{ role: 'user', content: 'hello' }],
        }),
      });
      const resp = await handler.fetch(req, mockEnv);
      expect(resp.status).toBe(200);
    });
  });

  describe('POST /share', () => {
    it('stores HTML and returns a share URL', async () => {
      mockEnv.SHARES.put = vi.fn().mockResolvedValue(undefined);

      const req = new Request('https://worker.test/share', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Worker-Secret': 'test-secret',
        },
        body: JSON.stringify({
          html: '<!DOCTYPE html><html><body><h1>Test</h1></body></html>',
          title: 'Test Share',
          type: 'dossier',
        }),
      });
      const resp = await handler.fetch(req, mockEnv);
      const data = await resp.json();

      expect(resp.status).toBe(200);
      expect(data.ok).toBe(true);
      expect(data.url).toContain('/s/');
      expect(data.id).toHaveLength(8);
      expect(mockEnv.SHARES.put).toHaveBeenCalled();
    });

    it('rejects missing html field', async () => {
      const req = new Request('https://worker.test/share', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Worker-Secret': 'test-secret',
        },
        body: JSON.stringify({ title: 'No HTML' }),
      });
      const resp = await handler.fetch(req, mockEnv);
      const data = await resp.json();

      expect(resp.status).toBe(400);
      expect(data.error.message).toContain('html field is required');
    });

    it('rejects oversized HTML', async () => {
      const hugeHtml = 'x'.repeat(11 * 1024 * 1024);
      const req = new Request('https://worker.test/share', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Worker-Secret': 'test-secret',
        },
        body: JSON.stringify({ html: hugeHtml }),
      });
      const resp = await handler.fetch(req, mockEnv);
      const data = await resp.json();

      expect(resp.status).toBe(413);
      expect(data.error.message).toContain('too large');
    });
  });

  describe('GET /s/:id (serve share)', () => {
    it('serves stored HTML with strict CSP', async () => {
      mockEnv.SHARES.getWithMetadata = vi.fn().mockResolvedValue({
        value: '<!DOCTYPE html><html><body><h1>Shared</h1></body></html>',
        metadata: { title: 'Test', type: 'dossier', created: '2025-01-01T00:00:00Z' },
      });

      const req = new Request('https://worker.test/s/abc12345', { method: 'GET' });
      const resp = await handler.fetch(req, mockEnv);

      expect(resp.status).toBe(200);
      expect(resp.headers.get('Content-Type')).toContain('text/html');
      expect(resp.headers.get('Content-Security-Policy')).toContain("script-src 'none'");
      expect(resp.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(resp.headers.get('X-Frame-Options')).toBe('DENY');
    });

    it('returns 404 for non-existent share', async () => {
      mockEnv.SHARES.getWithMetadata = vi.fn().mockResolvedValue({ value: null, metadata: null });

      const req = new Request('https://worker.test/s/nonexist', { method: 'GET' });
      const resp = await handler.fetch(req, mockEnv);

      expect(resp.status).toBe(404);
      const text = await resp.text();
      expect(text).toContain('not found');
    });

    it('does not require auth', async () => {
      mockEnv.SHARES.getWithMetadata = vi.fn().mockResolvedValue({ value: null, metadata: null });

      const req = new Request('https://worker.test/s/test123', { method: 'GET' });
      const resp = await handler.fetch(req, { ...mockEnv, WORKER_SECRET: undefined });
      expect(resp.status).toBe(404); // 404 not 401 — auth not required
    });
  });

  describe('POST /v1/chat/completions (LLM proxy)', () => {
    it('validates messages array is required', async () => {
      const req = new Request('https://worker.test/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Worker-Secret': 'test-secret',
        },
        body: JSON.stringify({ model: 'test' }),
      });
      const resp = await handler.fetch(req, mockEnv);
      const data = await resp.json();

      expect(resp.status).toBe(400);
      expect(data.error.message).toContain('messages array is required');
    });

    it('returns 503 when LLM not configured', async () => {
      const req = new Request('https://worker.test/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Worker-Secret': 'test-secret',
        },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      });
      const resp = await handler.fetch(req, { ...mockEnv, LLM_BASE_URL: undefined, LLM_API_KEY: undefined });
      expect(resp.status).toBe(503);
    });
  });

  describe('POST /tool/webfetch', () => {
    it('blocks SSRF attempts on private IPs', async () => {
      const req = new Request('https://worker.test/tool/webfetch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Worker-Secret': 'test-secret',
        },
        body: JSON.stringify({ url: 'http://169.254.169.254/latest/meta-data/' }),
      });
      const resp = await handler.fetch(req, mockEnv);
      const data = await resp.json();

      expect(resp.status).toBe(403);
      expect(data.error.message).toContain('private');
    });

    it('blocks localhost', async () => {
      const req = new Request('https://worker.test/tool/webfetch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Worker-Secret': 'test-secret',
        },
        body: JSON.stringify({ url: 'http://localhost:3000/admin' }),
      });
      const resp = await handler.fetch(req, mockEnv);
      expect(resp.status).toBe(403);
    });

    it('validates URL is required', async () => {
      const req = new Request('https://worker.test/tool/webfetch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Worker-Secret': 'test-secret',
        },
        body: JSON.stringify({}),
      });
      const resp = await handler.fetch(req, mockEnv);
      expect(resp.status).toBe(400);
    });
  });

  describe('CORS', () => {
    it('allows preflight from allowed origin', async () => {
      const req = new Request('https://worker.test/health', {
        method: 'OPTIONS',
        headers: { Origin: 'http://localhost:5173' },
      });
      const resp = await handler.fetch(req, mockEnv);

      expect(resp.status).toBe(204);
      expect(resp.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
      expect(resp.headers.get('Vary')).toBe('Origin');
    });

    it('blocks preflight from non-allowed origin', async () => {
      const req = new Request('https://worker.test/health', {
        method: 'OPTIONS',
        headers: { Origin: 'http://evil.com' },
      });
      const resp = await handler.fetch(req, mockEnv);

      expect(resp.status).toBe(204);
      expect(resp.headers.get('Access-Control-Allow-Origin')).toBeNull();
    });
  });

  describe('404 handling', () => {
    it('returns 404 for unknown routes', async () => {
      const req = new Request('https://worker.test/unknown', {
        method: 'GET',
        headers: { 'X-Worker-Secret': 'test-secret' },
      });
      const resp = await handler.fetch(req, mockEnv);
      expect(resp.status).toBe(404);
    });
  });
});
