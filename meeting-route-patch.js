// ─── MEETING INTELLIGENCE (add to server.js after hydration endpoints) ───────
//
// POST /intel/meeting
//   Body: {
//     attendees: [{ name, company, title, linkedin?, email?, company_url? }],
//     solution: "string",
//     meetingType: "discovery" | "demo" | "negotiation" | "renewal",
//     company: "string (optional)",
//     industry: "string (optional)",
//     notes: "string (optional)"
//   }
//   Returns: Full Ready Leads meeting intelligence package
//   Cache: checks ingest_cache (role='meeting', 30-day TTL) before running pipeline

const { analyzeReadyLeads, analyzeSingle, analyzeGroup } = require('./intel/meeting-analysis');

// Build a stable cache key from meeting inputs
function meetingCacheKey(attendees, solution, meetingType) {
  const attendeeKey = attendees
    .map(a => `${(a.name || '').toLowerCase().trim()}|${(a.company || '').toLowerCase().trim()}|${(a.title || '').toLowerCase().trim()}`)
    .sort()
    .join('::');
  return `meeting:${attendeeKey}:${(solution || '').toLowerCase().trim()}:${meetingType || 'discovery'}`;
}

// Minimal TDE config — stores individual atoms in ingest_cache
// In production, wire this to a full TDE service
const tdeConfig = {
  tdeAvailable: () => !!(db.isConfigured && db.isConfigured()),
  tdeRequest: async (method, path, body) => {
    // Stub: store via ingest_cache instead of full TDE collections API
    if (method === 'POST' && path === '/ingest' && body?.collectionId && body?.input) {
      await db.setCachedIngest(body.collectionId, 'tde-atom', { content: body.input, title: body.opts?.title });
      return { ok: true };
    }
    if (method === 'POST' && path === '/collections') {
      // Collection creation is a no-op in cache-only mode
      return { ok: true };
    }
    return { ok: true };
  },
  warmTdeCacheAsync: () => {},
  urlToCollectionId: (url) => `url-${(url || 'unknown').replace(/[^a-z0-9]/gi, '-').substring(0, 60)}`,
};

app.post('/intel/meeting', async (req, res) => {
  try {
    const { attendees, solution, meetingType, company, industry, notes } = req.body || {};

    // Validate
    if (!attendees || !Array.isArray(attendees) || attendees.length === 0) {
      return res.status(400).json({ error: 'attendees array required (at least 1)' });
    }
    if (!solution) {
      return res.status(400).json({ error: 'solution required' });
    }
    if (attendees.length > 10) {
      return res.status(400).json({ error: 'maximum 10 attendees supported' });
    }

    // Check cache first
    const cacheKey = meetingCacheKey(attendees, solution, meetingType);
    console.log(`[intel/meeting] Cache key: ${cacheKey}`);

    const cached = await db.getCachedIngest(cacheKey, 'meeting');
    if (cached) {
      console.log(`[intel/meeting] Cache HIT — returning cached meeting intelligence`);
      return res.json({ ...cached, _cached: true, _cache_key: cacheKey });
    }
    console.log(`[intel/meeting] Cache MISS — running full pipeline`);

    // Build LLM config from environment
    const llmConfig = {
      openrouterApiKey: process.env.OPENROUTER_API_KEY,
      modelId: process.env.OPENROUTER_MODEL_ID || 'anthropic/claude-sonnet-4.5',
      cerebrasApiKey: process.env.CEREBRAS_API_KEY || null,
    };

    if (!llmConfig.openrouterApiKey) {
      return res.status(503).json({ error: 'OPENROUTER_API_KEY not configured' });
    }

    // Build context
    const context = {
      solution,
      company: company || attendees[0]?.company || 'Unknown',
      industry: industry || 'Unknown',
      meetingType: meetingType || 'discovery',
      notes: notes || null,
    };

    // Run the full Ready Leads analysis
    const result = await analyzeReadyLeads(attendees, context, tdeConfig, llmConfig);

    // Cache the result
    await db.setCachedIngest(cacheKey, 'meeting', result);
    console.log(`[intel/meeting] Pipeline complete — cached for 30 days (${result.pipelineTimeMs}ms)`);

    res.json({ ...result, _cached: false, _cache_key: cacheKey });

  } catch (e) {
    console.error('[intel/meeting] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Lightweight single-person scan (for progressive loading) ────────────────
app.post('/intel/scan', async (req, res) => {
  try {
    const attendee = req.body || {};
    if (!attendee.name && !attendee.email && !attendee.linkedin) {
      return res.status(400).json({ error: 'need at least name, email, or linkedin url' });
    }

    const result = await analyzeSingle(attendee, tdeConfig);
    res.json(result);
  } catch (e) {
    console.error('[intel/scan] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});
