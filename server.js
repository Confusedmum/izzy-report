require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { google } = require('googleapis');
const path = require('path');
const PDFDocument = require('pdfkit');
const sharp = require('sharp');

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

// Get a fresh access token — oauthClient handles refresh automatically.
// If the refresh token itself is invalid (invalid_grant), mark Drive as
// unconfigured so the admin is prompted to re-auth rather than retrying forever.
async function getToken() {
  try {
    const { token } = await oauthClient.getAccessToken();
    if (!token) throw new Error('Could not get access token. Check GOOGLE_REFRESH_TOKEN env var.');
    return token;
  } catch (e) {
    const msg = (e.message || '') + JSON.stringify(e.response?.data || {});
    if (msg.includes('invalid_grant') || msg.includes('Token has been expired or revoked')) {
      googleReady = false;
      driveInitPromise = null;
      console.error('Refresh token is invalid — admin must reconnect at /auth/login');
      throw new Error('Google Drive authorization has expired. An admin must visit /auth/login to reconnect.');
    }
    throw e;
  }
}

// Drive fetch helper — uses fetch() with a timeout. On a 401 (access token
// expired mid-flight) it forces a token refresh and retries once before giving up.
async function driveFetch(url, opts = {}, _retried = false) {
  const token = await getToken();
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      ...opts.headers,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (res.status === 401 && !_retried) {
    console.log('Drive API returned 401 — forcing token refresh and retrying...');
    try {
      await oauthClient.refreshAccessToken();
    } catch (e) {
      const msg = (e.message || '') + JSON.stringify(e.response?.data || {});
      if (msg.includes('invalid_grant') || msg.includes('Token has been expired or revoked')) {
        googleReady = false;
        driveInitPromise = null;
        console.error('Refresh token rejected during 401 retry — admin must reconnect at /auth/login');
        throw new Error('Google Drive authorization has expired. An admin must visit /auth/login to reconnect.');
      }
      throw e;
    }
    return driveFetch(url, opts, true);
  }

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

// ─── Receipt folder cache ─────────────────────────────────────────────────────
const RECEIPTS_FOLDER_NAME = 'Izzy Report Receipts';
let driveReceiptsFolderId = null;
const driveMonthFolderIds = {}; // { 'June 2026': 'folder-id', ... }

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MIME_EXT    = { 'image/jpeg':'.jpg','image/png':'.png','image/gif':'.gif','image/webp':'.webp','image/heic':'.heic','image/heif':'.heif' };

function getMonthLabel(txDate) {
  if (!txDate || !/^\d{4}-\d{2}-\d{2}$/.test(txDate)) return 'Unknown';
  const [year, month] = txDate.split('-');
  return `${MONTH_NAMES[parseInt(month, 10) - 1]} ${year}`;
}

function formatReceiptFilename(payee, txDate, mime) {
  const clean = (payee || 'Unknown').replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim() || 'Unknown';
  let datePart = '';
  if (txDate && /^\d{4}-\d{2}-\d{2}$/.test(txDate)) {
    const [year, month, day] = txDate.split('-');
    datePart = `${day}${month}${year}`;
  }
  const ext = MIME_EXT[mime] || '';
  return datePart ? `${clean} ${datePart}${ext}` : `${clean}${ext}`;
}

async function getOrCreateReceiptsFolder() {
  if (driveReceiptsFolderId) return driveReceiptsFolderId;
  const q = encodeURIComponent(
    `name='${RECEIPTS_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
  );
  const data = await driveFetchJson(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&orderBy=createdTime+asc`);
  if (data.files?.length > 0) {
    driveReceiptsFolderId = data.files[0].id;
    console.log('Found receipts folder:', driveReceiptsFolderId);
  } else {
    const created = await driveFetchJson('https://www.googleapis.com/drive/v3/files?fields=id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: RECEIPTS_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
    });
    driveReceiptsFolderId = created.id;
    console.log('Created receipts folder:', driveReceiptsFolderId);
  }
  return driveReceiptsFolderId;
}

async function getOrCreateMonthFolder(parentId, monthLabel) {
  if (driveMonthFolderIds[monthLabel]) return driveMonthFolderIds[monthLabel];
  const q = encodeURIComponent(
    `name='${monthLabel}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`
  );
  const data = await driveFetchJson(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&orderBy=createdTime+asc`);
  if (data.files?.length > 0) {
    driveMonthFolderIds[monthLabel] = data.files[0].id;
    console.log(`Found month folder "${monthLabel}":`, driveMonthFolderIds[monthLabel]);
  } else {
    const created = await driveFetchJson('https://www.googleapis.com/drive/v3/files?fields=id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: monthLabel, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }),
    });
    driveMonthFolderIds[monthLabel] = created.id;
    console.log(`Created month folder "${monthLabel}":`, driveMonthFolderIds[monthLabel]);
  }
  return driveMonthFolderIds[monthLabel];
}

// ─── Revolut Google Sheet ──────────────────────────────────────────────────────
const REVOLUT_SHEET_NAME = 'Revolut Reimbursement 2026';
let revolutSheetId = null;

async function getOrCreateRevolutSheet() {
  if (revolutSheetId) return revolutSheetId;
  const receiptsFolderId = await getOrCreateReceiptsFolder();
  const q = encodeURIComponent(
    `name='${REVOLUT_SHEET_NAME}' and '${receiptsFolderId}' in parents and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`
  );
  const data = await driveFetchJson(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`
  );
  if (data.files?.length > 0) {
    revolutSheetId = data.files[0].id;
    console.log('Found Revolut sheet:', revolutSheetId);
  } else {
    const created = await driveFetchJson(
      'https://www.googleapis.com/drive/v3/files?fields=id',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: REVOLUT_SHEET_NAME,
          mimeType: 'application/vnd.google-apps.spreadsheet',
          parents: [receiptsFolderId],
        }),
      }
    );
    revolutSheetId = created.id;
    console.log('Created Revolut sheet:', revolutSheetId);
  }
  return revolutSheetId;
}

async function getOrCreateSheetTab(spreadsheetId, tabTitle) {
  const data = await driveFetchJson(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`
  );
  const existing = data.sheets?.find(s => s.properties.title === tabTitle);
  if (existing) return existing.properties.sheetId;

  const result = await driveFetchJson(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{ addSheet: { properties: { title: tabTitle } } }],
      }),
    }
  );
  return result.replies[0].addSheet.properties.sheetId;
}

async function getDriveFolder() {
  if (driveFolderId) return driveFolderId;

  const q = encodeURIComponent(
    `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
  );
  const data = await driveFetchJson(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&orderBy=createdTime+asc`
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
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&orderBy=modifiedTime+desc`
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
// NOTE: spreadsheets scope was added later — existing refresh tokens won't have
// it. The admin must re-auth at /auth/login once to get a new token.
const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/spreadsheets',
];

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
    // Only accept reportedTxIds and categoryPrefs from the client.
    // Receipts are managed exclusively by the receipt upload/delete endpoints
    // and must not be overwritten by a client state-sync that may have a stale
    // view of receipts (e.g. loaded before a receipt was uploaded this session).
    const { reportedTxIds, categoryPrefs } = req.body;
    driveAppState = {
      ...driveAppState,
      ...(reportedTxIds !== undefined && { reportedTxIds }),
      ...(categoryPrefs !== undefined && { categoryPrefs }),
    };
    await saveState();
    res.json({ ok: true });
  } catch (e) {
    console.error('Save state error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/debug/state', (req, res) => {
  res.json({
    googleReady,
    driveFolderId,
    driveStateFileId,
    receiptsCount: Object.keys(driveAppState.receipts || {}).length,
    receiptTxIds: Object.keys(driveAppState.receipts || {}),
    reportedTxCount: Object.keys(driveAppState.reportedTxIds || {}).length,
    hasCategoryPrefs: !!driveAppState.categoryPrefs,
    categoryPrefCount: driveAppState.categoryPrefs?.length ?? 0,
  });
});

app.post('/api/drive/receipt/:txId', requireDrive, async (req, res) => {
  try {
    await ensureDriveReady();
    const { txId } = req.params;
    const { dataUrl, payee, txDate } = req.body;

    const [header, b64] = dataUrl.split(',');
    const mime = header.split(':')[1].split(';')[0];
    const buf  = Buffer.from(b64, 'base64');

    const receiptFilename = formatReceiptFilename(payee, txDate, mime);
    const monthLabel      = getMonthLabel(txDate);
    const receiptsFolderId = await getOrCreateReceiptsFolder();
    const monthFolderId    = await getOrCreateMonthFolder(receiptsFolderId, monthLabel);

    const existingId = driveAppState.receipts?.[txId]?.fileId;
    let fileId;
    if (existingId) {
      // Update file content
      await driveFetch(
        `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=media`,
        { method: 'PATCH', headers: { 'Content-Type': mime }, body: buf }
      );
      // Update filename in metadata
      await driveFetchJson(
        `https://www.googleapis.com/drive/v3/files/${existingId}?fields=id`,
        { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: receiptFilename }) }
      );
      fileId = existingId;
    } else {
      const form = new FormData();
      form.append('metadata', new Blob(
        [JSON.stringify({ name: receiptFilename, parents: [monthFolderId] })],
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
    driveAppState.receipts[txId] = { fileId, filename: receiptFilename, mime };
    await saveState();
    res.json({ fileId, filename: receiptFilename });
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

// ─── Revolut Summary → Google Sheet ───────────────────────────────────────────
// Body: { month: "June 2026", rows: [{ values: [...], bold: bool }, ...] }
// Finds/creates the spreadsheet in the Receipts folder, finds/creates the month
// tab, appends all rows, then batch-formats the bold ones.
app.post('/api/sheets/revolut-summary', requireDrive, async (req, res) => {
  try {
    const { month, rows } = req.body;
    if (!month || !Array.isArray(rows) || !rows.length) {
      return res.status(400).json({ error: 'month and rows are required' });
    }

    const spreadsheetId = await getOrCreateRevolutSheet();
    const sheetId       = await getOrCreateSheetTab(spreadsheetId, month);

    // Count existing rows so we know where new data starts (for bold offsets)
    const existing = await driveFetchJson(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(month)}?fields=values`
    ).catch(() => ({ values: [] }));
    const startRowIndex = existing.values?.length || 0;

    // Append all row values in one call
    await driveFetchJson(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(month)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: rows.map(r => r.values) }),
      }
    );

    // Apply bold formatting to rows flagged bold
    const boldRequests = rows
      .map((row, i) => row.bold ? {
        repeatCell: {
          range: {
            sheetId,
            startRowIndex: startRowIndex + i,
            endRowIndex:   startRowIndex + i + 1,
          },
          cell: { userEnteredFormat: { textFormat: { bold: true } } },
          fields: 'userEnteredFormat.textFormat.bold',
        },
      } : null)
      .filter(Boolean);

    if (boldRequests.length) {
      await driveFetchJson(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requests: boldRequests }),
        }
      );
    }

    const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${sheetId}`;
    console.log(`Revolut summary written to "${month}" tab`);
    res.json({ ok: true, url });
  } catch (e) {
    console.error('Revolut summary error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Receipt PDF ──────────────────────────────────────────────────────────────
// Converts any image buffer to JPEG/PNG that pdfkit can embed.
async function normImageForPDF(buf, mime) {
  if (mime === 'image/jpeg' || mime === 'image/png') return { buf, mime };
  try {
    const out = await sharp(buf).jpeg({ quality: 88 }).toBuffer();
    return { buf: out, mime: 'image/jpeg' };
  } catch (e) {
    console.warn(`Image normalisation failed (${mime}):`, e.message);
    return null;
  }
}

// Generates an A4 PDF with a 2×2 receipt grid, page numbers, and a title on
// page 1.  Returns a Buffer.
// images: [{buf, mime, payee, date}], already normalised to JPEG/PNG.
function buildReceiptPDF(period, images) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: true });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end',  () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = 595.28, H = 841.89;
    const ML = 30, MR = 30; // left/right margins
    const MB = 36;           // bottom margin (page numbers live here)
    const TITLE_H = 58;      // vertical space reserved for title on page 1
    const MT_REST = 28;      // top margin on pages 2+
    const GAP = 8;           // gap between cells
    const LABEL_H = 26;      // height of label strip below image

    const cellW = (W - ML - MR - GAP) / 2;

    // First page: grid starts below the title block
    const gridTop1    = 30 + TITLE_H + 6;
    const cellH1      = (H - gridTop1 - MB - GAP) / 2;

    // Other pages: grid starts at top margin
    const gridTopRest = MT_REST;
    const cellHRest   = (H - gridTopRest - MB - GAP) / 2;

    const totalPages = Math.ceil(images.length / 4);
    const genDate    = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

    function drawPageChrome(pageNum, isFirst) {
      if (isFirst) {
        doc.font('Helvetica-Bold').fontSize(16).fillColor('#1a1916')
           .text(`Receipt Annex — ${period}`, ML, 30, { width: W - ML - MR });
        doc.font('Helvetica').fontSize(10).fillColor('#6b6860')
           .text(`Generated ${genDate}`, ML, 52, { width: W - ML - MR });
      }
      doc.font('Helvetica').fontSize(9).fillColor('#9c9a94')
         .text(`Page ${pageNum} of ${totalPages}`, ML, H - MB + 8, { width: W - ML - MR, align: 'center' });
    }

    images.forEach((img, idx) => {
      const pageIdx   = Math.floor(idx / 4);
      const posInPage = idx % 4;
      const isFirst   = pageIdx === 0;

      if (posInPage === 0) {
        if (pageIdx > 0) doc.addPage();
        drawPageChrome(pageIdx + 1, isFirst);
      }

      const gridTop = isFirst ? gridTop1    : gridTopRest;
      const cellH   = isFirst ? cellH1      : cellHRest;
      const col     = posInPage % 2;
      const row     = Math.floor(posInPage / 2);
      const x       = ML + col * (cellW + GAP);
      const y       = gridTop + row * (cellH + GAP);
      const imgAreaH = cellH - LABEL_H - 6; // image sits above the label strip

      // Cell border
      doc.rect(x, y, cellW, cellH).strokeColor('#d1d0c8').lineWidth(0.5).stroke();

      // Image, fitted within the image area with aspect-ratio preserved
      try {
        doc.image(img.buf, x + 4, y + 4, {
          fit:    [cellW - 8, imgAreaH],
          align:  'center',
          valign: 'center',
        });
      } catch (e) {
        console.warn(`Could not embed receipt image ${idx + 1}:`, e.message);
        doc.font('Helvetica').fontSize(9).fillColor('#9c9a94')
           .text('[Image unavailable]', x + 4, y + imgAreaH / 2, { width: cellW - 8, align: 'center' });
      }

      // Label: "#N — Payee — Date"
      const label = `#${idx + 1} — ${img.payee} — ${img.date}`;
      doc.font('Helvetica').fontSize(9).fillColor('#444444')
         .text(label, x + 4, y + cellH - LABEL_H + 2, { width: cellW - 8, height: LABEL_H - 4, ellipsis: true });
    });

    doc.end();
  });
}

// Search Drive for a receipt file by payee+date when the state.json reference is missing.
// Returns { fileId, filename, mime } or null. Saves to driveAppState.receipts if found.
async function findReceiptInDriveByName(txId, payee, date) {
  const cleanPayee = (payee || '').replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
  let datePart = '';
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const [year, month, day] = date.split('-');
    datePart = `${day}${month}${year}`;
  }
  if (!cleanPayee || !datePart) return null;

  const namePrefix  = `${cleanPayee} ${datePart}`;
  const monthLabel  = getMonthLabel(date);

  try {
    const receiptsFolderId = await getOrCreateReceiptsFolder();
    const monthFolderId    = await getOrCreateMonthFolder(receiptsFolderId, monthLabel);

    // Search for any file in this month folder whose name starts with payee+date
    const q = encodeURIComponent(
      `name contains '${namePrefix}' and '${monthFolderId}' in parents and mimeType != 'application/vnd.google-apps.folder' and trashed=false`
    );
    const data = await driveFetchJson(
      `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&orderBy=createdTime+asc`
    );
    if (!data.files?.length) {
      console.warn(`Drive search for "${namePrefix}" in ${monthLabel} found nothing`);
      return null;
    }
    const file = data.files[0];
    const dot  = file.name.lastIndexOf('.');
    const ext  = dot !== -1 ? file.name.slice(dot) : '';
    const mime = Object.entries(MIME_EXT).find(([, e]) => e === ext)?.[0] || 'image/jpeg';
    const found = { fileId: file.id, filename: file.name, mime };
    console.log(`Recovered receipt for txId ${txId}: ${file.name} (${file.id})`);
    // Persist the recovered reference so subsequent requests use the cache
    if (!driveAppState.receipts) driveAppState.receipts = {};
    driveAppState.receipts[txId] = found;
    await saveState().catch(e => console.warn('Could not save recovered receipt state:', e.message));
    return found;
  } catch (e) {
    console.warn(`Drive search failed for "${namePrefix}":`, e.message);
    return null;
  }
}

// POST /api/drive/receipt-pdf
// Body: { period: "June 2026", entries: [{txId, payee, date}, ...] }
// Fetches each receipt from Drive, generates an A4 PDF, uploads it to the
// monthly subfolder under Izzy Report Receipts, returns { webViewLink }.
app.post('/api/drive/receipt-pdf', requireDrive, async (req, res) => {
  try {
    await ensureDriveReady();
    const { period, entries } = req.body;
    if (!period || !Array.isArray(entries) || !entries.length) {
      return res.status(400).json({ error: 'period and entries are required' });
    }

    // Pre-warm the folder cache so parallel receipt lookups don't race each other
    // into creating duplicate folders.
    const receiptsFolderId = await getOrCreateReceiptsFolder();
    const monthFolderId    = await getOrCreateMonthFolder(receiptsFolderId, period);

    // Fetch and normalise all receipt images in parallel to avoid sequential
    // Drive round-trips that would blow Render's 30-second request timeout.
    const results = await Promise.all(entries.map(async ({ txId, payee, date }) => {
      try {
        let receipt = driveAppState.receipts?.[txId];
        if (!receipt?.fileId) {
          // State reference missing — search Drive by filename (PayeeName DDMMYYYY)
          receipt = await findReceiptInDriveByName(txId, payee, date);
        }
        if (!receipt?.fileId) return { ok: false, payee };

        const fileRes = await driveFetch(
          `https://www.googleapis.com/drive/v3/files/${receipt.fileId}?alt=media`
        );
        const rawBuf = Buffer.from(await fileRes.arrayBuffer());
        const mime   = receipt.mime || 'image/jpeg';
        const normed = await normImageForPDF(rawBuf, mime);
        if (!normed) return { ok: false, payee };
        return { ok: true, buf: normed.buf, mime: normed.mime, payee: payee || 'Unknown', date: date || '' };
      } catch (e) {
        console.warn(`Could not load receipt for ${payee}:`, e.message);
        return { ok: false, payee };
      }
    }));

    const images  = results.filter(r => r.ok);
    const missing = results.filter(r => !r.ok).map(r => r.payee).filter(Boolean);

    if (!images.length) {
      const detail = missing.length ? ` Searched Drive for: ${missing.join(', ')}.` : '';
      return res.status(400).json({ error: `No receipt images could be loaded from Drive.${detail} Check that receipt files exist in the "Izzy Report Receipts / ${period}" folder.` });
    }

    console.log(`Generating receipt PDF for "${period}" with ${images.length} image(s)…`);
    const pdfBuf = await buildReceiptPDF(period, images);
    const pdfName          = `Izzy Receipts — ${period}.pdf`;

    const form = new FormData();
    form.append('metadata', new Blob(
      [JSON.stringify({ name: pdfName, parents: [monthFolderId] })],
      { type: 'application/json' }
    ));
    form.append('file', new Blob([pdfBuf], { type: 'application/pdf' }));
    const created = await driveFetchJson(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink',
      { method: 'POST', body: form }
    );

    console.log('Receipt PDF uploaded:', created.id);
    res.json({ webViewLink: created.webViewLink });
  } catch (e) {
    console.error('Receipt PDF error:', e.message);
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
