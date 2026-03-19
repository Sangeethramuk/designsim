// Design Swarm Studio — LLM Proxy Edge Function
// Forwards chat completions to your LLM provider using server-side secrets.
// Deploy: Supabase Dashboard → Edge Functions → New Function → paste this code
// Secrets: Dashboard → Settings → Edge Function Secrets
//   LLM_BASE_URL  = e.g. https://api.moonshot.ai
//   LLM_API_KEY   = your API key

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

Deno.serve(async (req) => {
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
    const { model, messages, max_tokens } = await req.json()

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
      body: JSON.stringify({ model, messages, max_tokens }),
    })

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
