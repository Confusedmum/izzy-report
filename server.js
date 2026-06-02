require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { google } = require('googleapis');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const FOLDER_NAME = 'Izzy Report Tool';

// ─── OAuth client ──────────────────────────────────────────────────────────────
function makeOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

const oauthClient = makeOAuthClient();
let googleReady = false;

if (process.env.GOOGLE_REFRESH_TOKEN) {
  oauthClient.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  googleReady = true;
}

// googleapis Drive client — oauthClient handles token refresh automatically
const driveApi = google.drive({ version: 'v3', auth: oauthClient });

// ─── Server-side Drive state ────────────────────────────────────────────────────
let driveFolderId  = null;
let driveStateFileId = null;
let driveAppState  = { reportedTxIds: {}, categoryPrefs: null, receipts: {} };
let driveInitPromise = null;

async function getDriveFolder() {
  if (driveFolderId) return driveFolderId;
  const res = await driveApi.files.list({
    q: `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)',
  });
  if (res.data.files.length > 0) {
    driveFolderId = res.data.files[0].id;
  } else {
    const created = await driveApi.files.create({
      requestBody: { name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' },
      fields: 'id',
    });
    driveFolderId = created.data.id;
  }
  return driveFolderId;
}

async function loadState() {
  const folderId = await getDriveFolder();
  const res = await driveApi.files.list({
    q: `name='state.json' and '${folderId}' in parents and trashed=false`,
    fields: 'files(id)',
  });
  if (res.data.files.length === 0) { driveStateFileId = null; return; }
  driveStateFileId = res.data.files[0].id;
  const content = await driveApi.files.get(
    { fileId: driveStateFileId, alt: 'media' },
    { responseType: 'json' }
  );
  driveAppState = {
    reportedTxIds: {},
    categoryPrefs: null,
    receipts: {},
    ...content.data,
  };
}

async function saveState() {
  const folderId = await getDriveFolder();
  const body = JSON.stringify(driveAppState);
  if (driveStateFileId) {
    await driveApi.files.update({
      fileId: driveStateFileId,
      media: { mimeType: 'application/json', body },
    });
  } else {
    const created = await driveApi.files.create({
      requestBody: { name: 'state.json', parents: [folderId] },
      media: { mimeType: 'application/json', body },
      fields: 'id',
    });
    driveStateFileId = created.data.id;
  }
}

// Called by every Drive endpoint — initialises folder + state once, then caches
async function ensureDriveReady() {
  if (!driveInitPromise) {
    driveInitPromise = getDriveFolder()
      .then(() => loadState())
      .catch(err => {
        driveInitPromise = null; // allow retry on next request
        throw err;
      });
  }
  return driveInitPromise;
}

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(session({
  secret: process.env.SESSION_SECRET || 'izzy-report-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000,
  },
}));

// JSON body parsing for Drive API endpoints (15 MB covers receipt uploads)
app.use(express.json({ limit: '15mb' }));

// ─── Auth routes ───────────────────────────────────────────────────────────────
const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

app.get('/auth/login', (req, res) => {
  const client = makeOAuthClient();
  res.redirect(client.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent' }));
});

app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect('/?setup_error=' + encodeURIComponent(error));
  try {
    const client = makeOAuthClient();
    const { tokens } = await client.getToken(code);
    oauthClient.setCredentials(tokens);
    googleReady = true;
    driveInitPromise = null; // reset so the new credentials are used
    console.log('OAuth success. refresh_token present:', !!tokens.refresh_token);
    res.send(buildSetupDonePage(tokens.refresh_token || ''));
  } catch (e) {
    const googleError = e.response?.data;
    console.error('OAuth callback failed:', JSON.stringify(googleError || e.message));
    const detail = googleError?.error_description || googleError?.error || e.message;
    res.redirect('/?setup_error=' + encodeURIComponent(detail));
  }
});

function buildSetupDonePage(rt) {
  const noToken = !rt;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/>
<title>Google Drive connected</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; background: #f5f4f0; color: #1a1916; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 1rem; }
  .card { background: white; border-radius: 12px; padding: 2rem; max-width: 560px; width: 100%; box-shadow: 0 1px 4px rgba(0,0,0,.1); }
  h2 { font-size: 20px; margin-bottom: 0.5rem; }
  .green { color: #2d5a3d; }
  p { font-size: 14px; color: #444; line-height: 1.6; }
  .step { background: #fefce8; border: 1px solid #fde047; border-radius: 8px; padding: 1.25rem; margin: 1.25rem 0; }
  .step h3 { font-size: 14px; font-weight: 600; margin-bottom: 0.75rem; }
  .step ol { padding-left: 1.25rem; font-size: 13px; color: #333; line-height: 2; }
  .step code { background: #f5f4f0; border: 1px solid #ddd; border-radius: 4px; padding: 1px 5px; font-family: monospace; font-size: 12px; }
  .token-box { position: relative; margin: 0.5rem 0; }
  textarea { width: 100%; font-family: monospace; font-size: 12px; background: #f5f4f0; border: 1px solid #ccc; border-radius: 6px; padding: 8px; resize: none; }
  .copy-btn { position: absolute; top: 6px; right: 6px; font-size: 12px; padding: 3px 10px; border: 1px solid #ccc; border-radius: 4px; background: white; cursor: pointer; }
  .copy-btn:hover { background: #f0f0f0; }
  .warn-box { background: #fef2f2; border: 1px solid #fca5a5; border-radius: 8px; padding: 1rem; margin: 1rem 0; font-size: 13px; }
  .btn { display: inline-block; margin-top: 1.25rem; padding: 10px 20px; background: #2d5a3d; color: white; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 500; }
  .btn:hover { background: #1d3d29; }
</style>
</head><body><div class="card">
<h2><span class="green">✓</span> Google Drive connected</h2>
<p style="margin-top:0.5rem;">${noToken ? 'Sign-in worked but no refresh token was returned — see below.' : 'Sign-in worked. Save the refresh token so the app stays connected after restarts.'}</p>
${noToken ? `
<div class="warn-box">
  <strong>No refresh token returned.</strong> This happens when the app was previously authorised.
  Go to <a href="https://myaccount.google.com/permissions" target="_blank">myaccount.google.com/permissions</a>,
  remove <strong>Izzy Report Tool</strong>, then <a href="/auth/login">sign in again</a>.
</div>` : `
<div class="step">
  <h3>Do this now — before navigating away</h3>
  <ol>
    <li>Copy the token below</li>
    <li>Render dashboard → your service → <strong>Environment</strong></li>
    <li>Add variable: <code>GOOGLE_REFRESH_TOKEN</code> = the token</li>
    <li>Save Changes → Render redeploys automatically</li>
  </ol>
  <div class="token-box" style="margin-top:0.75rem;">
    <textarea id="rt" rows="3" readonly onclick="this.select()">${rt}</textarea>
    <button class="copy-btn" onclick="navigator.clipboard.writeText(document.getElementById('rt').value).then(()=>{this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',2000)})">Copy</button>
  </div>
</div>`}
<a href="/" class="btn">Open the app →</a>
</div></body></html>`;
}

app.get('/auth/logout', (req, res) => res.redirect('/'));

// ─── Status + debug endpoints ──────────────────────────────────────────────────
app.get('/api/auth/status', (req, res) => {
  res.json({ configured: googleReady });
});

app.get('/auth/debug', (req, res) => {
  const cid = process.env.GOOGLE_CLIENT_ID;
  const cs  = process.env.GOOGLE_CLIENT_SECRET;
  const ru  = process.env.GOOGLE_REDIRECT_URI;
  res.json({
    GOOGLE_CLIENT_ID:     cid ? cid.slice(0, 24) + '…' : 'NOT SET',
    GOOGLE_CLIENT_SECRET: cs  ? `SET (length ${cs.length}, starts "${cs.slice(0,4)}")` : 'NOT SET',
    GOOGLE_REDIRECT_URI:  ru  || 'NOT SET',
    GOOGLE_REFRESH_TOKEN: process.env.GOOGLE_REFRESH_TOKEN ? 'SET' : 'not set',
    googleReady,
  });
});

// ─── Drive API middleware ──────────────────────────────────────────────────────
function requireDrive(req, res, next) {
  if (!googleReady) return res.status(401).json({ error: 'Google Drive not configured — admin must sign in first' });
  next();
}

// ─── Drive endpoints ───────────────────────────────────────────────────────────

// Initialise: find/create folder, load state, return state to client
app.get('/api/drive/init', requireDrive, async (req, res) => {
  try {
    await ensureDriveReady();
    res.json({ state: driveAppState });
  } catch (e) {
    console.error('Drive init error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Save full state object
app.post('/api/drive/state', requireDrive, async (req, res) => {
  try {
    await ensureDriveReady();
    driveAppState = req.body;
    await saveState();
    res.json({ ok: true });
  } catch (e) {
    console.error('Save state error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Upload or replace a receipt
app.post('/api/drive/receipt/:txId', requireDrive, async (req, res) => {
  try {
    await ensureDriveReady();
    const { txId } = req.params;
    const { dataUrl, filename } = req.body;

    const [header, b64] = dataUrl.split(',');
    const mime = header.split(':')[1].split(';')[0];
    const buf  = Buffer.from(b64, 'base64');
    const folderId = await getDriveFolder();

    const existingFileId = driveAppState.receipts?.[txId]?.fileId;
    let fileId;

    if (existingFileId) {
      await driveApi.files.update({ fileId: existingFileId, media: { mimeType: mime, body: buf } });
      fileId = existingFileId;
    } else {
      const created = await driveApi.files.create({
        requestBody: { name: `receipt_${txId}_${filename}`, parents: [folderId] },
        media: { mimeType: mime, body: buf },
        fields: 'id',
      });
      fileId = created.data.id;
    }

    if (!driveAppState.receipts) driveAppState.receipts = {};
    driveAppState.receipts[txId] = { fileId, filename, mime };
    await saveState();
    res.json({ fileId });
  } catch (e) {
    console.error('Receipt upload error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Return a receipt as a base64 data URL
app.get('/api/drive/receipt/:txId', requireDrive, async (req, res) => {
  try {
    await ensureDriveReady();
    const entry = driveAppState.receipts?.[req.params.txId];
    if (!entry) return res.status(404).json({ error: 'No receipt for this transaction' });

    const stream = await driveApi.files.get(
      { fileId: entry.fileId, alt: 'media' },
      { responseType: 'stream' }
    );
    const chunks = [];
    await new Promise((resolve, reject) => {
      stream.data.on('data', c => chunks.push(c));
      stream.data.on('end', resolve);
      stream.data.on('error', reject);
    });
    const mime = entry.mime || 'image/jpeg';
    res.json({ dataUrl: `data:${mime};base64,${Buffer.concat(chunks).toString('base64')}` });
  } catch (e) {
    console.error('Receipt get error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Delete a receipt
app.delete('/api/drive/receipt/:txId', requireDrive, async (req, res) => {
  try {
    await ensureDriveReady();
    const entry = driveAppState.receipts?.[req.params.txId];
    if (entry) {
      try { await driveApi.files.delete({ fileId: entry.fileId }); } catch (_) {}
      delete driveAppState.receipts[req.params.txId];
      await saveState();
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('Receipt delete error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Create a Google Doc from HTML (receipt annex)
app.post('/api/drive/doc', requireDrive, async (req, res) => {
  try {
    await ensureDriveReady();
    const { title, htmlContent } = req.body;
    const folderId = await getDriveFolder();
    const created = await driveApi.files.create({
      requestBody: {
        name: title,
        parents: [folderId],
        mimeType: 'application/vnd.google-apps.document',
      },
      media: { mimeType: 'text/html', body: htmlContent },
      fields: 'id,webViewLink',
    });
    res.json({ webViewLink: created.data.webViewLink });
  } catch (e) {
    console.error('Doc creation error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Quick connectivity check
app.get('/api/drive/test', requireDrive, async (req, res) => {
  try {
    const r = await driveApi.about.get({ fields: 'user' });
    res.json({ ok: true, user: r.data.user });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Static files ──────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Izzy Report running on port ${PORT}`);
  const cid = process.env.GOOGLE_CLIENT_ID;
  const cs  = process.env.GOOGLE_CLIENT_SECRET;
  const ru  = process.env.GOOGLE_REDIRECT_URI;
  console.log(`  CLIENT_ID:     ${cid ? cid.slice(0, 24) + '…' : 'NOT SET ⚠'}`);
  console.log(`  CLIENT_SECRET: ${cs  ? `SET (length ${cs.length})` : 'NOT SET ⚠'}`);
  console.log(`  REDIRECT_URI:  ${ru  || 'NOT SET ⚠'}`);
  if (!googleReady) console.log('  Google Drive not configured — visit /auth/login to connect.');
});
