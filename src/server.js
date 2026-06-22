import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  createSession, getSession, listSessions, endSession,
  addRecord, getRecord, deleteRecord, searchRecords, stats,
  addPhoto, getPhoto, listPhotos, deletePhoto,
} from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// Photos arrive as base64 data URLs, so allow a larger JSON body.
app.use(express.json({ limit: '12mb' }));

// Serve the responsive dashboard (works on iPhone + desktop).
app.use(express.static(join(__dirname, '..', 'public')));

const wrap = (fn) => (req, res) => {
  try {
    fn(req, res);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// --- Health & stats ---------------------------------------------------------
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/stats', wrap((_req, res) => res.json(stats())));

// --- Sessions ---------------------------------------------------------------
app.get('/api/sessions', wrap((_req, res) => res.json(listSessions())));

app.post('/api/sessions', wrap((req, res) => {
  const { name, operator, device } = req.body || {};
  if (!name || !name.trim()) throw new Error('Session name is required');
  res.status(201).json(createSession({ name: name.trim(), operator, device }));
}));

app.get('/api/sessions/:id', wrap((req, res) => {
  const session = getSession(Number(req.params.id));
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(session);
}));

app.post('/api/sessions/:id/end', wrap((req, res) => {
  const session = endSession(Number(req.params.id));
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(session);
}));

// --- Records ----------------------------------------------------------------
app.post('/api/sessions/:id/records', wrap((req, res) => {
  const record = addRecord(Number(req.params.id), req.body || {});
  res.status(201).json(record);
}));

// Search across all session data — used by both iPhone and desktop clients.
app.get('/api/records', wrap((req, res) => {
  const { q, session_id, limit, offset } = req.query;
  res.json(
    searchRecords({
      q,
      sessionId: session_id ? Number(session_id) : undefined,
      limit,
      offset,
    })
  );
}));

app.get('/api/records/:id', wrap((req, res) => {
  const record = getRecord(Number(req.params.id));
  if (!record) return res.status(404).json({ error: 'Record not found' });
  res.json(record);
}));

app.delete('/api/records/:id', wrap((req, res) => {
  const ok = deleteRecord(Number(req.params.id));
  if (!ok) return res.status(404).json({ error: 'Record not found' });
  res.status(204).end();
}));

// --- Photos -----------------------------------------------------------------
function decodeDataUrl(dataUrl) {
  const m = /^data:([\w/+.-]+);base64,(.+)$/s.exec(dataUrl || '');
  if (!m) throw new Error('Invalid image data');
  const mime = m[1];
  if (!mime.startsWith('image/')) throw new Error('Only image files are allowed');
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length) throw new Error('Empty image');
  if (buf.length > 8_000_000) throw new Error('Image too large (max ~8MB)');
  return { mime, buf };
}

app.post('/api/records/:id/photos', wrap((req, res) => {
  const { mime, buf } = decodeDataUrl((req.body || {}).data);
  res.status(201).json(addPhoto(Number(req.params.id), mime, buf));
}));

app.get('/api/records/:id/photos', wrap((req, res) =>
  res.json(listPhotos(Number(req.params.id)))));

app.get('/api/photos/:id', wrap((req, res) => {
  const photo = getPhoto(Number(req.params.id));
  if (!photo) return res.status(404).json({ error: 'Photo not found' });
  res.setHeader('Content-Type', photo.mime);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(photo.bytes);
}));

app.delete('/api/photos/:id', wrap((req, res) => {
  const ok = deletePhoto(Number(req.params.id));
  if (!ok) return res.status(404).json({ error: 'Photo not found' });
  res.status(204).end();
}));

app.listen(PORT, () => {
  console.log(`⚰  Cemetery dashboard running at http://localhost:${PORT}`);
});
