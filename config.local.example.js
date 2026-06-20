// Local configuration for Design Floor Studio
// Copy this file to config.local.js and fill in your credentials
// config.local.js is gitignored and will never be committed

window.LOCAL_CONFIG = {
  // Supabase credentials (required for auth + cloud sync)
  supabase: {
    url: 'https://your-project-ref.supabase.co',
    anonKey: 'your-anon-key-here'
  },

  // Cloudflare Worker URL (required — handles LLM calls server-side)
  workerUrl: 'https://your-worker.your-subdomain.workers.dev',
  workerSecret: 'your-worker-secret-here'
};
