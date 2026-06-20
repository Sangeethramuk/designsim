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
      SUPABASE_URL: 'https://test.supabase.co',
      SUPABASE_ANON_KEY: 'test-anon-key',
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

  describe('GET /config', () => {
    it('returns public config without auth', async () => {
      const req = new Request('https://worker.test/config', { method: 'GET' });
      const resp = await handler.fetch(req, mockEnv);
      const data = await resp.json();

      expect(resp.status).toBe(200);
      expect(data.supabaseUrl).toBe('https://test.supabase.co');
      expect(data.supabaseAnonKey).toBe('test-anon-key');
      expect(data.workerUrl).toContain('worker.test');
      expect(data.authMode).toBe('secret'); // WORKER_SECRET is set, no JWT
    });

    it('reflects JWT auth mode when SUPABASE_JWT_SECRET is set', async () => {
      const req = new Request('https://worker.test/config', { method: 'GET' });
      const resp = await handler.fetch(req, { ...mockEnv, SUPABASE_JWT_SECRET: 'jwt-secret' });
      const data = await resp.json();

      expect(resp.status).toBe(200);
      expect(data.authMode).toBe('jwt');
    });
  });

  describe('Auth enforcement', () => {
    it('returns 401 when no auth configured', async () => {
      const req = new Request('https://worker.test/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [] }),
      });
      const resp = await handler.fetch(req, { ...mockEnv, WORKER_SECRET: undefined, SUPABASE_JWT_SECRET: undefined });
      const data = await resp.json();

      expect(resp.status).toBe(401);
      expect(data.error.message).toContain('No authentication configured');
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
      const _data = await resp.json();

      expect(resp.status).toBe(403);
      expect(_data.error.message).toContain('private');
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

  describe('POST /tool/brave-search', () => {
    it('returns 503 when BRAVE_API_KEY not configured', async () => {
      const req = new Request('https://worker.test/tool/brave-search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Worker-Secret': 'test-secret',
        },
        body: JSON.stringify({ query: 'test' }),
      });
      const resp = await handler.fetch(req, { ...mockEnv, BRAVE_API_KEY: undefined });
      const data = await resp.json();

      expect(resp.status).toBe(503);
      expect(data.error.message).toContain('Brave Search not configured');
    });

    it('rejects missing query', async () => {
      const req = new Request('https://worker.test/tool/brave-search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Worker-Secret': 'test-secret',
        },
        body: JSON.stringify({}),
      });
      const resp = await handler.fetch(req, { ...mockEnv, BRAVE_API_KEY: 'brave-key' });
      const data = await resp.json();

      expect(resp.status).toBe(400);
      expect(data.error.message).toContain('query must be a string');
    });

    it('rejects non-string query', async () => {
      const req = new Request('https://worker.test/tool/brave-search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Worker-Secret': 'test-secret',
        },
        body: JSON.stringify({ query: 123 }),
      });
      const resp = await handler.fetch(req, { ...mockEnv, BRAVE_API_KEY: 'brave-key' });
      const data = await resp.json();

      expect(resp.status).toBe(400);
      expect(data.error.message).toContain('query must be a string');
    });

    it('passes valid query to Brave API and returns formatted results', async () => {
      global.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            web: {
              results: [
                { title: 'Result 1', url: 'https://example.com/1', description: 'Desc 1', age: '1d' },
                { title: 'Result 2', url: 'https://example.com/2', description: 'Desc 2' },
              ],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const req = new Request('https://worker.test/tool/brave-search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Worker-Secret': 'test-secret',
        },
        body: JSON.stringify({ query: 'design systems', count: 2 }),
      });
      const resp = await handler.fetch(req, { ...mockEnv, BRAVE_API_KEY: 'brave-key' });
      const data = await resp.json();

      expect(resp.status).toBe(200);
      expect(data.ok).toBe(true);
      expect(data.results).toHaveLength(2);
      expect(data.content).toContain('design systems');
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('api.search.brave.com'),
        expect.objectContaining({
          headers: expect.objectContaining({ 'X-Subscription-Token': 'brave-key' }),
        })
      );
    });

    it('handles Brave API error gracefully', async () => {
      global.fetch = vi.fn().mockResolvedValue(
        new Response('Unauthorized', { status: 401 })
      );

      const req = new Request('https://worker.test/tool/brave-search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Worker-Secret': 'test-secret',
        },
        body: JSON.stringify({ query: 'test' }),
      });
      const resp = await handler.fetch(req, { ...mockEnv, BRAVE_API_KEY: 'bad-key' });
      const data = await resp.json();

      expect(resp.status).toBe(200);
      expect(data.results).toEqual([]);
      expect(data.error).toContain('401');
    });
  });

  describe('POST /tool/figma', () => {
    it('returns 503 when FIGMA_TOKEN not configured', async () => {
      const req = new Request('https://worker.test/tool/figma', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Worker-Secret': 'test-secret',
        },
        body: JSON.stringify({ action: 'get_file', fileKey: 'ABC123' }),
      });
      const resp = await handler.fetch(req, { ...mockEnv, FIGMA_TOKEN: undefined });
      const data = await resp.json();

      expect(resp.status).toBe(503);
      expect(data.error.message).toContain('Figma not configured');
    });

    it('rejects missing action', async () => {
      const req = new Request('https://worker.test/tool/figma', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Worker-Secret': 'test-secret',
        },
        body: JSON.stringify({}),
      });
      const resp = await handler.fetch(req, { ...mockEnv, FIGMA_TOKEN: 'figma-token' });
      const data = await resp.json();

      expect(resp.status).toBe(400);
      expect(data.error.message).toContain('action is required');
    });

    it('rejects invalid fileKey', async () => {
      const req = new Request('https://worker.test/tool/figma', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Worker-Secret': 'test-secret',
        },
        body: JSON.stringify({ action: 'get_file', fileKey: 'abc-123!' }),
      });
      const resp = await handler.fetch(req, { ...mockEnv, FIGMA_TOKEN: 'figma-token' });
      const data = await resp.json();

      expect(resp.status).toBe(400);
      expect(data.error.message).toContain('fileKey must be alphanumeric');
    });

    it('handles push_design_spec successfully', async () => {
      global.fetch = vi.fn().mockImplementation((url) => {
        if (url.includes('/comments')) {
          return Promise.resolve(
            new Response(JSON.stringify({ id: 'comment-123' }), { status: 200 })
          );
        }
        if (url.includes('/variables')) {
          return Promise.resolve(
            new Response(JSON.stringify({}), { status: 200 })
          );
        }
        return Promise.resolve(new Response('{}', { status: 200 }));
      });

      const req = new Request('https://worker.test/tool/figma', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Worker-Secret': 'test-secret',
        },
        body: JSON.stringify({
          action: 'push_design_spec',
          fileKey: 'ABC123',
          comment: 'Design brief',
          colors: [{ name: 'primary', hex: '#ff0000' }],
        }),
      });
      const resp = await handler.fetch(req, { ...mockEnv, FIGMA_TOKEN: 'figma-token' });
      const data = await resp.json();

      expect(resp.status).toBe(200);
      expect(data.ok).toBe(true);
      expect(data.commentId).toBe('comment-123');
      expect(data.tokenCount).toBe(1);
    });

    it('handles get_variables action', async () => {
      global.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ meta: { variables: [] } }), { status: 200 })
      );

      const req = new Request('https://worker.test/tool/figma', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Worker-Secret': 'test-secret',
        },
        body: JSON.stringify({ action: 'get_variables', fileKey: 'ABC123' }),
      });
      const resp = await handler.fetch(req, { ...mockEnv, FIGMA_TOKEN: 'figma-token' });

      expect(resp.status).toBe(200);
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.figma.com/v1/files/ABC123/variables/local',
        expect.objectContaining({
          headers: expect.objectContaining({ 'X-Figma-Token': 'figma-token' }),
        })
      );
    });

    it('rejects unknown action', async () => {
      const req = new Request('https://worker.test/tool/figma', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Worker-Secret': 'test-secret',
        },
        body: JSON.stringify({ action: 'invalid_action', fileKey: 'ABC123' }),
      });
      const resp = await handler.fetch(req, { ...mockEnv, FIGMA_TOKEN: 'figma-token' });
      const data = await resp.json();

      expect(resp.status).toBe(400);
      expect(data.error.message).toContain('Unknown Figma action');
    });
  });

  describe('Rate limiting', () => {
    it('allows requests within rate limit window', async () => {
      mockEnv.SHARES.get = vi.fn().mockResolvedValue(null);
      mockEnv.SHARES.put = vi.fn().mockResolvedValue(undefined);

      // Make 60 requests
      for (let i = 0; i < 60; i++) {
        const req = new Request('https://worker.test/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Worker-Secret': 'test-secret',
            'CF-Connecting-IP': '1.2.3.4',
          },
          body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
        });
        global.fetch = vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 })
        );
        const resp = await handler.fetch(req, mockEnv);
        expect(resp.status).toBe(200);
      }
    });

    it('blocks 61st request with 429', async () => {
      // Simulate 60 requests already made in window
      mockEnv.SHARES.get = vi.fn().mockResolvedValue(
        JSON.stringify({ count: 60, windowStart: Date.now() })
      );
      mockEnv.SHARES.put = vi.fn().mockResolvedValue(undefined);

      const req = new Request('https://worker.test/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Worker-Secret': 'test-secret',
          'CF-Connecting-IP': '1.2.3.4',
        },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      });
      const resp = await handler.fetch(req, mockEnv);
      const data = await resp.json();

      expect(resp.status).toBe(429);
      expect(data.error.message).toContain('Rate limit exceeded');
    });
  });

  describe('SSE streaming', () => {
    it('parses data chunks and forwards content tokens', async () => {
      const sseChunks = [
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
        'data: [DONE]\n\n',
      ];

      global.fetch = vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream({
            start(controller) {
              sseChunks.forEach((chunk) => controller.enqueue(new TextEncoder().encode(chunk)));
              controller.close();
            },
          }),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
        )
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
          stream: true,
        }),
      });
      const resp = await handler.fetch(req, mockEnv);

      expect(resp.status).toBe(200);
      expect(resp.headers.get('Content-Type')).toContain('text/event-stream');

      // Read the streamed response
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let streamedText = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        streamedText += decoder.decode(value, { stream: true });
      }

      expect(streamedText).toContain('Hello');
      expect(streamedText).toContain('world');
    });

    it('propagates upstream errors', async () => {
      global.fetch = vi.fn().mockResolvedValue(
        new Response('Internal Server Error', { status: 500 })
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
          stream: true,
        }),
      });
      const resp = await handler.fetch(req, mockEnv);

      // Streaming mode passes through upstream status code directly
      expect(resp.status).toBe(500);
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
