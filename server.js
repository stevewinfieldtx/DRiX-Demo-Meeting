const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3002;
const BRAIN_URL = process.env.BRAIN_URL || 'https://drix-brain.up.railway.app';

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Proxy to Brain — avoids CORS issues
app.post('/api/meeting', async (req, res) => {
  try {
    const response = await fetch(BRAIN_URL + '/intel/meeting', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(120000),
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    res.json(data);
  } catch (e) {
    console.error('[proxy]', e.message);
    res.status(502).json({ error: 'Brain unreachable: ' + e.message });
  }
});

app.post('/api/scan', async (req, res) => {
  try {
    const response = await fetch(BRAIN_URL + '/intel/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(60000),
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    res.json(data);
  } catch (e) {
    console.error('[proxy]', e.message);
    res.status(502).json({ error: 'Brain unreachable: ' + e.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`[drix-demo] Meeting Intelligence on http://localhost:${PORT}`);
  console.log(`[drix-demo] Brain: ${BRAIN_URL}`);
});
