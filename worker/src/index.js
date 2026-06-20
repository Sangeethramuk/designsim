/**
 * Design Floor Worker
 * Cloudflare Worker — LLM proxy + server-side tools
 *
 * Routes:
 *   GET  /config               → public config (Supabase URL, anon key, worker URL)
 *   POST /v1/chat/completions   → LLM proxy (drop-in OpenAI-compatible)
 *   POST /tool/webfetch         → server-side page fetch (no CORS issues)
 *   POST /tool/brave-search     → Brave web search
 *   POST /tool/figma            → Figma REST API calls
 *   POST /share                 → store HTML in KV, return permanent public URL
 *   GET  /s/:id                 → serve shared HTML publicly (no auth required)
 *   GET  /health                → health check
 *
 * Security:
 *   - Supabase JWT verification (Authorization: Bearer <token>) for per-user auth
 *   - WORKER_SECRET fallback for dev/legacy clients (X-Worker-Secret header)
 *   - CORS is restricted to origins listed in ALLOWED_ORIGINS env var
 *   - SSRF protection blocks private/internal IPs on /tool/webfetch
 *   - Shared HTML is served with strict CSP (script-src 'none')
 *
 * Setup:
 *   wrangler secret put SUPABASE_JWT_SECRET  (from Supabase Project Settings → API → JWT Secret)
 *   wrangler secret put LLM_BASE_URL
 *   wrangler secret put LLM_API_KEY
 *   Set SUPABASE_URL, SUPABASE_ANON_KEY, ALLOWED_ORIGINS in [vars]
 */

// ─── CORS: Origin-based allowlist ────────────────────────────────────────────

/**
 * Get the allowed CORS origin from the request, based on ALLOWED_ORIGINS env var.
 * @param {Request} req - The incoming request
 * @param {Object} env - Cloudflare Worker environment bindings
 * @param {string} [env.ALLOWED_ORIGINS] - Comma-separated list of allowed origins
 * @returns {string|null} The allowed origin string, or null if not allowed
 */
function getAllowedOrigin(req, env) {
  const origin = req.headers.get('Origin');
  if (!origin) return null;
  const allowed = (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed.length === 0) return null;
  if (allowed.includes(origin)) return origin;
  return null;
}

/**
 * Build CORS response headers for the given allowed origin.
 * @param {string|null} allowedOrigin - The allowed origin or null
 * @returns {Record<string, string>} CORS headers object
 */
function corsHeaders(allowedOrigin) {
  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Worker-Secret',
  };
  if (allowedOrigin) {
    h['Access-Control-Allow-Origin'] = allowedOrigin;
    h['Vary'] = 'Origin';
  }
  return h;
}

/**
 * Create a JSON Response with CORS headers.
 * @param {Object} data - The data to JSON-stringify
 * @param {number} status - HTTP status code
 * @param {Record<string, string>} cors - CORS headers
 * @returns {Response}
 */
function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

/**
 * Create an error JSON Response.
 * @param {string} message - Error message
 * @param {number} status - HTTP status code
 * @param {Record<string, string>} cors - CORS headers
 * @returns {Response}
 */
function errorJson(message, status, cors) {
  return json({ error: { message } }, status, cors);
}

// ─── Constants ────────────────────────────────────────────────────────────────
const LLM_TIMEOUT_MS = 120000;
const WEBFETCH_TIMEOUT_MS = 10000;
const BRAVE_TIMEOUT_MS = 8000;
const FIGMA_TIMEOUT_MS = 15000;
const MAX_SHARE_SIZE = 10 * 1024 * 1024;
const MAX_BODY_SIZE = 10 * 1024 * 1024;
const MAX_WEBFETCH_SNIPPET = 5000;
const MAX_BRAVE_RESULTS = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 60;

// ─── Input validation helpers ────────────────────────────────────────────────
/**
 * Validate that a value is a string within a max length.
 * @param {unknown} val - The value to validate
 * @param {string} field - Field name for error messages
 * @param {number} [maxLen=10000] - Maximum allowed length
 * @returns {{ok: boolean, error?: string}}
 */
function validateString(val, field, maxLen = 10000) {
  if (typeof val !== 'string') return { ok: false, error: `${field} must be a string` };
  if (val.length > maxLen) return { ok: false, error: `${field} too long (max ${maxLen} chars)` };
  return { ok: true };
}

/**
 * Validate that a value is a valid HTTP/HTTPS URL.
 * @param {unknown} urlStr - The value to validate
 * @returns {{ok: boolean, error?: string}}
 */
function validateUrl(urlStr) {
  if (typeof urlStr !== 'string' || !urlStr.startsWith('http')) {
    return { ok: false, error: 'url is required and must start with http' };
  }
  try {
    new URL(urlStr);
  } catch {
    return { ok: false, error: 'Invalid URL format' };
  }
  return { ok: true };
}

/**
 * Validate that a Figma file key is alphanumeric.
 * @param {unknown} fileKey - The value to validate
 * @returns {{ok: boolean, error?: string}}
 */
function validateFileKey(fileKey) {
  if (typeof fileKey !== 'string' || !/^[a-zA-Z0-9]+$/.test(fileKey)) {
    return { ok: false, error: 'fileKey must be alphanumeric' };
  }
  return { ok: true };
}

// ─── Rate limiting (KV-based) ────────────────────────────────────────────────
/**
 * Check rate limit for the requesting IP using KV storage.
 * @param {Request} req - The incoming request
 * @param {Object} env - Worker environment with SHARES KV namespace
 * @param {Record<string, string>} _cors - CORS headers (unused)
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function checkRateLimit(req, env, _cors) {
  if (!env.SHARES) return { ok: true };

  const ip = req.headers.get('CF-Connecting-IP') || req.headers.get('X-Forwarded-For') || 'unknown';
  const key = 'rl:' + ip;
  const now = Date.now();

  try {
    const raw = await env.SHARES.get(key);
    const entry = raw ? JSON.parse(raw) : { count: 0, windowStart: now };

    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
      entry.count = 0;
      entry.windowStart = now;
    }

    entry.count++;

    await env.SHARES.put(key, JSON.stringify(entry), { expirationTtl: 120 });

    if (entry.count > RATE_LIMIT_MAX_REQUESTS) {
      return { ok: false, error: 'Rate limit exceeded — too many requests. Try again in a minute.' };
    }
  } catch {
    // KV errors shouldn't block requests
  }

  return { ok: true };
}

/**
 * Verify a Supabase JWT token.
 * Supports both ES256 (current Supabase ECC P-256 keys, verified via JWKS) and
 * HS256 (legacy shared-secret, verified via SUPABASE_JWT_SECRET env var).
 * @param {string} token - The JWT token from Authorization header
 * @param {Object} env - Worker environment bindings
 * @returns {Promise<{ok: boolean, userId?: string, reason?: string}>}
 */
async function verifyJwt(token, env) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return { ok: false, reason: 'Invalid token format' };
    const [headerB64, payloadB64, signatureB64] = parts;

    const decode = (b64) => JSON.parse(atob(b64.replace(/-/g, '+').replace(/_/g, '/')));
    const header = decode(headerB64);
    const payload = decode(payloadB64);

    if (payload.exp && Date.now() >= payload.exp * 1000) return { ok: false, reason: 'Token expired' };

    const data = new TextEncoder().encode(headerB64 + '.' + payloadB64);
    const sigBytes = Uint8Array.from(
      atob(signatureB64.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)
    );

    // ES256 — current Supabase ECC P-256 signing key, verified via JWKS endpoint
    if (header.alg === 'ES256') {
      const supabaseUrl = (env.SUPABASE_URL || '').replace(/\/$/, '');
      if (!supabaseUrl) return { ok: false, reason: 'SUPABASE_URL not configured for ES256 verification' };
      let jwks;
      try {
        const resp = await fetch(`${supabaseUrl}/auth/v1/.well-known/jwks.json`);
        jwks = await resp.json();
      } catch (e) {
        return { ok: false, reason: 'Failed to fetch JWKS' };
      }
      const jwk = (jwks.keys || []).find(k => !header.kid || k.kid === header.kid) || (jwks.keys || [])[0];
      if (!jwk) return { ok: false, reason: 'No matching JWK found' };
      const key = await crypto.subtle.importKey(
        'jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']
      );
      const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sigBytes, data);
      if (!valid) return { ok: false, reason: 'Invalid ES256 signature' };
      return { ok: true, userId: payload.sub || null };
    }

    // HS256 — legacy Supabase shared-secret (still valid for older tokens)
    if (header.alg === 'HS256' && env.SUPABASE_JWT_SECRET) {
      const keyData = new TextEncoder().encode(env.SUPABASE_JWT_SECRET);
      const key = await crypto.subtle.importKey(
        'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
      );
      const valid = await crypto.subtle.verify('HMAC', key, sigBytes, data);
      if (!valid) return { ok: false, reason: 'Invalid HS256 signature' };
      return { ok: true, userId: payload.sub || null };
    }

    return { ok: false, reason: 'Unsupported algorithm: ' + header.alg };
  } catch (e) {
    return { ok: false, reason: 'Token verification failed: ' + e.message };
  }
}

// ─── Auth guard ──────────────────────────────────────────────────────────────
/**
 * Check if the request is authorized.
 * Primary: Supabase JWT via Authorization: Bearer <token> (ES256 or HS256)
 * Fallback: WORKER_SECRET via X-Worker-Secret header (dev/legacy)
 * @param {Request} req - The incoming request
 * @param {Object} env - Worker environment
 * @returns {Promise<{ok: boolean, reason?: string, userId?: string}>}
 */
async function isAuthorized(req, env) {
  // Try JWT auth first — works for both ES256 (new) and HS256 (legacy)
  const authHeader = req.headers.get('Authorization') || '';
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const result = await verifyJwt(token, env);
    if (result.ok) return { ok: true, userId: result.userId };
    // Fall through to WORKER_SECRET if JWT fails
  }

  // Fallback: shared secret for dev/legacy
  if (env.WORKER_SECRET) {
    const header = req.headers.get('X-Worker-Secret') || '';
    const a = new TextEncoder().encode(header);
    const b = new TextEncoder().encode(env.WORKER_SECRET);
    if (a.length !== b.length) return { ok: false, reason: 'Authentication required' };
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    if (diff !== 0) return { ok: false, reason: 'Authentication required' };
    return { ok: true };
  }

  return { ok: false, reason: 'No authentication configured — set SUPABASE_JWT_SECRET or WORKER_SECRET' };
}

// ─── Main Handler ────────────────────────────────────────────────────────────
export default {
  async fetch(req, env) {
    const cors = corsHeaders(getAllowedOrigin(req, env));

    try {
      const url = new URL(req.url);

      // CORS preflight
      if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: cors });
      }

      // Health check — public, no auth
      if (url.pathname === '/health') {
        return json(
          {
            status: 'ok',
            version: env.WORKER_VERSION || '1.0.0',
            llm: !!env.LLM_BASE_URL,
            figma: !!env.FIGMA_TOKEN,
            brave: !!env.BRAVE_API_KEY,
            shares: !!env.SHARES,
          },
          200,
          cors
        );
      }

      // ── Route: Public config — no auth needed ──────────────────────────────
      if (url.pathname === '/config' && req.method === 'GET') {
        return json({
          supabaseUrl: env.SUPABASE_URL || '',
          supabaseAnonKey: env.SUPABASE_ANON_KEY || '',
          workerUrl: url.origin,
          authMode: env.SUPABASE_JWT_SECRET ? 'jwt' : (env.WORKER_SECRET ? 'secret' : 'none'),
        }, 200, cors);
      }

      // ── Route: Serve shared page — PUBLIC, no auth ─────────────────────────
      if (url.pathname.startsWith('/s/') && req.method === 'GET') {
        return handleServeShare(req, env, url, cors);
      }

      // Auth check on all other routes
      const auth = await isAuthorized(req, env);
      if (!auth.ok) {
        return errorJson(auth.reason, 401, cors);
      }

      // Rate limiting
      const rateLimit = await checkRateLimit(req, env, cors);
      if (!rateLimit.ok) {
        return errorJson(rateLimit.error, 429, cors);
      }

      // Body size check for POST requests
      if (req.method === 'POST') {
        const contentLength = parseInt(req.headers.get('Content-Length') || '0', 10);
        if (contentLength > MAX_BODY_SIZE) {
          return errorJson('Request body too large (max 10 MB)', 413, cors);
        }
      }

      // ── Route: LLM Proxy ───────────────────────────────────────────────────
      if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
        return handleLLM(req, env, cors);
      }

      // ── Route: Brave Search tool ───────────────────────────────────────────
      if (url.pathname === '/tool/brave-search' && req.method === 'POST') {
        return handleBraveSearch(req, env, cors);
      }

      // ── Route: Webfetch tool ───────────────────────────────────────────────
      if (url.pathname === '/tool/webfetch' && req.method === 'POST') {
        return handleWebfetch(req, env, cors);
      }

      // ── Route: Figma tool ──────────────────────────────────────────────────
      if (url.pathname.startsWith('/tool/figma') && req.method === 'POST') {
        return handleFigma(req, env, cors);
      }

      // ── Route: Share — store HTML in KV, return permanent public URL ────────
      if (url.pathname === '/share' && req.method === 'POST') {
        return handleShare(req, env, url, cors);
      }

      return errorJson('Not found', 404, cors);
    } catch (err) {
      console.error('[Worker] unhandled error:', err?.message, err?.stack);
      return json({ error: { message: 'Internal worker error' } }, 500, cors);
    }
  },
};

// ─── LLM Proxy ───────────────────────────────────────────────────────────────
async function handleLLM(req, env, cors) {
  if (!env.LLM_BASE_URL || !env.LLM_API_KEY) {
    return errorJson('LLM not configured — set LLM_BASE_URL and LLM_API_KEY secrets', 503, cors);
  }

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return errorJson('Invalid JSON body', 400, cors);
  }

  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return errorJson('messages array is required and must not be empty', 400, cors);
  }
  if (body.model && typeof body.model !== 'string') {
    return errorJson('model must be a string', 400, cors);
  }
  if (body.max_tokens !== undefined && (typeof body.max_tokens !== 'number' || body.max_tokens < 1)) {
    return errorJson('max_tokens must be a positive number', 400, cors);
  }

  const isStreaming = body.stream === true;
  const targetUrl = env.LLM_BASE_URL.replace(/\/$/, '') + '/v1/chat/completions';

  let upstream;
  try {
    upstream = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + env.LLM_API_KEY,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
  } catch (e) {
      return errorJson('LLM upstream error', 502, cors);
  }

  if (isStreaming && upstream.body) {
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        ...cors,
      },
    });
  }

  try {
    const data = await upstream.json();
    return json(data, upstream.status, cors);
  } catch (e) {
      return errorJson('LLM response parse error', 502, cors);
  }
}

// ─── SSRF Protection ────────────────────────────────────────────────────────────
/**
 * Check if a URL points to a private, internal, or metadata address.
 * @param {string} urlStr - The URL to check
 * @returns {boolean} true if the URL is private/blocked
 */
/**
 * Check if a URL points to a private, internal, or metadata address.
 * Note: This checks hostname/IP literals only. DNS rebinding attacks (where a domain
 * resolves to a private IP) are not prevented by this check alone. Cloudflare Workers
 * do not expose DNS resolution, so this is the best available mitigation.
 * @param {string} urlStr - The URL to check
 * @returns {boolean} true if the URL should be blocked
 */
function isPrivateUrl(urlStr) {
  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch {
    return true; // Invalid URL — block
  }

  // Only allow http and https schemes
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return true;
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets

  // Block localhost variants
  if (host === 'localhost' || host === '0.0.0.0' || host === '::1') {
    return true;
  }

  // Check IPv4 literals against private/reserved ranges
  const ipMatch = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipMatch) {
    const a = parseInt(ipMatch[1], 10);
    const b = parseInt(ipMatch[2], 10);
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8 (private)
    if (a === 127) return true; // 127.0.0.0/8 (loopback)
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local + cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 (private)
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 (private)
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
    if (a >= 224) return true; // 224.0.0.0/4 (multicast/reserved)
  }

  // Block IPv6 link-local / unique-local
  if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) {
    return true;
  }

  // Block known cloud metadata endpoints
  const blockedHosts = ['metadata.google.internal', 'metadata.aws.internal', '169.254.169.254'];
  if (blockedHosts.includes(host)) return true;

  return false;
}

// ─── Webfetch Tool ────────────────────────────────────────────────────────────
// Server-side fetch — no CORS restrictions, no corsproxy.io dependency
async function handleWebfetch(req, env, cors) {
  let body;
  try {
    body = await req.json();
  } catch (e) {
    return errorJson('Invalid JSON body', 400, cors);
  }

  const { url, reason } = body;

  const urlCheck = validateUrl(url);
  if (!urlCheck.ok) {
    return errorJson(urlCheck.error, 400, cors);
  }

  if (reason) {
    const reasonCheck = validateString(reason, 'reason', 500);
    if (!reasonCheck.ok) return errorJson(reasonCheck.error, 400, cors);
  }

  // SSRF check — block private/internal/metadata URLs
  if (isPrivateUrl(url)) {
    return errorJson('Blocked: URL resolves to a private, internal, or metadata address', 403, cors);
  }

  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; DesignFloor/1.0)',
        Accept: 'text/html,application/json,*/*',
      },
      signal: AbortSignal.timeout(WEBFETCH_TIMEOUT_MS),
    });

    if (!resp.ok) {
      return json({ content: `HTTP ${resp.status} fetching ${url}`, url, ok: false }, 200, cors);
    }

    const ct = resp.headers.get('content-type') || '';
    const raw = await resp.text();

    let content;
    if (ct.includes('json')) {
      content = `[webfetch: ${url}]\n` + raw.slice(0, MAX_WEBFETCH_SNIPPET);
    } else {
      content = stripHtml(raw, url, reason);
    }

    return json({ content, url, ok: true }, 200, cors);
  } catch (e) {
    return json({ content: `webfetch failed: ${e.message}`, url, ok: false }, 200, cors);
  }
}

// ─── Brave Search Tool ────────────────────────────────────────────────────────
async function handleBraveSearch(req, env, cors) {
  if (!env.BRAVE_API_KEY) {
    return errorJson('Brave Search not configured — set BRAVE_API_KEY secret', 503, cors);
  }

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return errorJson('Invalid JSON body', 400, cors);
  }

  const { query, count = 8 } = body;

  const queryCheck = validateString(query, 'query', 500);
  if (!queryCheck.ok) return errorJson(queryCheck.error, 400, cors);
  if (!query.trim()) {
    return errorJson('query is required', 400, cors);
  }

  const resultCount = Math.min(Math.max(parseInt(count, 10) || 8, 1), MAX_BRAVE_RESULTS);

  try {
    const searchUrl =
      'https://api.search.brave.com/res/v1/web/search?' +
      new URLSearchParams({ q: query, count: resultCount, search_lang: 'en' });

    const resp = await fetch(searchUrl, {
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': env.BRAVE_API_KEY,
      },
      signal: AbortSignal.timeout(BRAVE_TIMEOUT_MS),
    });

    if (!resp.ok) {
      return json({ results: [], error: `Brave API error: HTTP ${resp.status}`, query }, 200, cors);
    }

    const data = await resp.json();
    const results = (data.web?.results || []).map((r) => ({
      title: r.title,
      url: r.url,
      description: r.description,
      age: r.age,
    }));

    // Format as readable text for the LLM
    const formatted = results
      .map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.description || ''}${r.age ? ' (' + r.age + ')' : ''}`)
      .join('\n\n');

    const content = `[brave_search: "${query}"]\n\n${formatted || 'No results found.'}`;
    return json({ content, results, query, ok: true }, 200, cors);
  } catch (e) {
    return json(
      { content: `brave_search failed for "${query}": ${e.message}`, results: [], query, ok: false },
      200,
      cors
    );
  }
}

// ─── Share: Store HTML in KV ──────────────────────────────────────────────────
/**
 * Generate a random alphanumeric ID.
 * @param {number} [len=8] - Length of the ID
 * @returns {string}
 */
function generateId(len = 8) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  let id = '';
  for (let i = 0; i < len; i++) {
    id += chars[buf[i] % chars.length];
  }
  return id;
}

async function handleShare(req, env, url, cors) {
  if (!env.SHARES) {
    return errorJson('KV namespace SHARES not configured — run: wrangler kv:namespace create SHARES', 503, cors);
  }

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return errorJson('Invalid JSON body', 400, cors);
  }

  const { html, title = 'Design Floor Export', type = 'dossier' } = body;

  if (!html || typeof html !== 'string') {
    return errorJson('html field is required', 400, cors);
  }
  const titleCheck = validateString(title, 'title', 200);
  if (!titleCheck.ok) return errorJson(titleCheck.error, 400, cors);
  const typeCheck = validateString(type, 'type', 50);
  if (!typeCheck.ok) return errorJson(typeCheck.error, 400, cors);

  if (html.length > MAX_SHARE_SIZE) {
    return errorJson('HTML too large (max 10 MB)', 413, cors);
  }

  const id = generateId(8);
  const meta = { title, type, created: new Date().toISOString(), size: html.length };

  await env.SHARES.put(id, html, { metadata: meta });

  const shareUrl = `${url.origin}/s/${id}`;
  return json({ ok: true, url: shareUrl, id, meta }, 200, cors);
}

// ─── Share: Serve stored HTML publicly ────────────────────────────────────────

// Strip dangerous tags from shared HTML before serving to prevent XSS/meta-redirect attacks
/**
 * Strip dangerous tags from shared HTML before serving.
 * Removes meta refresh redirects, base tags, object/embed/applet elements.
 * @param {string} html - Raw HTML to sanitize
 * @returns {string} Sanitized HTML
 */
function sanitizeSharedHtml(html) {
  return html
    .replace(/<meta[^>]+http-equiv=["']?refresh["']?[^>]*>/gi, '')
    .replace(/<meta[^>]+http-equiv=["']?content-type["']?[^>]*>/gi, '')
    .replace(/<base[^>]*>/gi, '')
    .replace(/<object[\s\S]*?<\/object>/gi, '')
    .replace(/<embed[^>]*>/gi, '')
    .replace(/<applet[\s\S]*?<\/applet>/gi, '');
}

/**
 * Escape HTML special characters in a string for safe rendering.
 * @param {unknown} str - Value to escape (converted to string)
 * @returns {string} HTML-escaped string
 */
function escapeHtmlText(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function handleServeShare(req, env, url, _cors) {
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

  try {
    const { value: html, metadata } = await env.SHARES.getWithMetadata(id, 'text');
    if (!html) {
      return new Response(
        '<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;background:#0d0d14;color:#fff">' +
          '<h2>Link not found</h2><p>This share link does not exist or has been removed.</p>' +
          '</body></html>',
        { status: 404, headers: { 'Content-Type': 'text/html;charset=utf-8' } }
      );
    }

    // Encode title for header — raw unicode/emoji in header values throws Error 1101
    const safeTitle = encodeURIComponent((metadata?.title || '').slice(0, 100));

    // Sanitize: strip dangerous tags, then serve with strict CSP that blocks all script execution
    const safeHtml = sanitizeSharedHtml(html);

    return new Response(safeHtml, {
      status: 200,
      headers: {
        'Content-Type': 'text/html;charset=utf-8',
        'Content-Security-Policy':
          "default-src 'self' data: blob: https:; script-src 'none'; connect-src 'none'; frame-ancestors 'none'",
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Cache-Control': 'public, max-age=300',
        'X-Share-Id': id,
        'X-Share-Title': safeTitle,
      },
    });
  } catch (err) {
    const errMsg = escapeHtmlText(err?.message || 'Unknown error');
    console.error('[Worker] handleServeShare error:', err?.message);
    return new Response(
      '<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;background:#0d0d14;color:#fff">' +
        '<h2>Error loading share</h2><p>' +
        errMsg +
        '</p>' +
        '</body></html>',
      { status: 500, headers: { 'Content-Type': 'text/html;charset=utf-8' } }
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strip HTML tags and extract readable text from an HTML string.
 * @param {string} html - Raw HTML
 * @param {string} url - Source URL for the output header
 * @param {string} [reason] - Optional reason for fetching
 * @returns {string} Extracted text with URL header
 */
function stripHtml(html, url, reason) {
  // Remove script, style, nav, footer, header blocks
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<[^>]+>/g, ' ') // strip remaining tags
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, ' ') // collapse whitespace
    .trim();

  const snippet = text.slice(0, MAX_WEBFETCH_SNIPPET) + (text.length > MAX_WEBFETCH_SNIPPET ? '\n…(truncated)' : '');
  return `[webfetch: ${url}${reason ? ' | ' + reason : ''}]\n\n${snippet}`;
}

// ─── Figma Tool ───────────────────────────────────────────────────────────────

// Build the Figma Variables API payload from a flat colors array
// colors: [{name: string, r: number, g: number, b: number}]
/**
 * Build the Figma Variables API payload from a flat colors array.
 * @param {Array<{name: string, r: number, g: number, b: number}>} colors
 * @returns {Object} Figma Variables API payload
 */
function buildVariablesPayload(colors) {
  return {
    variableCollections: [
      {
        action: 'CREATE',
        id: 'coll1',
        name: 'Design Floor Tokens',
        initialModeId: 'mode1',
      },
    ],
    variableModes: [
      {
        action: 'CREATE',
        id: 'mode1',
        name: 'Default',
        variableCollectionId: 'coll1',
      },
    ],
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

async function handleFigma(req, env, cors) {
  if (!env.FIGMA_TOKEN) {
    return errorJson('Figma not configured — set FIGMA_TOKEN secret', 503, cors);
  }

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return errorJson('Invalid JSON body', 400, cors);
  }

  const { action, fileKey, nodeIds } = body;

  if (!action || typeof action !== 'string') {
    return errorJson('action is required', 400, cors);
  }
  if (fileKey) {
    const keyCheck = validateFileKey(fileKey);
    if (!keyCheck.ok) return errorJson(keyCheck.error, 400, cors);
  }

  const figmaHeaders = {
    'X-Figma-Token': env.FIGMA_TOKEN,
    'Content-Type': 'application/json',
  };

  if (action === 'push_design_spec') {
    if (!fileKey) return errorJson('fileKey is required', 400, cors);

    const comment = body.comment || '🤖 Design Floor Export';
    if (comment) {
      const cCheck = validateString(comment, 'comment', 10000);
      if (!cCheck.ok) return errorJson(cCheck.error, 400, cors);
    }
    const colors = Array.isArray(body.colors) ? body.colors : [];

    try {
      const commentResp = await fetch(`https://api.figma.com/v1/files/${fileKey}/comments`, {
        method: 'POST',
        headers: figmaHeaders,
        body: JSON.stringify({ message: comment }),
        signal: AbortSignal.timeout(FIGMA_TIMEOUT_MS),
      });
      const commentData = await commentResp.json();
      if (!commentResp.ok) {
        return json(
          {
            ok: false,
            tokenCount: 0,
            error: commentData.err || `Figma comment API: ${commentResp.status}`,
          },
          200,
          cors
        );
      }

      let tokenCount = 0;
      if (colors.length > 0) {
        try {
          const varResp = await fetch(`https://api.figma.com/v1/files/${fileKey}/variables`, {
            method: 'POST',
            headers: figmaHeaders,
            body: JSON.stringify(buildVariablesPayload(colors)),
            signal: AbortSignal.timeout(FIGMA_TIMEOUT_MS),
          });
          if (varResp.ok) tokenCount = colors.length;
        } catch (_) {}
      }

      return json({ ok: true, tokenCount, commentId: commentData.id }, 200, cors);
    } catch (e) {
        return errorJson('Figma push_design_spec error', 500, cors);
    }
  }

  try {
    let figmaUrl;
    let figmaMethod = 'GET';
    let figmaBody;

    switch (action) {
      case 'get_file':
        figmaUrl = `https://api.figma.com/v1/files/${fileKey}`;
        break;

      case 'get_nodes':
        figmaUrl = `https://api.figma.com/v1/files/${fileKey}/nodes?ids=${(nodeIds || []).join(',')}`;
        break;

      case 'get_variables':
        figmaUrl = `https://api.figma.com/v1/files/${fileKey}/variables/local`;
        break;

      case 'get_styles':
        figmaUrl = `https://api.figma.com/v1/files/${fileKey}/styles`;
        break;

      case 'get_components':
        figmaUrl = `https://api.figma.com/v1/files/${fileKey}/components`;
        break;

      case 'get_comments':
        figmaUrl = `https://api.figma.com/v1/files/${fileKey}/comments`;
        break;

      case 'post_comment':
        figmaUrl = `https://api.figma.com/v1/files/${fileKey}/comments`;
        figmaMethod = 'POST';
        figmaBody = JSON.stringify({ message: body.message, client_meta: body.client_meta });
        break;

      case 'push_variables': {
        if (!fileKey) return errorJson('fileKey is required', 400, cors);
        const colors = Array.isArray(body.colors) ? body.colors : [];
        if (!colors.length) return errorJson('colors array is required', 400, cors);
        figmaUrl = `https://api.figma.com/v1/files/${fileKey}/variables`;
        figmaMethod = 'POST';
        figmaBody = JSON.stringify(buildVariablesPayload(colors));
        break;
      }

      default:
        return errorJson(`Unknown Figma action: ${action}`, 400, cors);
    }

    const figmaResp = await fetch(figmaUrl, {
      method: figmaMethod,
      headers: figmaHeaders,
      body: figmaBody,
      signal: AbortSignal.timeout(15000),
    });

    const data = await figmaResp.json();
    return json(data, figmaResp.status, cors);
  } catch (e) {
    return errorJson('Figma API error', 500, cors);
  }
}

// ─── Exports for testing ────────────────────────────────────────────────────────
export { stripHtml, generateId, isPrivateUrl, validateString, validateUrl, validateFileKey, buildVariablesPayload, sanitizeSharedHtml, escapeHtmlText };
