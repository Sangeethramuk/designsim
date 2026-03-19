// Local configuration for Design Swarm Studio
// Copy this file to config.local.js and fill in your credentials
// config.local.js is gitignored and will never be committed

window.LOCAL_CONFIG = {
  // LLM credentials (optional — set via ⚙ settings in-game)
  baseUrl: 'https://your-llm-api.com',  // e.g., https://api.openai.com
  apiKey: 'your-api-key-here',          // e.g., sk-...

  // Supabase credentials (optional — enables cloud sync)
  supabase: {
    url: 'https://your-project-ref.supabase.co',
    anonKey: 'your-anon-key-here'
  }
};

// NOTE: Credentials in localStorage take precedence over values here.
// Use the ⚙ settings button in the game to update credentials at runtime.
