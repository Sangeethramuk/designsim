#!/usr/bin/env node
/**
 * Headless Pipeline Test — runs the full sprint without a browser.
 *
 * Usage:
 *   node tests/pipeline-headless.mjs "your brief here"
 *   node tests/pipeline-headless.mjs "create simple to-do list app" --verbose
 *   node tests/pipeline-headless.mjs "create simple to-do list app" --output-dir ./sprint-output
 *
 * Outputs:
 *   - Console: live progress + summary
 *   - Files in output dir (default: ./sprint-output/):
 *     - trace.txt          (full execution trace, same format as Copy Trace button)
 *     - dossier.html       (full design dossier)
 *     - prototype.html     (generated HTML prototype)
 *     - agents/<id>.md     (per-agent raw + sanitized output)
 */

import fs from 'fs';
import path from 'path';

// ── Config ────────────────────────────────────────────────────────────────
const CONFIG_PATH = path.resolve(process.cwd(), 'config.local.js');
const configRaw = fs.readFileSync(CONFIG_PATH, 'utf-8');
const configMatch = configRaw.match(/workerUrl:\s*['"]([^'"]+)['"]/);
const secretMatch = configRaw.match(/workerSecret:\s*['"]([^'"]*)['"]/);
const WORKER_URL = configMatch ? configMatch[1].replace(/\/$/, '') : null;
const WORKER_SECRET = secretMatch ? secretMatch[1] : '';

// Extract Supabase config
const sbUrlMatch = configRaw.match(/url:\s*['"]([^'"]+)['"]/);
const sbKeyMatch = configRaw.match(/anonKey:\s*['"]([^'"]+)['"]/);
const SUPABASE_URL = sbUrlMatch ? sbUrlMatch[1] : null;
const SUPABASE_ANON_KEY = sbKeyMatch ? sbKeyMatch[1] : null;

let AUTH_TOKEN = null;

if (!WORKER_URL) {
  console.error('ERROR: No workerUrl found in config.local.js');
  process.exit(1);
}

const VERBOSE = process.argv.includes('--verbose') || process.argv.includes('-v');
const outputDirIdx = process.argv.indexOf('--output-dir');
const OUTPUT_DIR = outputDirIdx >= 0 ? process.argv[outputDirIdx + 1] : './sprint-output';
const BRIEF = process.argv.find(a => !a.startsWith('-') && !a.endsWith('pipeline-headless.mjs') && a !== process.argv[0]);

if (!BRIEF) {
  console.error('Usage: node tests/pipeline-headless.mjs "your brief here" [--verbose] [--output-dir ./dir]');
  process.exit(1);
}

console.log(`\n{'='.repeat(80)}`);
console.log(`  HEADLESS PIPELINE TEST`);
console.log(`  Brief: "${BRIEF}"`);
console.log(`  Worker: ${WORKER_URL}`);
console.log(`  Output: ${OUTPUT_DIR}/`);
console.log(`{'='.repeat(80)}\n`);

// ── Agent definitions (extracted from pixel-world.js) ─────────────────────
const AGENTS = [
  {id:'scout',name:'Researcher',role:'Competitive Research',
   brain:'glm-latest',tools:['webfetch','brave_search'],
   systemPrompt:'You are the Researcher, a sharp competitive intelligence analyst. Your job: find how real products have solved this exact problem — and extract what is worth stealing.\n\nResearch protocol (execute every time, in this order):\n1. Use brave_search to find "[domain] [primary task] app UX", "[domain] competitor [feature] design", and "[top competitor] app reviews complaints" — get current results, not memory.\n2. Use webfetch to visit the 2–3 most relevant URLs and read actual product pages, app store listings, or review threads.\n3. For each product: describe the specific pattern — layout logic, navigation structure, key interaction — based on what you read. No fabrication.\n4. Search for anti-patterns: "[app name] UX problems", "[domain] app bad reviews" — what do real users complain about?\n5. Extract a steal list of 5–7 specific, actionable tactics to adapt (not copy) for this brief.\n\nDomain lens: apply the emotional constraints of this domain.\n\nGrounding rule: if you cannot verify a pattern from a URL you actually fetched, mark it as "[unverified — from description only]". Speculation without a source is not research — it is noise.'},
  {id:'scholar',name:'Strategist',role:'Best Practices Research',
   brain:'glm-latest',tools:['webfetch','brave_search'],
   systemPrompt:'You are the Strategist, a design standards researcher. You find the specific rule — not the general principle. Paraphrasing a standard introduces errors. Always fetch and quote verbatim.\n\nResearch protocol (execute every time):\n1. Use brave_search to find the exact criterion.\n2. Use webfetch to fetch the authoritative source URL and extract the verbatim rule text, criterion number, and success level.\n3. Cross-reference platform guidelines — M3 vs Apple HIG.\n4. For regulated domains: search for domain-specific compliance requirements.\n\nCite format for every rule: Standard → Version → Criterion/Section → Verbatim text → URL → Applies because [reason specific to this brief].'},
  {id:'palette',name:'Visual Designer',role:'UI Variations Generator',
   brain:'glm-latest',tools:[],
   systemPrompt:'You are the Visual Designer, a visual systems designer with strong opinions. You make design decisions — not design suggestions.\n\nBefore presenting any colour: run the contrast math. L = 0.2126R + 0.7152G + 0.0722B (linearise first). Ratio = (L1+0.05)/(L2+0.05). Normal text ≥4.5:1, large text ≥3:1, UI components ≥3:1. If it fails, fix it before presenting.\n\nEach of the 5 variations is a complete design position — a creative direction, not a colour swatch. Name it like a creative director would:\n  1. Information Architecture — density-first\n  2. Calm Confidence — white space as structural element\n  3. Bold Brand — one dominant colour\n  4. Accessible First — WCAG AAA target\n  5. Domain-Tuned — the emotional register of THIS domain\n\nFor each variation: state the target user, the layout logic, the type of user it will delight and who it will alienate.'},
  {id:'flow',name:'UX Designer',role:'UX Flow Architect',
   brain:'glm-latest',tools:[],
   systemPrompt:'You are the UX Designer, a UX architect who designs failure states before success states.\n\nApply UX laws with specificity, embedded in decisions — not listed:\n- Fitts\'s Law → name the specific element in the wrong touch zone\n- Hick\'s Law → count choices at every decision point\n- Goal-Gradient Effect → show progress indicators only when ≥30% through\n- Peak-End Rule → design one moment of genuine delight at completion\n- Progressive Disclosure → state which information is hidden\n- Error Prevention → for each user input, name the most likely mistake and prevention mechanism\n\nFor EVERY screen in the flow, all 5 states are mandatory — no exceptions:\n  empty | loading | success | error | offline/timeout\n\nOutput a Mermaid stateDiagram-v2 for the primary flow. Annotate each transition with the UX law it satisfies. Flag every dead-end as a critical issue.'},
  {id:'blueprint',name:'Spec Writer',role:'Figma Specs Generator',
   brain:'glm-latest',tools:[],
   systemPrompt:'You are the Spec Writer, a design specification writer. Your YAML is the handoff document.\n\nNon-negotiable rules:\n1. Token names only — never raw values. Format: --[category]-[scale]-[step]\n2. All spacing and border-radius values must be multiples of 4px.\n3. Every component: 5 variants (default / hover / active / disabled / error).\n4. Every container: explicit Auto Layout.\n5. Every component: interaction spec — trigger → state → animation (ms + easing).\n6. One YAML block per component.\n\nBuild strictly from prior agent outputs: Colour tokens from Palette, components from Flow.'},
  {id:'lens',name:'UX Critic',role:'UX Critique Agent',
   brain:'glm-latest',tools:[],
   systemPrompt:'You are the UX Critic, a UX heuristics evaluator. You evaluate ALL 10 Nielsen heuristics against the actual design described in prior agent outputs.\n\nFor every violation: cite the exact screen name or component from prior outputs.\nSeverity: 1=Cosmetic 2=Minor 3=Major 4=Catastrophic (BLOCKING)\nSort findings by severity descending.'},
  {id:'eye',name:'Art Director',role:'UI Aesthetics Critic',
   brain:'glm-latest',tools:[],
   systemPrompt:'You are the Art Director, a visual design auditor. You calculate — you never estimate.\n\nContrast calculation (required for every text/background pair):\nLinearise each channel: if c ≤ 0.04045 → c/12.92, else ((c+0.055)/1.055)^2.4\nL = 0.2126×R + 0.7152×G + 0.0722×B\nRatio = (L_lighter + 0.05) / (L_darker + 0.05)\nFor every FAIL: provide the exact ratio, the element name, and the specific replacement hex.'},
  {id:'weaver',name:'Design Lead',role:'Design Synthesizer',
   brain:'glm-latest',tools:[],
   systemPrompt:'You are the Design Lead, the design synthesizer. Your output is the handoff document.\n\nProcess:\n1. Inventory: one-line summary per agent.\n2. Conflict map: every contradiction between agents must be resolved with a decision and a reason.\n3. Final specification: design principles, colour system with verified contrast, typography, components, flow decisions, persona accommodations.\n4. Deferred to v2: what is explicitly out of scope and why.\n\nCite source agent for every significant decision.'},
  {id:'lead',name:'Director',role:'Team Lead',
   brain:'glm-latest',tools:[],
   systemPrompt:'You are the Director of the Design Floor — 14 AI agents, one design sprint, your call.\n\nCOORDINATION MODE: Read ALL agent outputs in your context. Identify what is missing, what conflicts, what is exceptional. When agents disagree, name the conflict and propose a resolution.\n\nDirector\'s Brief: What is being built, 5 defining decisions, must not be compromised, deferred to v2, first engineering ticket.'},
];

const AGENT_TEMPERATURE = {
  scout:0.4,scholar:0.3,
  palette:0.85,flow:0.75,blueprint:0.4,forge:0.5,
  lens:0.3,eye:0.2,mirror:0.7,
  council:0.5,weaver:0.5,gate:0.2,check:0.2,
  lead:0.5
};

const AGENT_MAX_TOKENS = {
  scout:2000,scholar:2000,
  palette:3000,flow:3000,blueprint:4000,forge:4000,
  lens:2500,eye:2500,mirror:2500,
  council:3000,weaver:4000,gate:3000,check:3000,
  lead:6000
};

// ── Sanitizer (copied from pixel-world.js) ────────────────────────────────
function sanitizeSwarmResponse(text) {
  if (!text) return text;
  text = text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '').trim();
  text = text.replace(/<function_calls>[\s\S]*?<\/function_calls>/gi, '').trim();
  text = text.replace(/<\|[\w_]+\|>[\s\S]*?<\|[\w_]+\|>/g, '').trim();
  text = text.replace(/<\|[\w_]+\|>/g, '').trim();
  text = text.replace(/<[a-z_]+\s*\/>/gi, '').trim();

  const startsWithHeading = /^#{1,4} [A-Z]/.test(text);
  if (startsWithHeading) {
    // clean
  } else {
    const headingMatch = text.match(/\n#{1,4} [A-Z]/);
    if (headingMatch && headingMatch.index > 0) {
      const prefix = text.slice(0, headingMatch.index).trim();
      if (prefix.length > 20) {
        text = text.slice(headingMatch.index + 1).trim();
      }
    } else {
      const thinkingPatterns = /^(Let me |The user (wants|is asking|is telling) me to|Looking at (the |prior |my )|I need to |First, I (need|should|will)|I should |Hmm,|Okay, so|Wait,|Actually,|So essentially|Now (I|let me)|Based on (what|the|this)|Alright,|Right,|I can see|I see that|Looking carefully)/im;
      if (thinkingPatterns.test(text.slice(0, 400))) {
        return '[Agent produced no usable output after sanitization]';
      }
    }
  }
  return text || '[Agent produced no usable output after sanitization]';
}

// ── Auth: get Supabase JWT ────────────────────────────────────────────────
// Check for --secret flag
const secretIdx = process.argv.indexOf('--secret');
const CLI_SECRET = secretIdx >= 0 ? process.argv[secretIdx + 1] : '';

async function getAuthToken() {
  // Priority: --secret flag > config workerSecret > Supabase JWT
  const secret = CLI_SECRET || WORKER_SECRET;
  if (secret) {
    if (VERBOSE) console.log(`[Auth] Using X-Worker-Secret`);
    return { 'X-Worker-Secret': secret };
  }
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return {};

  // Try anonymous signup
  try {
    const resp = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
      method: 'POST',
      headers: { 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(10000),
    });
    const data = await resp.json();
    if (data.access_token) {
      if (VERBOSE) console.log(`[Auth] Got anonymous session JWT`);
      return { 'Authorization': `Bearer ${data.access_token}` };
    }
  } catch (e) {
    if (VERBOSE) console.log(`[Auth] Anonymous signup failed: ${e.message}`);
  }

  return {};
}

// ── LLM call via Worker ──────────────────────────────────────────────────
async function callLLM(agent, userMessage, history = []) {
  const { model, messages, maxTokens, temperature } = buildMessages(agent, userMessage, history);
  const allMessages = [...messages];
  const tools = (agent.tools || []).length > 0 ? agent.tools.map(t => TOOL_DEFS[t]).filter(Boolean) : null;
  const maxRounds = tools ? 5 : 1;

  for (let round = 0; round < maxRounds; round++) {
    const body = { model, max_tokens: maxTokens, temperature, messages: allMessages };
    if (tools && round < maxRounds - 1) body.tools = tools;
    else if (tools) {
      allMessages.push({ role: 'user', content: 'You have completed your research. Produce your final output now based on everything you have gathered. Do not make any more tool calls.' });
    }

    const headers = { 'Content-Type': 'application/json', ...AUTH_TOKEN };

    const resp = await fetch(`${WORKER_URL}/v1/chat/completions`, {
      method: 'POST', headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000)
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => 'Unknown error');
      throw new Error(`HTTP ${resp.status}: ${errText.slice(0, 200)}`);
    }

    const data = await resp.json();
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));

    const choice = data.choices?.[0];
    if (!choice) throw new Error('No response from LLM');

    const toolCalls = choice.message?.tool_calls;
    if (!toolCalls || !toolCalls.length || round === maxRounds - 1) {
      const content = choice.message?.content || choice.message?.reasoning_content || 'No response.';
      return content;
    }

    // Execute tool calls
    allMessages.push(choice.message);
    for (const tc of toolCalls) {
      let args; try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { args = {}; }
      if (VERBOSE) console.log(`    [Tool] ${tc.function?.name}(${JSON.stringify(args).slice(0, 80)})`);
      const result = await executeTool(tc.function?.name || '', args);
      allMessages.push({ role: 'tool', tool_call_id: tc.id, content: String(result) });
    }
  }

  // Final call without tools
  const finalBody = { model, max_tokens: maxTokens, temperature, messages: [...allMessages, { role: 'user', content: 'Produce your final output now. No more tool calls.' }] };
  const headers = { 'Content-Type': 'application/json', ...AUTH_TOKEN };
  if (WORKER_SECRET) headers['X-Worker-Secret'] = WORKER_SECRET;
  const finalResp = await fetch(`${WORKER_URL}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify(finalBody) });
  const finalData = await finalResp.json();
  return finalData.choices?.[0]?.message?.content || finalData.choices?.[0]?.message?.reasoning_content || 'No response after tool calls.';
}

// ── Tool definitions ─────────────────────────────────────────────────────
const TOOL_DEFS = {
  webfetch: { type:'function',function:{name:'webfetch',description:'Fetch and read content from any public URL.',parameters:{type:'object',properties:{url:{type:'string',description:'The URL to fetch'},reason:{type:'string',description:'Why this URL is relevant'}},required:['url']}}},
  brave_search: { type:'function',function:{name:'brave_search',description:'Search the web using Brave Search.',parameters:{type:'object',properties:{query:{type:'string',description:'Search query'},count:{type:'number',description:'Number of results (default 8)'}},required:['query']}}},
};

async function executeTool(name, args) {
  if (name === 'webfetch') {
    return await executeWebfetch(args.url || '', args.reason || '');
  }
  if (name === 'brave_search') {
    return await executeBraveSearch(args.query || '', args.count || 8);
  }
  return `Tool "${name}" is not available.`;
}

async function executeWebfetch(url, reason) {
  if (VERBOSE) console.log(`    [webfetch] ${url}`);
  try {
    const headers = { 'Content-Type': 'application/json', ...AUTH_TOKEN };
    if (WORKER_SECRET) headers['X-Worker-Secret'] = WORKER_SECRET;
    const resp = await fetch(`${WORKER_URL}/tool/webfetch`, {
      method: 'POST', headers,
      body: JSON.stringify({ url, reason }),
      signal: AbortSignal.timeout(15000)
    });
    const data = await resp.json();
    return data.content || data.error?.message || 'No content returned';
  } catch (e) {
    return `webfetch failed for ${url}: ${e.message}`;
  }
}

async function executeBraveSearch(query, count) {
  if (VERBOSE) console.log(`    [brave_search] "${query}"`);
  try {
    const headers = { 'Content-Type': 'application/json', ...AUTH_TOKEN };
    if (WORKER_SECRET) headers['X-Worker-Secret'] = WORKER_SECRET;
    const resp = await fetch(`${WORKER_URL}/tool/brave-search`, {
      method: 'POST', headers,
      body: JSON.stringify({ query, count: count || 8 }),
      signal: AbortSignal.timeout(12000)
    });
    const data = await resp.json();
    return data.content || 'No search results returned';
  } catch (e) {
    return `brave_search failed for "${query}": ${e.message}`;
  }
}

// ── Build messages (simplified from pixel-world.js) ──────────────────────
function buildMessages(agent, userMessage, history) {
  let sys = agent.systemPrompt + '\n\nBe direct, specific, and expert. Cite prior agent outputs by name when building on them.';
  sys += '\n\n## Active Project Brief\n' + BRIEF + '\nAll outputs must serve this brief specifically.';
  sys += '\n\n## SWARM MODE — BATCH GENERATION RULES (NON-NEGOTIABLE)\n';
  sys += '1. START YOUR RESPONSE WITH THE ACTUAL ARTIFACT. Your very first character must be a markdown heading (##). Do not write "Let me", "I need to", "Looking at", or ANY meta-commentary.\n';
  sys += '2. If prior agent outputs are missing or empty, note it in ONE line, then proceed with your best work.\n';
  sys += '3. End your output cleanly at a logical section boundary.\n';

  const maxTokens = AGENT_MAX_TOKENS[agent.id] || 800;
  const temperature = AGENT_TEMPERATURE[agent.id] ?? 0.5;
  const model = (agent.brain || 'glm-latest').replace('litellm/', '');

  return {
    model, maxTokens, temperature,
    messages: [{ role: 'system', content: sys }, ...history, { role: 'user', content: userMessage }],
  };
}

// ── Context collection (simplified) ──────────────────────────────────────
function collectContext(completedIds, agentOutputs, recentIds = []) {
  const parts = [];
  const thinkingPatterns = /^(The user (wants|is asking|is telling) me to|Looking at (the |prior |my )|I need to |Let me |First, I |I should |Hmm,|Okay, so|Wait,|Actually,|So essentially|Now (I|let me)|Based on (what|the|this)|Alright,|Right,)/im;

  for (const id of completedIds) {
    const agent = AGENTS.find(a => a.id === id);
    if (!agent) continue;
    const content = agentOutputs[id];
    if (!content || content === '[Agent produced no usable output after sanitization]') continue;
    if (content === 'No response after tool calls.' || content === 'No response.') continue;
    if (thinkingPatterns.test(content.slice(0, 400))) continue;

    const maxLen = recentIds.includes(id) ? 1800 : 700;
    parts.push(`[${id}]\n### ${agent.name} (${agent.role})\n${content.slice(0, maxLen)}`);
  }

  return parts.length
    ? '## Prior Wave Outputs — cite these by agent name when building on them\n\n' + parts.join('\n\n---\n\n')
    : null;
}

// ── Sprint execution ─────────────────────────────────────────────────────
const HARDCODED_WAVES = [
  { name: 'Research', agents: ['scout', 'scholar'], prompt: 'Conduct deep specialist research for this brief.' },
  { name: 'Design', agents: ['palette', 'flow'], prompt: 'Read the research findings in your context. Design outputs must be grounded in those findings.' },
  { name: 'Critique', agents: ['lens', 'eye'], prompt: 'Read ALL prior wave outputs. Perform a rigorous critique.' },
  { name: 'Synthesis', agents: ['weaver'], prompt: 'Read ALL prior outputs. Synthesize into a final handoff document.' },
];

async function runDirectorPlan(brief) {
  const lead = AGENTS.find(a => a.id === 'lead');
  const knownIds = AGENTS.map(a => a.id).filter(id => id !== 'lead');
  const planningPrompt =
    'PROJECT BRIEF:\n"' + brief + '"\n\n' +
    'You are the Director. Analyse this brief and plan the OPTIMAL sprint.\n\n' +
    'Available specialists:\n' +
    AGENTS.filter(a => a.id !== 'lead').map(a => `  ${a.id} — ${a.name} (${a.role})`).join('\n') + '\n\n' +
    'COMPLEXITY CALIBRATION:\n' +
    '  Simple brief: 4-6 agents, 3 waves max\n' +
    '  Medium brief: 8-10 agents, 4-5 waves\n' +
    '  Complex brief: all agents, 6 waves\n\n' +
    'Return ONLY valid JSON:\n' +
    '{"rationale":"1-2 sentences","waves":[{"name":"Wave Name","agents":["agent-id"],"prompt":"specific task prompt"}]}\n\n' +
    'Rules:\n' +
    '- CRITICAL: Do not infer domain, language, location, or demographics unless the brief explicitly states them.\n' +
    '- Critique agents (lens, eye) must be in a SEPARATE LATER wave from design agents.\n' +
    '- mirror must NOT be in Wave 1.\n' +
    '- Synthesis agents (weaver) must come after critique.\n' +
    '- Always end with at least one synthesis agent.\n' +
    '- Do not include lead/director in waves.';

  try {
    const resp = await callLLM(lead, planningPrompt, []);
    const clean = resp.replace(/```(?:json)?\s*/g, '').replace(/```/g, '');
    const m = clean.match(/\{[\s\S]*\}/);
    if (!m) { console.warn('[Director] No JSON found, using hardcoded plan'); return null; }
    const plan = JSON.parse(m[0]);
    if (!Array.isArray(plan.waves) || !plan.waves.length) return null;

    // Validate
    plan.waves = plan.waves
      .map(w => ({ ...w, agents: (w.agents || []).filter(id => knownIds.includes(id)) }))
      .filter(w => w.agents && w.agents.length > 0);

    if (!plan.waves.length) return null;
    console.log(`[Director] Plan: ${plan.waves.length} waves, ${plan.waves.reduce((s, w) => s + w.agents.length, 0)} agents`);
    console.log(`[Director] Rationale: ${plan.rationale}`);
    return plan;
  } catch (e) {
    console.warn('[Director] Planning failed:', e.message, '— using hardcoded plan');
    return null;
  }
}

async function runAgent(agent, userMessage, priorContext) {
  const history = priorContext ? [{ role: 'system', content: priorContext }] : [];
  const start = Date.now();

  if (VERBOSE) console.log(`  [${agent.name}] Starting...`);

  let raw;
  try {
    raw = await callLLM(agent, userMessage, history);
  } catch (e) {
    console.error(`  [${agent.name}] ERROR: ${e.message}`);
    return { raw: '', sanitized: '', error: e.message, durationMs: Date.now() - start };
  }

  const sanitized = sanitizeSwarmResponse(raw);
  const duration = Date.now() - start;
  const isThinking = /^\[Agent produced/.test(sanitized);
  const hasHeading = /^#{1,4} [A-Z]/.test(sanitized.trimStart());

  console.log(`  [${agent.name}] ${(duration / 1000).toFixed(1)}s — ${sanitized.length} chars ${hasHeading ? '✓' : '✗ no heading'}${isThinking ? ' (thinking trace filtered)' : ''}`);

  return { raw, sanitized, durationMs: duration, hasHeading };
}

async function runSprint() {
  const startTime = Date.now();
  const agentOutputs = {};
  const trace = { agents: {}, waves: [], startedAt: startTime, finishedAt: null };

  // Director planning
  console.log('\n📋 Director planning...');
  const plan = await runDirectorPlan(BRIEF);
  const waves = plan ? plan.waves : HARDCODED_WAVES;
  trace.planSource = plan ? 'director' : 'hardcoded';
  trace.wavePlan = plan;

  // Execute waves
  const completedIds = [];
  for (let waveIdx = 0; waveIdx < waves.length; waveIdx++) {
    const wave = waves[waveIdx];
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Wave ${waveIdx + 1}/${waves.length}: ${wave.name} — [${wave.agents.join(', ')}]`);
    console.log('─'.repeat(60));

    // Inject prior context
    let priorContext = null;
    if (completedIds.length) {
      const prevWaveAgents = waveIdx > 0 ? waves[waveIdx - 1].agents : [];
      priorContext = collectContext(completedIds, agentOutputs, prevWaveAgents);
    }

    const wavePrompt = (wave.prompt || '') + '\n\nYour specific focus: apply your role as specialist. Do not duplicate what colleagues in this wave will cover.';
    const waveResults = [];

    // Run agents sequentially (simpler than parallel for CLI)
    for (const agentId of wave.agents) {
      const agent = AGENTS.find(a => a.id === agentId);
      if (!agent) continue;

      const result = await runAgent(agent, wavePrompt, priorContext);
      agentOutputs[agentId] = result.sanitized;
      trace.agents[agentId] = {
        name: agent.name,
        role: agent.role,
        waveIndex: waveIdx,
        waveName: wave.name,
        duration: result.durationMs,
        hasHeading: result.hasHeading,
        isThinking: result.raw && /^\[Agent produced/.test(result.sanitized),
        error: result.error || null,
        outputLength: result.sanitized.length,
        rawLength: result.raw ? result.raw.length : 0,
      };
      waveResults.push({ agentId, result });
    }

    trace.waves.push({ index: waveIdx, name: wave.name, agents: wave.agents, results: waveResults.map(r => ({ agentId: r.agentId, duration: r.result.durationMs, hasHeading: r.result.hasHeading })) });
    completedIds.push(...wave.agents);
  }

  // Director summary
  console.log(`\n${'─'.repeat(60)}`);
  console.log('Director: Final summary...');
  const lead = AGENTS.find(a => a.id === 'lead');
  const allCtx = collectContext(completedIds, agentOutputs);
  const summaryPrompt =
    'The design sprint is complete. Produce a Director\'s Brief:\n' +
    '1. What is being built — one sentence\n' +
    '2. Sprint summary — one line per wave\n' +
    '3. Top 5 design decisions\n' +
    '4. Must not be compromised\n' +
    '5. Deferred to v2\n' +
    '6. Next actions\n\n' +
    'CRITICAL: Only report agents as having produced output if their output is in your context. Do NOT fabricate outputs.';
  const leadResult = await runAgent(lead, summaryPrompt, allCtx);
  agentOutputs['lead'] = leadResult.sanitized;
  trace.agents['lead'] = {
    name: lead.name, role: lead.role, waveIndex: waves.length,
    waveName: 'Director Summary', duration: leadResult.durationMs,
    hasHeading: leadResult.hasHeading, isThinking: false,
    outputLength: leadResult.sanitized.length, rawLength: leadResult.raw ? leadResult.raw.length : 0,
  };

  trace.finishedAt = Date.now();
  const totalDuration = (trace.finishedAt - startTime) / 1000;

  // Summary
  console.log(`\n${'='.repeat(60)}`);
  console.log(`SPRINT COMPLETE — ${totalDuration.toFixed(1)}s`);
  console.log('='.repeat(60));
  let clean = 0, failed = 0, thinking = 0;
  for (const [id, t] of Object.entries(trace.agents)) {
    if (t.error || t.isThinking || t.outputLength < 50) {
      console.log(`  ✗ ${t.name}: ${t.error || 'no output'} (${t.duration / 1000}s)`);
      failed++;
    } else if (!t.hasHeading) {
      console.log(`  ⚠ ${t.name}: no ## heading (${t.outputLength} chars, ${t.duration / 1000}s)`);
      thinking++;
    } else {
      console.log(`  ✓ ${t.name}: ${t.outputLength} chars (${t.duration / 1000}s)`);
      clean++;
    }
  }
  console.log(`\n  Clean: ${clean}  No heading: ${thinking}  Failed: ${failed}`);

  return { agentOutputs, trace, totalDuration };
}

// ── Output ────────────────────────────────────────────────────────────────
async function writeOutputs(agentOutputs, trace) {
  const dir = path.resolve(OUTPUT_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });

  // Trace file
  const lines = ['=== SPRINT TRACE ==='];
  lines.push(`Brief: ${BRIEF}`);
  lines.push(`Plan Source: ${trace.planSource}`);
  lines.push(`Started: ${new Date(trace.startedAt).toISOString()}`);
  lines.push(`Finished: ${new Date(trace.finishedAt).toISOString()}`);
  lines.push(`Revision Loops: 0`);
  lines.push('');
  if (trace.wavePlan) {
    lines.push('--- DIRECTOR PLAN ---');
    lines.push(`Rationale: ${trace.wavePlan.rationale || ''}`);
    trace.wavePlan.waves.forEach((w, i) => {
      lines.push(`  Wave ${i + 1}: ${w.name} — [${w.agents.join(', ')}]`);
    });
    lines.push('');
  }
  lines.push('--- AGENT TRACES ---');
  for (const [id, t] of Object.entries(trace.agents)) {
    lines.push('');
    lines.push(`## ${t.name} (${t.role})`);
    lines.push(`  Agent ID: ${id}`);
    lines.push(`  Wave: ${t.waveIndex} — ${t.waveName}`);
    lines.push(`  Status: ${t.error ? 'error' : t.hasHeading ? 'done' : 'thinking trace'}`);
    lines.push(`  Duration: ${(t.duration / 1000).toFixed(1)}s`);
    if (t.error) lines.push(`  Error: ${t.error}`);
    lines.push(`  Output: ${t.outputLength} chars (raw: ${t.rawLength})`);
    if (t.hasHeading) lines.push(`  Has ## heading: true`);
    if (agentOutputs[id] && agentOutputs[id].length > 0) {
      lines.push(`  Stored Output:`);
      lines.push(`    ${agentOutputs[id].slice(0, 2000).replace(/\n/g, '\n    ')}`);
      if (agentOutputs[id].length > 2000) lines.push(`    ... (${agentOutputs[id].length - 2000} more chars)`);
    }
  }
  lines.push('');
  lines.push('=== END TRACE ===');
  fs.writeFileSync(path.join(dir, 'trace.txt'), lines.join('\n'));
  console.log(`\n  Written: ${path.join(dir, 'trace.txt')}`);

  // Per-agent files
  for (const [id, output] of Object.entries(agentOutputs)) {
    const agent = AGENTS.find(a => a.id === id);
    if (!agent) continue;
    fs.writeFileSync(path.join(dir, 'agents', `${id}.md`), output || '');
  }
  console.log(`  Written: ${dir}/agents/*.md`);

  // Dossier HTML (simple version)
  const dossierHtml = generateDossier(agentOutputs);
  fs.writeFileSync(path.join(dir, 'dossier.html'), dossierHtml);
  console.log(`  Written: ${path.join(dir, 'dossier.html')}`);

  // Prototype HTML
  const protoHtml = await generatePrototype(agentOutputs);
  if (protoHtml) {
    fs.writeFileSync(path.join(dir, 'prototype.html'), protoHtml);
    console.log(`  Written: ${path.join(dir, 'prototype.html')}`);
  } else {
    console.log(`  Skipped: prototype.html (not enough data)`);
  }
}

function generateDossier(agentOutputs) {
  let body = '';
  for (const agent of AGENTS) {
    const output = agentOutputs[agent.id];
    if (!output || output.length < 50) continue;
    body += `<h2>${agent.name} — ${agent.role}</h2>\n<pre>${output.replace(/</g, '&lt;')}</pre>\n<hr>\n`;
  }
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Design Floor Dossier</title>
<style>body{background:#06060f;color:#c0c8d8;font-family:sans-serif;padding:40px;max-width:880px;margin:0 auto}
h1{color:#e8edf5}h2{color:#4a9eea;margin-top:32px}pre{white-space:pre-wrap;background:#0c0c1e;padding:16px;border-radius:8px;overflow-x:auto;font-size:12px;line-height:1.6}</style>
</head><body><h1>${BRIEF}</h1>${body}</body></html>`;
}

async function generatePrototype(agentOutputs) {
  const palette = agentOutputs['palette'];
  const flow = agentOutputs['flow'];
  const blueprint = agentOutputs['blueprint'];
  if (!palette && !flow && !blueprint) return null;

  let ctx = `PROJECT BRIEF:\n${BRIEF}\n\n`;
  if (palette) ctx += `VISUAL DESIGN:\n${palette.slice(0, 900)}\n\n`;
  if (flow) ctx += `UX FLOWS:\n${flow.slice(0, 700)}\n\n`;
  if (blueprint) ctx += `FIGMA SPECS:\n${blueprint.slice(0, 700)}\n\n`;

  const prompt = ctx +
    'Based on ALL of the above, generate a COMPLETE standalone HTML prototype.\n' +
    'Requirements:\n' +
    '- Single HTML file. All CSS in <style>. Zero external dependencies.\n' +
    '- Dark page background #0d0d14. Title + subtitle at top.\n' +
    '- Show 4-5 phone frames in a horizontal flex row, each 375px wide.\n' +
    '- Phone frame: white bg, border-radius:44px, box-shadow, black notch pill at top.\n' +
    '- Each phone = a different screen of the user journey.\n' +
    '- Label each phone below with screen name in monospace.\n' +
    '- ▶ arrows between phones.\n' +
    '- Output ONLY the complete HTML document starting with <!DOCTYPE html>. No explanation.\n' +
    'CRITICAL: Do NOT write any thinking or commentary. Start with <!DOCTYPE html> immediately.';

  try {
    const lead = AGENTS.find(a => a.id === 'lead');
    const raw = await callLLM(lead, prompt, []);
    const sanitized = sanitizeSwarmResponse(raw);
    const stripped = sanitized.replace(/^```(?:html)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    const m = stripped.match(/<!DOCTYPE html[\s\S]*/i) || stripped.match(/<html[\s\S]*/i);
    return m ? m[0] : null;
  } catch (e) {
    console.error('  Prototype generation failed:', e.message);
    return null;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────
(async () => {
  try {
    // Authenticate first
    console.log('Authenticating with Supabase...');
    AUTH_TOKEN = await getAuthToken();
    if (Object.keys(AUTH_TOKEN).length === 0) {
      console.error(`
ERROR: No auth method available.

To fix this, set a WORKER_SECRET on your Cloudflare Worker:

  cd worker
  npx wrangler secret put WORKER_SECRET
  (type any secret string when prompted)

Then run this script with:

  node tests/pipeline-headless.mjs "your brief" --secret YOUR_SECRET

Or add it to config.local.js:

  window.LOCAL_CONFIG = {
    ...
    workerSecret: 'YOUR_SECRET',
  };
`);
      process.exit(1);
    }

    const { agentOutputs, trace } = await runSprint();
    await writeOutputs(agentOutputs, trace);
    console.log(`\nDone. Check ${OUTPUT_DIR}/ for outputs.\n`);
  } catch (e) {
    console.error('\nFATAL:', e.message);
    process.exit(1);
  }
})();
