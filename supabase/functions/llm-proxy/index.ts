// Design Floor Studio — LLM Proxy Edge Function (DEPRECATED)
//
// ⚠️  DEPRECATED — Do not use for new deployments.
//     The Cloudflare Worker (worker/src/index.js) is now the canonical LLM proxy.
//     This file is kept for backward compatibility only.
//
// To migrate:
//   1. Deploy the Cloudflare Worker (see worker/wrangler.toml)
//   2. Set secrets: wrangler secret put LLM_BASE_URL, LLM_API_KEY, WORKER_SECRET
//   3. Update your client to use the Worker URL instead of the Supabase Edge Function
//   4. Delete this file once migration is complete
//
// Forwards chat completions to your LLM provider using server-side secrets.
// Supports both streaming (SSE, stream:true) and non-streaming JSON responses.
// Deploy: Supabase Dashboard → Edge Functions → New Function → paste this code
// Secrets: Dashboard → Settings → Edge Function Secrets
//   LLM_BASE_URL   = e.g. https://api.moonshot.ai
//   LLM_API_KEY    = your API key
//   ALLOWED_ORIGINS = comma-separated allowed CORS origins (e.g. "https://yourapp.com")

function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') || ''
  const allowed = (Deno.env.get('ALLOWED_ORIGINS') || '').split(',').map(s => s.trim()).filter(Boolean)
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }
  if (allowed.length > 0 && (allowed.includes(origin) || allowed.includes('*'))) {
    headers['Access-Control-Allow-Origin'] = origin
    headers['Vary'] = 'Origin'
  }
  return headers
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req)

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: { message: 'Method not allowed' } }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  try {
    const { model, messages, max_tokens, stream } = await req.json()

    const llmBaseUrl = Deno.env.get('LLM_BASE_URL')?.replace(/\/$/, '')
    const llmApiKey  = Deno.env.get('LLM_API_KEY')

    if (!llmBaseUrl || !llmApiKey) {
      return new Response(
        JSON.stringify({ error: { message: 'LLM not configured on server. Set LLM_BASE_URL and LLM_API_KEY secrets in Supabase.' } }),
        { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const upstream = await fetch(`${llmBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${llmApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, messages, max_tokens, stream: !!stream }),
    })

    if (stream) {
      // Pipe the SSE stream directly to the client — no buffering
      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          ...corsHeaders,
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'X-Accel-Buffering': 'no',
        },
      })
    }

    // Non-streaming: return JSON as before
    const data = await upstream.json()

    return new Response(JSON.stringify(data), {
      status: upstream.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (e) {
    return new Response(
      JSON.stringify({ error: { message: e.message ?? 'Internal error' } }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
