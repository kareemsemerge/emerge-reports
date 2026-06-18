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

// ─── Paths ────────────────────────────────────────────────────────────────────
const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const SESSIONS_DIR = path.join(__dirname, 'sessions');
const DATA_DIR     = path.join(__dirname, 'data');

// Ensure directories exist on startup
await fs.mkdir(SESSIONS_DIR, { recursive: true });
await fs.mkdir(DATA_DIR,     { recursive: true });

// ─── Database setup (lowdb) ───────────────────────────────────────────────────
// db.json: stores session metadata { id, filename, createdAt, label }
const db = new Low(
  new JSONFile(path.join(DATA_DIR, 'db.json')),
  { sessions: [] }
);
await db.read();

// submissions.json: stores form payloads { id, sessionId, submittedAt, data }
const sdb = new Low(
  new JSONFile(path.join(DATA_DIR, 'submissions.json')),
  { submissions: [] }
);
await sdb.read();

// ─── Multer (file upload handler) ────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, SESSIONS_DIR),
  filename:    (req, file, cb) => {
    // Always store with the session ID so filenames never collide
    cb(null, `${req.sessionId}.html`);
  },
});

// Attach a sessionId to the request BEFORE multer writes the file
const assignId = (req, res, next) => {
  req.sessionId = uuid();
  next();
};

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB cap
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/html' || file.originalname.endsWith('.html')) {
      cb(null, true);
    } else {
      cb(new Error('Only .html files are accepted'));
    }
  },
});

// ─── Express app ─────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve the admin UI from /public
app.use(express.static(path.join(__dirname, 'public')));

// ─── Helper: inject backend wiring into uploaded HTML ────────────────────────
/**
 * Reads the uploaded HTML file, patches every <form> and fetch() call
 * so they point to /api/submit/:sessionId, then rewrites the file in place.
 */
async function patchHtml(sessionId) {
  const filePath = path.join(SESSIONS_DIR, `${sessionId}.html`);
  let html = await fs.readFile(filePath, 'utf8');
  const root = parse(html);

  // 1. Patch <form> elements
  root.querySelectorAll('form').forEach(form => {
    form.setAttribute('action', `/api/submit/${sessionId}`);
    form.setAttribute('method', 'POST');
    // Remove any target="_blank" that might interfere
    form.removeAttribute('target');
  });

  // 2. Patch fetch() calls — replace common placeholder patterns
  //    Developers typically use '/submit', '/api/submit', or '/submit.php'
  const SUBMIT_PLACEHOLDERS = [
    /fetch\(['"]\/submit['"]/g,
    /fetch\(['"]\/api\/submit['"]/g,
    /fetch\(['"]\/submit\.php['"]/g,
    /action\s*=\s*['"]\/submit['"]/g,
  ];
  let patched = root.toString();
  SUBMIT_PLACEHOLDERS.forEach(re => {
    patched = patched.replace(re, `fetch('/api/submit/${sessionId}'`);
  });

  // 3. Inject a small script that auto-wires any remaining forms
  //    (belt-and-suspenders for forms not caught by the parser)
  const injected = `
<script>
(function () {
  var SID = '${sessionId}';
  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('form').forEach(function (f) {
      if (!f.action || f.action === window.location.href) {
        f.action = '/api/submit/' + SID;
        f.method = 'POST';
      }
    });
  });
})();
</script>
`;

  // Inject just before </body>
  patched = patched.includes('</body>')
    ? patched.replace('</body>', injected + '</body>')
    : patched + injected;

  await fs.writeFile(filePath, patched, 'utf8');
}

// ─── Helper: generate the Outlook-safe email HTML ────────────────────────────
function generateEmailHtml({ sessionId, label, baseUrl }) {
  const sessionUrl = `${baseUrl}/session/${sessionId}`;

  return /* html */`<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN"
  "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${label}</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f4f4;font-family:Arial,Helvetica,sans-serif;">

  <!-- Outer wrapper -->
  <table border="0" cellpadding="0" cellspacing="0" width="100%"
         style="background-color:#f4f4f4;">
    <tr>
      <td align="center" style="padding:40px 10px;">

        <!-- Email card -->
        <table border="0" cellpadding="0" cellspacing="0" width="600"
               style="background-color:#ffffff;border-radius:8px;
                      box-shadow:0 2px 8px rgba(0,0,0,0.08);">

          <!-- Header band -->
          <tr>
            <td style="background-color:#1a1a2e;border-radius:8px 8px 0 0;
                        padding:28px 40px;">
              <table border="0" cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td>
                    <p style="margin:0;color:#ffffff;font-size:22px;
                               font-weight:700;letter-spacing:-0.3px;">
                      Emerge Living
                    </p>
                    <p style="margin:4px 0 0;color:rgba(255,255,255,0.55);
                               font-size:13px;letter-spacing:1px;
                               text-transform:uppercase;">
                      Interactive Report
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:36px 40px 28px;">
              <p style="margin:0 0 10px;color:#111111;font-size:20px;
                         font-weight:700;line-height:1.3;">
                ${label}
              </p>
              <p style="margin:0 0 28px;color:#555555;font-size:15px;
                         line-height:1.6;">
                Your interactive session is ready. Click the button below to
                open the full report in your browser — no download required.
                The link is unique to you and expires in&nbsp;7&nbsp;days.
              </p>

              <!-- Bulletproof button (VML + CSS fallback) -->
              <!--[if mso]>
              <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml"
                xmlns:w="urn:schemas-microsoft-com:office:word"
                href="${sessionUrl}"
                style="height:50px;v-text-anchor:middle;width:240px;"
                arcsize="14%"
                stroke="f"
                fillcolor="#2563eb">
                <w:anchorlock/>
                <center style="color:#ffffff;font-family:Arial,sans-serif;
                               font-size:15px;font-weight:700;">
                  Launch Interactive Session
                </center>
              </v:roundrect>
              <![endif]-->
              <!--[if !mso]><!-->
              <table border="0" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center"
                      style="background-color:#2563eb;border-radius:7px;">
                    <a href="${sessionUrl}"
                       target="_blank"
                       style="display:inline-block;padding:14px 28px;
                              color:#ffffff;font-size:15px;font-weight:700;
                              text-decoration:none;letter-spacing:0.2px;">
                      Launch Interactive Session
                    </a>
                  </td>
                </tr>
              </table>
              <!--<![endif]-->

              <!-- Plain link fallback -->
              <p style="margin:20px 0 0;color:#888888;font-size:12px;">
                Or copy this link into your browser:<br/>
                <a href="${sessionUrl}"
                   style="color:#2563eb;word-break:break-all;">
                  ${sessionUrl}
                </a>
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color:#f9f9f9;border-top:1px solid #eeeeee;
                        border-radius:0 0 8px 8px;padding:18px 40px;">
              <p style="margin:0;color:#aaaaaa;font-size:12px;line-height:1.5;">
                This link is secure and single-recipient. Session ID:
                <code style="font-family:monospace;">${sessionId}</code>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>

</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ─── POST /api/upload ─────────────────────────────────────────────────────────
// Receives the HTML file from the admin UI, stores it, generates email HTML.
app.post('/api/upload', assignId, upload.single('htmlFile'), async (req, res) => {
  try {
    const { sessionId } = req;
    const label = (req.body.label || req.file.originalname).trim();

    // Patch form actions and fetch() in the uploaded file
    await patchHtml(sessionId);

    // Persist session metadata
    await db.read();
    db.data.sessions.push({
      id:         sessionId,
      label,
      filename:   `${sessionId}.html`,
      createdAt:  new Date().toISOString(),
      expiresAt:  new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    });
    await db.write();

    // Generate the Outlook-safe email HTML
    const emailHtml = generateEmailHtml({
      sessionId,
      label,
      baseUrl: process.env.BASE_URL,
    });

    const sessionUrl = `${process.env.BASE_URL}/session/${sessionId}`;

    console.log(`[UPLOAD] Session created: ${sessionId} — "${label}"`);

    res.json({
      ok:         true,
      sessionId,
      sessionUrl,
      emailHtml,   // The admin UI renders this for copy-paste into Outlook
    });
  } catch (err) {
    console.error('[UPLOAD ERROR]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── POST /api/upload-raw ─────────────────────────────────────────────────────
// Same as /api/upload but accepts raw HTML pasted as JSON body (no file).
app.post('/api/upload-raw', async (req, res) => {
  try {
    const { html, label = 'Interactive Session' } = req.body;
    if (!html || typeof html !== 'string') {
      return res.status(400).json({ ok: false, error: 'html field is required' });
    }

    const sessionId = uuid();
    const filePath  = path.join(SESSIONS_DIR, `${sessionId}.html`);
    await fs.writeFile(filePath, html, 'utf8');

    await patchHtml(sessionId);

    await db.read();
    db.data.sessions.push({
      id:        sessionId,
      label:     label.trim(),
      filename:  `${sessionId}.html`,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    });
    await db.write();

    const emailHtml  = generateEmailHtml({ sessionId, label, baseUrl: process.env.BASE_URL });
    const sessionUrl = `${process.env.BASE_URL}/session/${sessionId}`;

    console.log(`[UPLOAD-RAW] Session created: ${sessionId} — "${label}"`);

    res.json({ ok: true, sessionId, sessionUrl, emailHtml });
  } catch (err) {
    console.error('[UPLOAD-RAW ERROR]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /session/:id ─────────────────────────────────────────────────────────
// Serves the fully interactive HTML to the recipient's browser.
app.get('/session/:id', async (req, res) => {
  const { id } = req.params;
  await db.read();
  const session = db.data.sessions.find(s => s.id === id);

  if (!session) {
    return res.status(404).send('<h1>Session not found</h1>');
  }

  if (new Date() > new Date(session.expiresAt)) {
    return res.status(410).send('<h1>This session has expired</h1>');
  }

  const filePath = path.join(SESSIONS_DIR, session.filename);
  try {
    const html = await fs.readFile(filePath, 'utf8');
    console.log(`[SESSION] Serving session: ${id}`);
    res.type('text/html').send(html);
  } catch {
    res.status(404).send('<h1>Session file not found</h1>');
  }
});

// ─── POST /api/submit/:id ─────────────────────────────────────────────────────
// Receives form submissions from the interactive HTML in the browser.
app.post('/api/submit/:id', async (req, res) => {
  const { id } = req.params;

  await db.read();
  const session = db.data.sessions.find(s => s.id === id);
  if (!session) {
    return res.status(404).json({ ok: false, error: 'Unknown session' });
  }

  const submission = {
    id:          uuid(),
    sessionId:   id,
    sessionLabel: session.label,
    submittedAt: new Date().toISOString(),
    data:        req.body,
  };

  await sdb.read();
  sdb.data.submissions.push(submission);
  await sdb.write();

  console.log(`[SUBMIT] Session ${id} — received data:`, req.body);

  // Return JSON so fetch()-based forms get a clean response,
  // OR redirect for classic <form method="POST"> submissions.
  const wantsJson = req.headers['content-type']?.includes('application/json')
    || req.headers['accept']?.includes('application/json');

  if (wantsJson) {
    return res.json({ ok: true, submissionId: submission.id });
  }

  // Classic form: redirect to a thank-you page
  res.send(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;text-align:center;">
    <h2>✓ Submitted successfully</h2>
    <p>Thank you. Your response has been recorded.</p>
    <p style="color:#888;font-size:13px;">Submission ID: ${submission.id}</p>
  </body></html>`);
});

// ─── GET /api/sessions ────────────────────────────────────────────────────────
// Admin endpoint — list all sessions.
app.get('/api/sessions', async (req, res) => {
  await db.read();
  res.json({ sessions: db.data.sessions });
});

// ─── GET /api/submissions ─────────────────────────────────────────────────────
// Admin endpoint — list all submissions.
app.get('/api/submissions', async (req, res) => {
  await sdb.read();
  res.json({ submissions: sdb.data.submissions });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✓ Server running on http://localhost:${PORT}`);
  console.log(`  Admin UI: http://localhost:${PORT}/admin/`);
});