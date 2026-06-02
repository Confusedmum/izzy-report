require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { google } = require('googleapis');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const FOLDER_NAME = 'Izzy Report Tool';
const TIMEOUT_MS = 30_000;

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

// Get a fresh access token — oauthClient handles refresh automatically
async function getToken() {
  const { token } = await oauthClient.getAccessToken();
  if (!token) throw new Error('Could not get access token. Check GOOGLE_REFRESH_TOKEN env var.');
  return token;
}

// Drive fetch helper — uses fetch() with a timeout, same as the confirmed-working
// /api/drive/test endpoint. All Drive API calls go through here.
async function driveFetch(url, opts = {}) {
  const token = await getToken();
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      ...opts.headers,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.status.toString());
    throw new Error(`Drive API ${res.status}: ${text}`);
  }
  return res;
}

async function driveFetchJson(url, opts = {}) {
  const res = await driveFetch(url, opts);
  return res.json();
}

// ─── Server-side Drive state ────────────────────────────────────────────────────
let driveFolderId    = null;
let driveStateFileId = null;
let driveAppState    = { reportedTxIds: {}, categoryPrefs: null, receipts: {} };
let driveInitPromise = null;

async function getDriveFolder() {
  if (driveFolderId) return driveFolderId;

  const q = encodeURIComponent(
    `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
  );
  const data = await driveFetchJson(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`
  );

  if (data.files?.length > 0) {
    driveFolderId = data.files[0].id;
    console.log('Found Drive folder:', driveFolderId);
  } else {
    const created = await driveFetchJson('https://www.googleapis.com/drive/v3/files?fields=id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
    });
    driveFolderId = created.id;
    console.log('Created Drive folder:', driveFolderId);
  }
  return driveFolderId;
}

async function loadState() {
  const folderId = await getDriveFolder();
  const q = encodeURIComponent(`name='state.json' and '${folderId}' in parents and trashed=false`);
  const data = await driveFetchJson(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`
  );

  if (!data.files?.length) { driveStateFileId = null; return; }

  driveStateFileId = data.files[0].id;
  const res = await driveFetch(
    `https://www.googleapis.com/drive/v3/files/${driveStateFileId}?alt=media`
  );
  const loaded = await res.json().catch(() => ({}));
  driveAppState = { reportedTxIds: {}, categoryPrefs: null, receipts: {}, ...loaded };
  console.log('Loaded state.json, receipts:', Object.keys(driveAppState.receipts || {}).length);
}

async function saveState() {
  const folderId = await getDriveFolder();
  const body = JSON.stringify(driveAppState);

  if (driveStateFileId) {
    await driveFetch(
      `https://www.googleapis.com/upload/drive/v3/files/${driveStateFileId}?uploadType=media`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body }
    );
  } else {
    const form = new FormData();
    form.append('metadata', new Blob(
      [JSON.stringify({ name: 'state.json', parents: [folderId] })],
      { type: 'application/json' }
    ));
    form.append('file', new Blob([body], { type: 'application/json' }));
    const created = await driveFetchJson(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
      { method: 'POST', body: form }
    );
    driveStateFileId = created.id;
    console.log('Created state.json:', driveStateFileId);
  }
}

// Initialize once; reset on error so the next request retries
async function ensureDriveReady() {
  if (!driveInitPromise) {
    driveInitPromise = getDriveFolder()
      .then(() => loadState())
      .catch(err => {
        driveInitPromise = null;
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
    driveInitPromise = null;
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
  .warn-box { background: #fef2f2; border: 1px solid #fca5a5; border-radius: 8px; padding: 1rem; margin: 1rem 0; font-size: 13px; }
  .btn { display: inline-block; margin-top: 1.25rem; padding: 10px 20px; background: #2d5a3d; color: white; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 500; }
</style>
</head><body><div class="card">
<h2><span class="green">✓</span> Google Drive connected</h2>
<p style="margin-top:0.5rem;">${noToken ? 'Sign-in worked but no refresh token was returned — see below.' : 'Sign-in worked. Save the refresh token so the app stays connected after restarts.'}</p>
${noToken ? `<div class="warn-box"><strong>No refresh token returned.</strong> Go to <a href="https://myaccount.google.com/permissions" target="_blank">myaccount.google.com/permissions</a>, remove <strong>Izzy Report Tool</strong>, then <a href="/auth/login">sign in again</a>.</div>` : `
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

// ─── Status + debug ────────────────────────────────────────────────────────────
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
    GOOGLE_REFRESH_TOKEN: process.env.GOOGLE_REFRESH_TOKEN ? 'SET' : 'NOT SET',
    googleReady,
  });
});

// ─── Drive middleware ──────────────────────────────────────────────────────────
function requireDrive(req, res, next) {
  if (!googleReady) return res.status(401).json({ error: 'Google Drive not configured — admin must sign in first' });
  next();
}

// ─── Drive endpoints ───────────────────────────────────────────────────────────

app.get('/api/drive/init', requireDrive, async (req, res) => {
  try {
    console.log('Drive init request');
    await ensureDriveReady();
    res.json({ state: driveAppState });
  } catch (e) {
    console.error('Drive init error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

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

app.post('/api/drive/receipt/:txId', requireDrive, async (req, res) => {
  try {
    await ensureDriveReady();
    const { txId } = req.params;
    const { dataUrl, filename } = req.body;

    const [header, b64] = dataUrl.split(',');
    const mime = header.split(':')[1].split(';')[0];
    const buf  = Buffer.from(b64, 'base64');
    const folderId = await getDriveFolder();
    const existingId = driveAppState.receipts?.[txId]?.fileId;

    let fileId;
    if (existingId) {
      await driveFetch(
        `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=media`,
        { method: 'PATCH', headers: { 'Content-Type': mime }, body: buf }
      );
      fileId = existingId;
    } else {
      const form = new FormData();
      form.append('metadata', new Blob(
        [JSON.stringify({ name: `receipt_${txId}_${filename}`, parents: [folderId] })],
        { type: 'application/json' }
      ));
      form.append('file', new Blob([buf], { type: mime }));
      const created = await driveFetchJson(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
        { method: 'POST', body: form }
      );
      fileId = created.id;
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

app.get('/api/drive/receipt/:txId', requireDrive, async (req, res) => {
  try {
    await ensureDriveReady();
    const entry = driveAppState.receipts?.[req.params.txId];
    if (!entry) return res.status(404).json({ error: 'No receipt for this transaction' });

    const fileRes = await driveFetch(
      `https://www.googleapis.com/drive/v3/files/${entry.fileId}?alt=media`
    );
    const buf = Buffer.from(await fileRes.arrayBuffer());
    const mime = entry.mime || 'image/jpeg';
    res.json({ dataUrl: `data:${mime};base64,${buf.toString('base64')}` });
  } catch (e) {
    console.error('Receipt get error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/drive/receipt/:txId', requireDrive, async (req, res) => {
  try {
    await ensureDriveReady();
    const entry = driveAppState.receipts?.[req.params.txId];
    if (entry) {
      try {
        await driveFetch(`https://www.googleapis.com/drive/v3/files/${entry.fileId}`, { method: 'DELETE' });
      } catch (_) {}
      delete driveAppState.receipts[req.params.txId];
      await saveState();
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('Receipt delete error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/drive/doc', requireDrive, async (req, res) => {
  try {
    await ensureDriveReady();
    const { title, htmlContent } = req.body;
    const folderId = await getDriveFolder();
    const form = new FormData();
    form.append('metadata', new Blob(
      [JSON.stringify({ name: title, parents: [folderId], mimeType: 'application/vnd.google-apps.document' })],
      { type: 'application/json' }
    ));
    form.append('file', new Blob([htmlContent], { type: 'text/html' }));
    const created = await driveFetchJson(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink',
      { method: 'POST', body: form }
    );
    res.json({ webViewLink: created.webViewLink });
  } catch (e) {
    console.error('Doc creation error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Connectivity check — same fetch() approach as everything else
app.get('/api/drive/test', requireDrive, async (req, res) => {
  try {
    const data = await driveFetchJson('https://www.googleapis.com/drive/v3/about?fields=user');
    res.json({ ok: true, user: data.user });
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
