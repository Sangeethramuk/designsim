/**
 * Design Swarm Worker
 * Cloudflare Worker — LLM proxy + server-side tools
 *
 * Routes:
 *   POST /v1/chat/completions   → LLM proxy (drop-in OpenAI-compatible)
 *   POST /tool/webfetch         → server-side page fetch (no CORS issues)
 *   POST /tool/figma            → Figma REST API calls
 *   POST /share                 → store HTML in KV, return permanent public URL
 *   GET  /s/:id                 → serve shared HTML publicly (no auth required)
 *   GET  /health                → health check
 */

// ─── CORS Headers ────────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Worker-Secret',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function errorJson(message, status = 400) {
  return json({ error: { message } }, status);
}

// ─── Auth guard (optional) ───────────────────────────────────────────────────
function isAuthorized(req, env) {
  // If no WORKER_SECRET set → open access (personal use)
  if (!env.WORKER_SECRET) return true;
  const header = req.headers.get('X-Worker-Secret') || '';
  return header === env.WORKER_SECRET;
}

// ─── Main Handler ────────────────────────────────────────────────────────────
export default {
  async fetch(req, env) {
    try {
      const url = new URL(req.url);

      // CORS preflight
      if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS });
      }

      // Health check
      if (url.pathname === '/health') {
        return json({
          status: 'ok',
          version: env.WORKER_VERSION || '1.0.0',
          llm: !!env.LLM_BASE_URL,
          figma: !!env.FIGMA_TOKEN,
          brave: !!env.BRAVE_API_KEY,
          shares: !!env.SHARES,
        });
      }

      // ── Route: Serve shared page — PUBLIC, no auth ─────────────────────────
      if (url.pathname.startsWith('/s/') && req.method === 'GET') {
        return handleServeShare(req, env, url);
      }

      // Auth check on all other routes
      if (!isAuthorized(req, env)) {
        return errorJson('Unauthorized', 401);
      }

      // ── Route: LLM Proxy ───────────────────────────────────────────────────
      if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
        return handleLLM(req, env);
      }

      // ── Route: Brave Search tool ───────────────────────────────────────────
      if (url.pathname === '/tool/brave-search' && req.method === 'POST') {
        return handleBraveSearch(req, env);
      }

      // ── Route: Webfetch tool ───────────────────────────────────────────────
      if (url.pathname === '/tool/webfetch' && req.method === 'POST') {
        return handleWebfetch(req, env);
      }

      // ── Route: Figma tool ──────────────────────────────────────────────────
      if (url.pathname.startsWith('/tool/figma') && req.method === 'POST') {
        return handleFigma(req, env);
      }

      // ── Route: Share — store HTML in KV, return permanent public URL ────────
      if (url.pathname === '/share' && req.method === 'POST') {
        return handleShare(req, env, url);
      }

      return errorJson('Not found', 404);
    } catch (err) {
      // Top-level catch — prevents Cloudflare 1101 "Worker threw exception"
      console.error('[Worker] unhandled error:', err?.message, err?.stack);
      return json({ error: { message: 'Internal worker error: ' + (err?.message || String(err)) } }, 500);
    }
  },
};

// ─── LLM Proxy ───────────────────────────────────────────────────────────────
async function handleLLM(req, env) {
  if (!env.LLM_BASE_URL || !env.LLM_API_KEY) {
    return errorJson('LLM not configured — set LLM_BASE_URL and LLM_API_KEY secrets', 503);
  }

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return errorJson('Invalid JSON body');
  }

  const isStreaming = body.stream === true;
  const targetUrl = env.LLM_BASE_URL.replace(/\/$/, '') + '/v1/chat/completions';

  let upstream;
  try {
    upstream = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + env.LLM_API_KEY,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000), // 2 min — long enough for large generations
    });
  } catch (e) {
    return errorJson('LLM upstream error: ' + e.message, 502);
  }

  // Streaming — pipe directly to client
  if (isStreaming && upstream.body) {
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        ...CORS,
      },
    });
  }

  // Non-streaming — parse and forward
  try {
    const data = await upstream.json();
    return json(data, upstream.status);
  } catch (e) {
    return errorJson('LLM response parse error: ' + e.message, 502);
  }
}

// ─── Webfetch Tool ────────────────────────────────────────────────────────────
// Server-side fetch — no CORS restrictions, no corsproxy.io dependency
async function handleWebfetch(req, env) {
  let body;
  try {
    body = await req.json();
  } catch (e) {
    return errorJson('Invalid JSON body');
  }

  const { url, reason } = body;
  if (!url || !url.startsWith('http')) {
    return errorJson('url is required and must start with http');
  }

  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; DesignSwarm/1.0)',
        'Accept': 'text/html,application/json,*/*',
      },
      // 10 second timeout
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      return json({ content: `HTTP ${resp.status} fetching ${url}`, url, ok: false });
    }

    const ct = resp.headers.get('content-type') || '';
    const raw = await resp.text();

    let content;
    if (ct.includes('json')) {
      // JSON — return directly
      content = `[webfetch: ${url}]\n` + raw.slice(0, 5000);
    } else {
      // HTML — strip tags, extract readable text
      content = stripHtml(raw, url, reason);
    }

    return json({ content, url, ok: true });
  } catch (e) {
    return json({ content: `webfetch failed: ${e.message}`, url, ok: false });
  }
}

// ─── Brave Search Tool ────────────────────────────────────────────────────────
async function handleBraveSearch(req, env) {
  if (!env.BRAVE_API_KEY) {
    return errorJson('Brave Search not configured — set BRAVE_API_KEY secret', 503);
  }

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return errorJson('Invalid JSON body');
  }

  const { query, count = 8 } = body;
  if (!query || !query.trim()) {
    return errorJson('query is required');
  }

  try {
    const searchUrl = 'https://api.search.brave.com/res/v1/web/search?' +
      new URLSearchParams({ q: query, count: Math.min(count, 10), search_lang: 'en' });

    const resp = await fetch(searchUrl, {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': env.BRAVE_API_KEY,
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!resp.ok) {
      return json({ results: [], error: `Brave API error: HTTP ${resp.status}`, query });
    }

    const data = await resp.json();
    const results = (data.web?.results || []).map(r => ({
      title: r.title,
      url: r.url,
      description: r.description,
      age: r.age,
    }));

    // Format as readable text for the LLM
    const formatted = results.map((r, i) =>
      `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.description || ''}${r.age ? ' (' + r.age + ')' : ''}`
    ).join('\n\n');

    const content = `[brave_search: "${query}"]\n\n${formatted || 'No results found.'}`;
    return json({ content, results, query, ok: true });
  } catch (e) {
    return json({ content: `brave_search failed for "${query}": ${e.message}`, results: [], query, ok: false });
  }
}

// ─── Share: Store HTML in KV ──────────────────────────────────────────────────
function generateId(len = 8) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < len; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

async function handleShare(req, env, url) {
  if (!env.SHARES) {
    return errorJson('KV namespace SHARES not configured — run: wrangler kv:namespace create SHARES', 503);
  }

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return errorJson('Invalid JSON body');
  }

  const { html, title = 'Design Swarm Export', type = 'dossier' } = body;
  if (!html || typeof html !== 'string') {
    return errorJson('html field is required');
  }
  if (html.length > 10 * 1024 * 1024) {
    return errorJson('HTML too large (max 10 MB)');
  }

  const id = generateId(8);
  const meta = { title, type, created: new Date().toISOString(), size: html.length };

  // Store permanently in KV (no TTL = never expires)
  await env.SHARES.put(id, html, { metadata: meta });

  const shareUrl = `${url.origin}/s/${id}`;
  return json({ ok: true, url: shareUrl, id, meta });
}

// ─── Share: Serve stored HTML publicly ────────────────────────────────────────
async function handleServeShare(req, env, url) {
  if (!env.SHARES) {
    return new Response('Sharing not configured on this worker.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  const id = url.pathname.slice(3).replace(/[^a-z0-9]/gi, '');
  if (!id) {
    return new Response('Missing share ID.', { status: 400, headers: { 'Content-Type': 'text/plain' } });
  }

  const { value: html, metadata } = await env.SHARES.getWithMetadata(id, 'text');
  if (!html) {
    return new Response(
      '<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;background:#0d0d14;color:#fff">' +
      '<h2>Link not found</h2><p>This share link does not exist or has been removed.</p>' +
      '</body></html>',
      { status: 404, headers: { 'Content-Type': 'text/html;charset=utf-8' } },
    );
  }

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html;charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'X-Share-Id': id,
      'X-Share-Title': (metadata?.title || '').slice(0, 100),
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────

function stripHtml(html, url, reason) {
  // Remove script, style, nav, footer, header blocks
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<[^>]+>/g, ' ')           // strip remaining tags
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, ' ')            // collapse whitespace
    .trim();

  const snippet = text.slice(0, 5000) + (text.length > 5000 ? '\n…(truncated)' : '');
  return `[webfetch: ${url}${reason ? ' | ' + reason : ''}]\n\n${snippet}`;
}

// ─── Figma Tool ───────────────────────────────────────────────────────────────

// Build the Figma Variables API payload from a flat colors array
// colors: [{name: string, r: number, g: number, b: number}]
function buildVariablesPayload(colors) {
  return {
    variableCollections: [{
      action: 'CREATE',
      id: 'coll1',
      name: 'Design Swarm Tokens',
      initialModeId: 'mode1',
    }],
    variableModes: [{
      action: 'CREATE',
      id: 'mode1',
      name: 'Default',
      variableCollectionId: 'coll1',
    }],
    variables: colors.map((c, i) => ({
      action: 'CREATE',
      id: 'var' + i,
      name: c.name,
      resolvedType: 'COLOR',
      variableCollectionId: 'coll1',
    })),
    variableModeValues: colors.map((c, i) => ({
      action: 'CREATE',
      variableId: 'var' + i,
      modeId: 'mode1',
      value: { r: c.r, g: c.g, b: c.b, a: 1 },
    })),
  };
}

async function handleFigma(req, env) {
  if (!env.FIGMA_TOKEN) {
    return errorJson('Figma not configured — set FIGMA_TOKEN secret', 503);
  }

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return errorJson('Invalid JSON body');
  }

  const { action, fileKey, nodeIds } = body;

  const figmaHeaders = {
    'X-Figma-Token': env.FIGMA_TOKEN,
    'Content-Type': 'application/json',
  };

  // ── Combined action: post spec comment + push design tokens ─────────────────
  if (action === 'push_design_spec') {
    if (!fileKey) return errorJson('fileKey is required');

    const comment = body.comment || '🤖 Design Swarm Export';
    const colors  = Array.isArray(body.colors) ? body.colors : [];

    try {
      // Step 1: Post comment
      const commentResp = await fetch(
        `https://api.figma.com/v1/files/${fileKey}/comments`,
        {
          method: 'POST',
          headers: figmaHeaders,
          body: JSON.stringify({ message: comment }),
          signal: AbortSignal.timeout(15000),
        },
      );
      const commentData = await commentResp.json();
      if (!commentResp.ok) {
        return json({
          ok: false,
          tokenCount: 0,
          error: commentData.err || `Figma comment API: ${commentResp.status}`,
        });
      }

      // Step 2: Push color tokens (best-effort; Variables API requires Enterprise)
      let tokenCount = 0;
      if (colors.length > 0) {
        try {
          const varResp = await fetch(
            `https://api.figma.com/v1/files/${fileKey}/variables`,
            {
              method: 'POST',
              headers: figmaHeaders,
              body: JSON.stringify(buildVariablesPayload(colors)),
              signal: AbortSignal.timeout(15000),
            },
          );
          if (varResp.ok) tokenCount = colors.length;
        } catch (_) { /* Variables API is Enterprise-only; swallow errors */ }
      }

      return json({ ok: true, tokenCount, commentId: commentData.id });
    } catch (e) {
      return errorJson('Figma push_design_spec error: ' + e.message, 500);
    }
  }

  try {
    let figmaUrl;
    let figmaMethod = 'GET';
    let figmaBody;

    switch (action) {
      // Get full file
      case 'get_file':
        figmaUrl = `https://api.figma.com/v1/files/${fileKey}`;
        break;

      // Get specific nodes
      case 'get_nodes':
        figmaUrl = `https://api.figma.com/v1/files/${fileKey}/nodes?ids=${(nodeIds || []).join(',')}`;
        break;

      // Get local variables
      case 'get_variables':
        figmaUrl = `https://api.figma.com/v1/files/${fileKey}/variables/local`;
        break;

      // Get file styles
      case 'get_styles':
        figmaUrl = `https://api.figma.com/v1/files/${fileKey}/styles`;
        break;

      // Get file components
      case 'get_components':
        figmaUrl = `https://api.figma.com/v1/files/${fileKey}/components`;
        break;

      // Get comments
      case 'get_comments':
        figmaUrl = `https://api.figma.com/v1/files/${fileKey}/comments`;
        break;

      // Post a comment
      case 'post_comment':
        figmaUrl = `https://api.figma.com/v1/files/${fileKey}/comments`;
        figmaMethod = 'POST';
        figmaBody = JSON.stringify({ message: body.message, client_meta: body.client_meta });
        break;

      // Push color design tokens as Figma Variables
      case 'push_variables': {
        if (!fileKey) return errorJson('fileKey is required');
        const colors = Array.isArray(body.colors) ? body.colors : [];
        if (!colors.length) return errorJson('colors array is required');
        figmaUrl = `https://api.figma.com/v1/files/${fileKey}/variables`;
        figmaMethod = 'POST';
        figmaBody = JSON.stringify(buildVariablesPayload(colors));
        break;
      }

      default:
        return errorJson(`Unknown Figma action: ${action}`);
    }

    const figmaResp = await fetch(figmaUrl, {
      method: figmaMethod,
      headers: figmaHeaders,
      body: figmaBody,
      signal: AbortSignal.timeout(15000),
    });

    const data = await figmaResp.json();
    return json(data, figmaResp.status);
  } catch (e) {
    return errorJson('Figma API error: ' + e.message, 500);
  }
}
