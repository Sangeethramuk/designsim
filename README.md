# Design Floor

AI design studio with 14 specialized agents in a pixel-art world. Walk around, chat with agents, relay artifacts between them, and export a project dossier.

## Architecture

```
designsim/
├── index.html              # Landing page (Google sign-in)
├── pixel-world.html        # Main studio (Phaser.js game + chat UI)
├── config.local.example.js # Config template — copy to config.local.js
├── package.json            # Vite + Vitest + ESLint + Prettier
├── vite.config.js          # Multi-page Vite config
├── eslint.config.js        # Flat config ESLint
├── .prettierrc             # Prettier config
├── vercel.json             # Vercel hosting config
├── src/
│   └── styles/
│       └── pixel-world.css # Studio styles (Vite bundled)
├── public/
│   ├── js/
│   │   └── pixel-world.js  # All game + chat + swarm logic (7,100+ lines)
│   ├── demo-dossier.html   # Example exported dossier
│   └── medconnect-prototype.html  # Example exported prototype
├── tests/
│   ├── worker.unit.test.js       # 38 unit tests
│   ├── worker.integration.test.js # 19 integration tests
│   └── studio.e2e.test.js        # 8 E2E tests
├── worker/                 # Cloudflare Worker (LLM proxy + tools)
│   ├── src/index.js        #   Main worker code (870+ lines)
│   ├── wrangler.toml       #   Worker config
│   └── package.json
└── supabase/
    ├── functions/llm-proxy/  # DEPRECATED — use Cloudflare Worker instead
    └── sprint-analytics.sql  # SQL schema for sprint analytics
```

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Cloudflare account](https://dash.cloudflare.com/) (for Worker)
- [Supabase account](https://supabase.com/) (for auth + cloud sync)
- [Vercel account](https://vercel.com/) (for hosting, optional)

## Setup

### 1. Clone and configure

```bash
git clone https://github.com/Sangeethramuk/designsim.git
cd designsim
cp config.local.example.js config.local.js
```

Edit `config.local.js` and fill in your credentials:

```js
window.LOCAL_CONFIG = {
  supabase: {
    url: 'https://your-project-ref.supabase.co',
    anonKey: 'your-anon-key-here'
  },
  workerUrl: 'https://your-worker.your-subdomain.workers.dev',
  workerSecret: 'your-worker-secret-here'
};
```

### 2. Deploy the Cloudflare Worker

The Worker handles LLM calls server-side (API keys never exposed to the browser), plus webfetch, Brave Search, Figma API, and share links.

```bash
cd worker
npm install

# Set required secrets
npx wrangler secret put LLM_BASE_URL     # e.g. https://api.moonshot.ai
npx wrangler secret put LLM_API_KEY      # your LLM provider API key
npx wrangler secret put WORKER_SECRET     # required passphrase for auth

# Optional secrets
npx wrangler secret put FIGMA_TOKEN       # Figma personal access token
npx wrangler secret put BRAVE_API_KEY     # Brave Search API key

# Set allowed CORS origins in wrangler.toml [vars]:
# ALLOWED_ORIGINS = "https://yourapp.com,https://www.yourapp.com"

npx wrangler deploy
```

### 3. Set up Supabase

1. Create a new Supabase project
2. Enable Google OAuth in Authentication > Providers
3. Run the SQL schema:
   - Go to SQL Editor
   - Paste contents of `supabase/sprint-analytics.sql`
   - Run

### 4. Deploy to Vercel

```bash
npm install -g vercel
vercel
```

Or connect the GitHub repo to Vercel for auto-deploy.

## Environment Variables

### Cloudflare Worker Secrets

| Secret | Required | Description |
|--------|----------|-------------|
| `LLM_BASE_URL` | Yes | LLM API base URL (e.g. `https://api.moonshot.ai`) |
| `LLM_API_KEY` | Yes | LLM provider API key |
| `WORKER_SECRET` | Yes | Passphrase for auth (sent via `X-Worker-Secret` header) |
| `FIGMA_TOKEN` | No | Figma personal access token |
| `BRAVE_API_KEY` | No | Brave Search API key |

### Cloudflare Worker Vars

| Var | Required | Description |
|-----|----------|-------------|
| `ALLOWED_ORIGINS` | Yes | Comma-separated CORS origins (e.g. `https://yourapp.com`) |

### Client Config (`config.local.js`)

| Field | Required | Description |
|-------|----------|-------------|
| `supabase.url` | Yes | Supabase project URL |
| `supabase.anonKey` | Yes | Supabase anon/public key |
| `workerUrl` | Yes | Cloudflare Worker URL |
| `workerSecret` | Yes | Worker passphrase (matches `WORKER_SECRET`) |

## The 14 Agents

| Zone | Agent | Role |
|------|-------|------|
| Research Library | Scout | Research |
| | Scholar | Best Practices |
| Design Studio | Palette | UI Variations |
| | Flow | UX Flows |
| | Blueprint | Figma Specs |
| | Forge | Code Gen |
| Critique Room | Lens | UX Critique |
| | Eye | Aesthetics |
| | Mirror | Persona |
| Synthesis Hub | Council | Review |
| | Weaver | Synthesizer |
| | Gate | Quality |
| | Check | Checklist |
| Corridor | Director | Team Lead |

## Security

- LLM API keys are stored as Cloudflare Worker secrets — never exposed to the browser
- `WORKER_SECRET` is required on all non-public Worker routes
- CORS is restricted to configured origins via `ALLOWED_ORIGINS`
- SSRF protection blocks private/internal IPs on webfetch
- Shared HTML is served with strict CSP (`script-src 'none'`)
- Supabase RLS policies protect all user data

## Development

```bash
# Install dependencies
npm install

# Start Vite dev server (port 5173)
npm run dev

# Build for production (outputs to dist/)
npm run build

# Preview production build
npm run preview

# Run tests (65 tests — unit + integration + E2E)
npm test

# Lint
npm run lint
```

Visit `http://localhost:5173` for the landing page or `http://localhost:5173/pixel-world.html` for the studio.

On localhost, the studio runs without auth for development.

## License

Private project.
