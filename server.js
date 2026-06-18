import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import cors from 'cors';
import { v4 as uuid } from 'uuid';
import { parse } from 'node-html-parser';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const SESSIONS_DIR = path.join(__dirname, 'sessions');
const DATA_DIR     = path.join(__dirname, 'data');

await fs.mkdir(SESSIONS_DIR, { recursive: true });
await fs.mkdir(DATA_DIR,     { recursive: true });

const db = new Low(new JSONFile(path.join(DATA_DIR, 'db.json')), { sessions: [] });
await db.read();

const sdb = new Low(new JSONFile(path.join(DATA_DIR, 'submissions.json')), { submissions: [] });
await sdb.read();

const chatDb = new Low(new JSONFile(path.join(DATA_DIR, 'chats.json')), { rooms: {} });
await chatDb.read();

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, SESSIONS_DIR),
  filename:    (req, file, cb) => cb(null, `${req.sessionId}.html`),
});

const assignId = (req, res, next) => { req.sessionId = uuid(); next(); };

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/html' || file.originalname.endsWith('.html')) cb(null, true);
    else cb(new Error('Only .html files are accepted'));
  },
});

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ── SSE clients for live chat ─────────────────────────────────────────────────
const chatClients = {}; // roomId -> Set of res objects

function getRoomClients(roomId) {
  if (!chatClients[roomId]) chatClients[roomId] = new Set();
  return chatClients[roomId];
}

function broadcastToRoom(roomId, data) {
  const clients = getRoomClients(roomId);
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  clients.forEach(res => res.write(payload));
}

// ── CHAT ROUTES ───────────────────────────────────────────────────────────────

// Create a new chat room
app.post('/api/chat/create', async (req, res) => {
  const roomId = uuid();
  await chatDb.read();
  chatDb.data.rooms[roomId] = { id: roomId, createdAt: new Date().toISOString(), messages: [] };
  await chatDb.write();
  res.json({ ok: true, roomId, url: `${process.env.BASE_URL}/chat/${roomId}` });
});

// Get chat room messages
app.get('/api/chat/:roomId/messages', async (req, res) => {
  const { roomId } = req.params;
  await chatDb.read();
  const room = chatDb.data.rooms[roomId];
  if (!room) return res.status(404).json({ ok: false, error: 'Room not found' });
  res.json({ ok: true, messages: room.messages });
});

// Post a message to a room
app.post('/api/chat/:roomId/messages', async (req, res) => {
  const { roomId } = req.params;
  const { name, text } = req.body;
  if (!text || !name) return res.status(400).json({ ok: false, error: 'name and text required' });

  await chatDb.read();
  const room = chatDb.data.rooms[roomId];
  if (!room) return res.status(404).json({ ok: false, error: 'Room not found' });

  const message = { id: uuid(), name: name.trim(), text: text.trim(), ts: Date.now() };
  room.messages.push(message);
  room.messages = room.messages.slice(-200);
  await chatDb.write();

  broadcastToRoom(roomId, { type: 'message', message });
  res.json({ ok: true, message });
});

// SSE stream for real-time updates
app.get('/api/chat/:roomId/stream', (req, res) => {
  const { roomId } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const clients = getRoomClients(roomId);
  clients.add(res);
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

  req.on('close', () => clients.delete(res));
});

// Serve chat room page
app.get('/chat/:roomId', async (req, res) => {
  const { roomId } = req.params;
  await chatDb.read();
  const room = chatDb.data.rooms[roomId];
  if (!room) return res.status(404).send('<h1>Chat room not found</h1>');
  res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});

// ── EXISTING ROUTES ───────────────────────────────────────────────────────────

async function patchHtml(sessionId) {
  const filePath = path.join(SESSIONS_DIR, `${sessionId}.html`);
  let html = await fs.readFile(filePath, 'utf8');
  const root = parse(html);
  root.querySelectorAll('form').forEach(form => {
    form.setAttribute('action', `/api/submit/${sessionId}`);
    form.setAttribute('method', 'POST');
    form.removeAttribute('target');
  });
  const SUBMIT_PLACEHOLDERS = [
    /fetch\(['"]\/submit['"]/g,
    /fetch\(['"]\/api\/submit['"]/g,
    /fetch\(['"]\/submit\.php['"]/g,
  ];
  let patched = root.toString();
  SUBMIT_PLACEHOLDERS.forEach(re => {
    patched = patched.replace(re, `fetch('/api/submit/${sessionId}'`);
  });
  const injected = `<script>(function(){var SID='${sessionId}';document.addEventListener('DOMContentLoaded',function(){document.querySelectorAll('form').forEach(function(f){if(!f.action||f.action===window.location.href){f.action='/api/submit/'+SID;f.method='POST';}});});}());</script>`;
  patched = patched.includes('</body>') ? patched.replace('</body>', injected + '</body>') : patched + injected;
  await fs.writeFile(filePath, patched, 'utf8');
}

function generateEmailHtml({ sessionId, label, baseUrl }) {
  const sessionUrl = `${baseUrl}/session/${sessionId}`;
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml"><head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>${label}</title></head>
<body style="margin:0;padding:0;background-color:#f4f4f4;font-family:Arial,Helvetica,sans-serif;">
<table border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color:#f4f4f4;"><tr><td align="center" style="padding:40px 10px;">
<table border="0" cellpadding="0" cellspacing="0" width="600" style="background-color:#ffffff;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
<tr><td style="background-color:#1a1a2e;border-radius:8px 8px 0 0;padding:28px 40px;"><p style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">Emerge Living</p><p style="margin:4px 0 0;color:rgba(255,255,255,0.55);font-size:13px;letter-spacing:1px;text-transform:uppercase;">Interactive Report</p></td></tr>
<tr><td style="padding:36px 40px 28px;"><p style="margin:0 0 10px;color:#111111;font-size:20px;font-weight:700;">${label}</p><p style="margin:0 0 28px;color:#555555;font-size:15px;line-height:1.6;">Your interactive session is ready. Click the button below to open the full report in your browser — no download required.</p>
<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${sessionUrl}" style="height:50px;v-text-anchor:middle;width:240px;" arcsize="14%" stroke="f" fillcolor="#2563eb"><w:anchorlock/><center style="color:#ffffff;font-family:Arial,sans-serif;font-size:15px;font-weight:700;">Launch Interactive Session</center></v:roundrect><![endif]-->
<!--[if !mso]><!--><table border="0" cellpadding="0" cellspacing="0"><tr><td align="center" style="background-color:#2563eb;border-radius:7px;"><a href="${sessionUrl}" target="_blank" style="display:inline-block;padding:14px 28px;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;">Launch Interactive Session</a></td></tr></table><!--<![endif]-->
<p style="margin:20px 0 0;color:#888888;font-size:12px;">Or copy this link: <a href="${sessionUrl}" style="color:#2563eb;word-break:break-all;">${sessionUrl}</a></p></td></tr>
<tr><td style="background-color:#f9f9f9;border-top:1px solid #eeeeee;border-radius:0 0 8px 8px;padding:18px 40px;"><p style="margin:0;color:#aaaaaa;font-size:12px;">Session ID: <code style="font-family:monospace;">${sessionId}</code></p></td></tr>
</table></td></tr></table></body></html>`;
}

app.post('/api/upload', assignId, upload.single('htmlFile'), async (req, res) => {
  try {
    const { sessionId } = req;
    const label = (req.body.label || req.file.originalname).trim();
    await patchHtml(sessionId);
    await db.read();
    db.data.sessions.push({ id: sessionId, label, filename: `${sessionId}.html`, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 7*24*60*60*1000).toISOString() });
    await db.write();
    const emailHtml = generateEmailHtml({ sessionId, label, baseUrl: process.env.BASE_URL });
    const sessionUrl = `${process.env.BASE_URL}/session/${sessionId}`;
    console.log(`[UPLOAD] Session created: ${sessionId}`);
    res.json({ ok: true, sessionId, sessionUrl, emailHtml });
  } catch (err) {
    console.error('[UPLOAD ERROR]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/upload-raw', async (req, res) => {
  try {
    const { html, label = 'Interactive Session' } = req.body;
    if (!html) return res.status(400).json({ ok: false, error: 'html field is required' });
    const sessionId = uuid();
    await fs.writeFile(path.join(SESSIONS_DIR, `${sessionId}.html`), html, 'utf8');
    await patchHtml(sessionId);
    await db.read();
    db.data.sessions.push({ id: sessionId, label: label.trim(), filename: `${sessionId}.html`, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 7*24*60*60*1000).toISOString() });
    await db.write();
    const emailHtml = generateEmailHtml({ sessionId, label, baseUrl: process.env.BASE_URL });
    const sessionUrl = `${process.env.BASE_URL}/session/${sessionId}`;
    res.json({ ok: true, sessionId, sessionUrl, emailHtml });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/session/:id', async (req, res) => {
  const { id } = req.params;
  await db.read();
  const session = db.data.sessions.find(s => s.id === id);
  if (!session) return res.status(404).send('<h1>Session not found</h1>');
  if (new Date() > new Date(session.expiresAt)) return res.status(410).send('<h1>This session has expired</h1>');
  try {
    const html = await fs.readFile(path.join(SESSIONS_DIR, session.filename), 'utf8');
    res.type('text/html').send(html);
  } catch { res.status(404).send('<h1>Session file not found</h1>'); }
});

app.post('/api/submit/:id', async (req, res) => {
  const { id } = req.params;
  await db.read();
  const session = db.data.sessions.find(s => s.id === id);
  if (!session) return res.status(404).json({ ok: false, error: 'Unknown session' });
  const submission = { id: uuid(), sessionId: id, sessionLabel: session.label, submittedAt: new Date().toISOString(), data: req.body };
  await sdb.read();
  sdb.data.submissions.push(submission);
  await sdb.write();
  const wantsJson = req.headers['content-type']?.includes('application/json') || req.headers['accept']?.includes('application/json');
  if (wantsJson) return res.json({ ok: true, submissionId: submission.id });
  res.send(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;text-align:center;"><h2>✓ Submitted</h2><p>Submission ID: ${submission.id}</p></body></html>`);
});

app.get('/api/sessions', async (req, res) => { await db.read(); res.json({ sessions: db.data.sessions }); });
app.get('/api/submissions', async (req, res) => { await sdb.read(); res.json({ submissions: sdb.data.submissions }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✓ Server running on http://localhost:${PORT}`);
  console.log(`  Admin UI: http://localhost:${PORT}/admin/`);
});
