const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3002;
const BRAIN_URL = process.env.BRAIN_URL || 'https://drix-brain.up.railway.app';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_MODEL_ID = process.env.OPENROUTER_MODEL_ID || 'anthropic/claude-sonnet-4.5';

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── LLM helper ────────────────────────────────────────────────────────────
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

// ─── Check if attendees have real person data ──────────────────────────────
function hasRealPersonData(attendees) {
  return attendees.some(a =>
    (a.email && a.email.includes('@')) ||
    (a.linkedin && a.linkedin.includes('linkedin.com')) ||
    (a.name && !['economic buyer','technical evaluator','business champion'].includes(a.name.toLowerCase()))
  );
}

// ─── Proxy to Brain — full pipeline (when we have real person data) ────────
app.post('/api/meeting', async (req, res) => {
  try {
    const { attendees, solution, meetingType, company, industry, notes } = req.body || {};
    if (!attendees?.length) return res.status(400).json({ error: 'attendees required' });
    if (!solution) return res.status(400).json({ error: 'solution required' });

    // If we have real person data, use Brain's full pipeline
    if (hasRealPersonData(attendees)) {
      console.log('[meeting] Real person data detected — calling Brain');
      const response = await fetch(BRAIN_URL + '/intel/meeting', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body),
        signal: AbortSignal.timeout(120000),
      });
      const data = await response.json();
      if (!response.ok) return res.status(response.status).json(data);
      return res.json(data);
    }

    // Role-based mode — no real person data, use company + roles
    console.log(`[meeting] Role-based mode — ${attendees.length} roles at ${company}`);
    const startTime = Date.now();

    const roleDescriptions = attendees.map((a, i) =>
      `#${i + 1} (Priority): ${a.title || a.name} at ${company}`
    ).join('\n');

    const stageContext = (meetingType === 'negotiation' || meetingType === 'closing')
      ? 'FINAL DECISION MEETING: Close the deal. Address objections, confirm ROI, secure commitment.'
      : 'FIRST MEETING: Discovery. Build rapport, uncover pain, qualify, earn the next meeting.';

    const systemPrompt = `You are DRiX, an elite B2B meeting intelligence engine. You produce meeting strategies based on:
1. The COMPANY being visited (research what you know about them)
2. The ROLES/TITLES in the room (not specific people — role-based archetypes)
3. The SOLUTION being presented
4. The MEETING STAGE

Your output must be specific to THIS company and THIS industry. Not generic sales advice.
For each role, consider: what does a person in this role at this type of company typically care about? What are their KPIs? What keeps them up at night? What evidence do they trust? What language resonates?

When multiple roles are in the room, analyze the DYNAMICS between them. Who has authority? Who influences? Who blocks? How does the conversation change when the CFO is sitting next to the CISO?`;

    const userPrompt = `COMPANY: ${company}
SOLUTION: ${solution}
INDUSTRY: ${industry || 'Technology / IT'}
STAGE: ${stageContext}
ATTENDEES BY PRIORITY:
${roleDescriptions}
${notes ? 'NOTES: ' + notes : ''}

Generate a complete meeting intelligence package as JSON:
{
  "solutionIntersection": {
    "perPerson": [
      {
        "name": "<role/title>",
        "relevantPainPoints": ["<pain points this role has that our solution addresses>"],
        "messagingAngle": "<how to frame our solution for this role>",
        "objections": [{"objection": "<pushback>", "response": "<counter>"}],
        "proofPoints": ["<evidence types that resonate with this role>"],
        "economicFrame": "<ROI | cost-out | speed | risk-reduction>",
        "statusQuoCounter": "<how to overcome their inertia>"
      }
    ],
    "executiveSummary": "<3-4 sentences: the single most important thing to know>",
    "meetingScript": {
      "opening": "<how to open given who is in the room>",
      "agendaFraming": "<how to frame the agenda strategically>",
      "assignments": [{"topic": "<what to cover>", "directedAt": "<which role>", "why": "<reason>"}],
      "closingMove": "<how to close and what to ask for>"
    },
    "dealKillers": ["<things that will kill this deal>"],
    "wildcards": ["<unexpected things to prepare for>"]
  },
  "groupDynamics": ${attendees.length > 1 ? `{
    "powerMap": {
      "decisionMaker": "<which role has final authority>",
      "influencers": ["<roles that shape the decision>"],
      "blockers": ["<roles likely to resist>"],
      "champions": ["<roles likely to advocate>"],
      "observers": []
    },
    "groupStrategy": "<2-3 paragraphs on how to navigate this specific group>",
    "sequencing": {
      "openWith": "<who to address first>",
      "buildMomentum": "<how to cascade buy-in>",
      "neutralize": "<how to handle resistance>",
      "close": "<how to drive next steps>"
    },
    "alliances": ["<likely alignments between roles>"],
    "tensions": ["<likely friction between roles>"],
    "landmines": ["<topics that trigger resistance — name the role and the trigger>"],
    "roomEnergy": "<skeptical | enthusiastic | divided | political>",
    "winCondition": "<what needs to happen for this meeting to succeed>"
  }` : 'null'},
  "individuals": [${attendees.map(a => `{
    "name": "${a.title || a.name}",
    "title": "${a.title || a.name}",
    "company": "${company}",
    "archetype": "<defender | pioneer | grower | optimizer>",
    "decisionStyle": "<analytical | intuitive | consensus | directive>",
    "riskAppetite": "<risk-averse | moderate | risk-tolerant>",
    "communicationStyle": "<data-driven | relationship-driven | vision-driven | process-driven>",
    "keyInsight": "<the single most important thing to know about engaging this role>"
  }`).join(',\n')}],
  "attendeeCount": ${attendees.length},
  "totalAtoms": 0
}

Be extremely specific to ${company} and the ${solution} solution. Reference real industry dynamics, regulatory pressures, and competitive factors. No generic advice.`;

    const result = await callLLM(systemPrompt, userPrompt);
    result.pipelineTimeMs = Date.now() - startTime;
    result._mode = 'role-based';
    result._cached = false;

    res.json(result);
  } catch (e) {
    console.error('[meeting]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Generic outline — TDE off mode ────────────────────────────────────────
app.post('/api/generic', async (req, res) => {
  try {
    const { prompt } = req.body || {};
    if (!prompt) return res.status(400).json({ error: 'prompt required' });
    const result = await callLLM('You are a B2B meeting preparation assistant.', prompt, 4096);
    res.json(result);
  } catch (e) {
    console.error('[generic]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`[drix-demo] Meeting Intelligence on http://localhost:${PORT}`);
  console.log(`[drix-demo] Brain: ${BRAIN_URL}`);
  console.log(`[drix-demo] OpenRouter: ${OPENROUTER_API_KEY ? 'configured' : 'MISSING'}`);
});
