const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3002;
const BRAIN_URL = process.env.BRAIN_URL || 'https://drix-brain.up.railway.app';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_MODEL_ID = process.env.OPENROUTER_MODEL_ID || 'anthropic/claude-sonnet-4.5';
const DATABASE_URL = process.env.DATABASE_URL || '';

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── POSTGRES CACHE ────────────────────────────────────────────────────────
let pool = null;

async function initDB() {
  if (!DATABASE_URL) {
    console.log('[cache] No DATABASE_URL — TDE caching disabled');
    return;
  }
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes('railway.internal') ? false : { rejectUnauthorized: false },
    max: 3,
    idleTimeoutMillis: 30000,
  });
  pool.on('error', (err) => console.error('[cache] Pool error:', err.message));
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS meeting_cache (
        cache_key   TEXT PRIMARY KEY,
        customer    TEXT,
        solution    TEXT,
        attendees   TEXT,
        stage       TEXT,
        result      JSONB NOT NULL,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        hit_count   INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_mc_created ON meeting_cache(created_at DESC);
    `);
    console.log('[cache] Postgres ready');
  } catch (e) {
    console.error('[cache] Schema init failed:', e.message);
    pool = null;
  }
}

function cacheKey(customer, solution, attendeeTitles, stage) {
  const raw = [
    customer.toLowerCase().trim(),
    solution.toLowerCase().trim(),
    attendeeTitles.map(t => t.toLowerCase().trim()).sort().join('|'),
    stage.toLowerCase().trim(),
  ].join('::');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

async function cacheGet(key) {
  if (!pool) return null;
  try {
    const res = await pool.query(
      'SELECT result FROM meeting_cache WHERE cache_key = $1', [key]
    );
    if (res.rows.length) {
      pool.query('UPDATE meeting_cache SET hit_count = hit_count + 1 WHERE cache_key = $1', [key]);
      return res.rows[0].result;
    }
    return null;
  } catch (e) {
    console.error('[cache] get error:', e.message);
    return null;
  }
}

async function cacheSet(key, customer, solution, attendees, stage, result) {
  if (!pool) return;
  try {
    await pool.query(`
      INSERT INTO meeting_cache (cache_key, customer, solution, attendees, stage, result)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (cache_key) DO UPDATE SET result = EXCLUDED.result, created_at = NOW()
    `, [key, customer, solution, attendees, stage, JSON.stringify(result)]);
  } catch (e) {
    console.error('[cache] set error:', e.message);
  }
}

// ─── LLM HELPER ────────────────────────────────────────────────────────────
async function callLLM(systemPrompt, userPrompt, maxTokens = 8000) {
  if (!OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY not set');
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://drix-demo.up.railway.app',
      'X-Title': 'DRiX Meeting Intelligence',
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL_ID,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3,
      max_tokens: maxTokens,
    }),
    signal: AbortSignal.timeout(90000),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`LLM ${response.status}: ${err.slice(0, 300)}`);
  }
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty LLM response');
  return JSON.parse(content.replace(/```json|```/g, '').trim());
}

function hasRealPersonData(attendees) {
  return attendees.some(a =>
    (a.email && a.email.includes('@')) ||
    (a.linkedin && a.linkedin.includes('linkedin.com')) ||
    (a.name && !['cfo','ciso','cto','coo','vp of it','it director','vp finance'].includes(a.name.toLowerCase()))
  );
}

// ─── TDE MEETING ENDPOINT (cached) ─────────────────────────────────────────
app.post('/api/meeting', async (req, res) => {
  try {
    const { attendees, solution, meetingType, company, industry, notes } = req.body || {};
    if (!attendees?.length) return res.status(400).json({ error: 'attendees required' });
    if (!solution) return res.status(400).json({ error: 'solution required' });

    const titles = attendees.map(a => a.title || a.name);
    const stage = meetingType || 'discovery';
    const key = cacheKey(company, solution, titles, stage);

    // Cache check
    const cached = await cacheGet(key);
    if (cached) {
      console.log(`[meeting] CACHE HIT — ${key.slice(0,8)}...`);
      return res.json({ ...cached, _cached: true, _cache_key: key });
    }
    console.log(`[meeting] CACHE MISS — ${key.slice(0,8)}... running pipeline`);

    // If real person data, try Brain first
    if (hasRealPersonData(attendees)) {
      try {
        console.log('[meeting] Real person data — calling Brain');
        const response = await fetch(BRAIN_URL + '/intel/meeting', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(req.body),
          signal: AbortSignal.timeout(120000),
        });
        if (response.ok) {
          const data = await response.json();
          await cacheSet(key, company, solution, titles.join(', '), stage, data);
          return res.json({ ...data, _cached: false, _cache_key: key });
        }
      } catch (e) {
        console.log('[meeting] Brain failed, falling back to role-based:', e.message);
      }
    }

    // Role-based intelligence
    const startTime = Date.now();
    const roleDescriptions = attendees.map((a, i) =>
      `#${i + 1} (Priority): ${a.title || a.name} at ${company}`
    ).join('\n');

    const stageContext = (stage === 'negotiation' || stage === 'closing')
      ? 'FINAL DECISION MEETING: The buyer is deciding. Address objections, confirm ROI, secure commitment. Be direct.'
      : 'FIRST MEETING: Discovery. Build rapport, uncover pain, qualify, earn the next meeting. No pricing.';

    const systemPrompt = `You are DRiX, an elite B2B meeting intelligence engine using 9-dimensional analysis.

9D filtering dimensions:
1. d_persona — Match content to each attendee's seniority and role
2. d_buying_stage — ${stage === 'negotiation' ? 'Late: differentiate, de-risk, close' : 'Early: educate, discover, qualify'}
3. d_emotional_driver — Personal motivations per persona
4. d_evidence_type — Match proof to role
5. d_credibility — ${stage === 'negotiation' ? 'Earned (3-4)' : 'Low (1-2): prove everything'}
6. d_recency — Prioritize recent signals
7. d_economic_driver — Financial pressures
8. d_status_quo_pressure — Forces pushing change NOW
9. d_industry — Filter proof by vertical

Every recommendation filtered through these dimensions.`;

    const userPrompt = `COMPANY: ${company}
SOLUTION: ${solution}
STAGE: ${stageContext}
ATTENDEES BY PRIORITY:
${roleDescriptions}
${notes ? 'NOTES: ' + notes : ''}

Generate complete meeting intelligence as JSON:
{
  "solutionIntersection": {
    "perPerson": [{"name":"<title>","relevantPainPoints":[],"messagingAngle":"","objections":[{"objection":"","response":""}],"proofPoints":[],"economicFrame":"","statusQuoCounter":""}],
    "executiveSummary": "<3-4 sentences>",
    "meetingScript": {"opening":"","agendaFraming":"","assignments":[{"topic":"","directedAt":"","why":""}],"closingMove":""},
    "dealKillers": [],
    "wildcards": []
  },
  "groupDynamics": ${attendees.length > 1 ? '{"powerMap":{"decisionMaker":"","influencers":[],"blockers":[],"champions":[],"observers":[]},"groupStrategy":"","sequencing":{"openWith":"","buildMomentum":"","neutralize":"","close":""},"alliances":[],"tensions":[],"landmines":[],"roomEnergy":"","winCondition":""}' : 'null'},
  "individuals": [${attendees.map(a => `{"name":"${a.title||a.name}","title":"${a.title||a.name}","company":"${company}","archetype":"","decisionStyle":"","riskAppetite":"","communicationStyle":"","keyInsight":""}`).join(',')}],
  "attendeeCount": ${attendees.length},
  "totalAtoms": 0
}

Be specific to ${company}. No generic advice.`;

    const result = await callLLM(systemPrompt, userPrompt);
    result.pipelineTimeMs = Date.now() - startTime;
    result._mode = 'role-based';

    // Cache the TDE result
    await cacheSet(key, company, solution, titles.join(', '), stage, result);
    console.log(`[meeting] Cached — ${key.slice(0,8)}... (${result.pipelineTimeMs}ms)`);

    res.json({ ...result, _cached: false, _cache_key: key });
  } catch (e) {
    console.error('[meeting]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── GENERIC ENDPOINT (never cached — that's the point) ────────────────────
app.post('/api/generic', async (req, res) => {
  try {
    const { prompt } = req.body || {};
    if (!prompt) return res.status(400).json({ error: 'prompt required' });
    const result = await callLLM(
      'You are a helpful business meeting preparation assistant.',
      prompt,
      4096
    );
    res.json(result);
  } catch (e) {
    console.error('[generic]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── BOOT ──────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`[drix-demo] Meeting Intelligence on http://localhost:${PORT}`);
    console.log(`[drix-demo] Brain: ${BRAIN_URL}`);
    console.log(`[drix-demo] Cache: ${pool ? 'Postgres' : 'DISABLED'}`);
    console.log(`[drix-demo] OpenRouter: ${OPENROUTER_API_KEY ? 'configured' : 'MISSING'}`);
  });
});
