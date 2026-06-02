require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { google } = require('googleapis');
const https = require('https');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

function makeOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

// Shared OAuth client — holds the refresh token for all users of the app
const oauthClient = makeOAuthClient();
let googleReady = false;

if (process.env.GOOGLE_REFRESH_TOKEN) {
  oauthClient.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  googleReady = true;
}

// Token cache so we don't call Google on every proxied request
let cachedToken = null;
let tokenExpiry = 0;

async function getFreshToken() {
  if (cachedToken && tokenExpiry > Date.now() + 60_000) return cachedToken;
  const { token } = await oauthClient.getAccessToken();
  if (!token) throw new Error('No access token returned — refresh token may be invalid');
  cachedToken = token;
  // expiry_date lives on oauthClient.credentials after the call
  tokenExpiry = oauthClient.credentials.expiry_date ?? Date.now() + 55 * 60 * 1000;
  console.log('Access token refreshed, expires', new Date(tokenExpiry).toISOString());
  return token;
}

// ─── Session (only needed for the one-time setup flow) ────────────────────────
app.use(session({
  secret: process.env.SESSION_SECRET || 'izzy-report-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// ─── Auth routes ───────────────────────────────────────────────────────────────
app.get('/auth/login', (req, res) => {
  const client = makeOAuthClient();
  const url = client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'   // force refresh_token to be returned every time
  });
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect('/?setup_error=' + encodeURIComponent(error));
  try {
    const client = makeOAuthClient();
    const { tokens } = await client.getToken(code);
    oauthClient.setCredentials(tokens);
    cachedToken = tokens.access_token;
    tokenExpiry = tokens.expiry_date ?? Date.now() + 55 * 60 * 1000;
    googleReady = true;
    const rt = tokens.refresh_token || '';
    console.log('OAuth success. refresh_token present:', !!rt);
    // Render the page directly here — no redirect, no session needed
    res.send(buildSetupDonePage(rt));
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
  .ok-box { background: #f0fdf4; border: 1px solid #86efac; border-radius: 8px; padding: 1rem; margin: 1rem 0; font-size: 14px; }
  .btn { display: inline-block; margin-top: 1.25rem; padding: 10px 20px; background: #2d5a3d; color: white; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 500; }
  .btn:hover { background: #1d3d29; }
</style>
</head><body><div class="card">
<h2><span class="green">✓</span> Google Drive connected</h2>
<p style="margin-top:0.5rem;">Sign-in worked. ${noToken ? 'However, no refresh token was returned — see below.' : 'Now save your refresh token to keep the app connected permanently.'}</p>

${noToken ? `
<div class="warn-box">
  <strong>No refresh token was returned by Google.</strong><br/>
  This usually means the app was already authorised and Google skipped issuing a new one.
  To get one: go to <a href="https://myaccount.google.com/permissions" target="_blank">myaccount.google.com/permissions</a>, remove <strong>Izzy Report Tool</strong>, then <a href="/auth/login">sign in again</a>.
</div>
` : `
<div class="step">
  <h3>Do this now — before navigating away</h3>
  <ol>
    <li>Copy the token below (click the box to select all, then Cmd+C / Ctrl+C)</li>
    <li>Open your <strong>Render dashboard</strong> → your web service → <strong>Environment</strong></li>
    <li>Add a new variable: name = <code>GOOGLE_REFRESH_TOKEN</code>, value = the token</li>
    <li>Click <strong>Save Changes</strong> — Render will redeploy automatically</li>
    <li>Once redeployed, the app will stay connected without needing to sign in again</li>
  </ol>
  <div class="token-box" style="margin-top:0.75rem;">
    <textarea id="rt" rows="3" readonly onclick="this.select()">${rt}</textarea>
    <button class="copy-btn" onclick="navigator.clipboard.writeText(document.getElementById('rt').value).then(()=>{this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',2000)})">Copy</button>
  </div>
</div>
<p style="font-size:12px;color:#888;">The app is already working in this browser session. The token above is only needed so it stays connected after Render restarts or redeploys.</p>
`}

<a href="/" class="btn">Open the app →</a>
</div></body></html>`;
}

app.get('/auth/logout', (req, res) => {
  // Shared auth — nothing to clear server-side for workers
  // Just redirect home; client resets its state on page load
  res.redirect('/');
});

// ─── Status endpoint ───────────────────────────────────────────────────────────
app.get('/api/auth/status', (req, res) => {
  res.json({ configured: googleReady });
});

// ─── Debug endpoint (safe — never exposes secrets) ────────────────────────────
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

// ─── Google API proxy ──────────────────────────────────────────────────────────
async function requireGoogleAuth(req, res, next) {
  if (!googleReady) return res.status(401).json({ error: 'Google Drive not configured. Admin must sign in first.' });
  try {
    req.googleToken = await getFreshToken();
    next();
  } catch (e) {
    console.error('Token refresh failed:', e.message);
    res.status(401).json({ error: 'Token refresh failed: ' + e.message });
  }
}

// Pipe-based proxy using Node's built-in https — avoids http-proxy-middleware
// hanging issues on Render. app.use() strips /api/google from req.url; app.all() does not.
app.use('/api/google', requireGoogleAuth, (req, res) => {
  const proxyReq = https.request(
    {
      hostname: 'www.googleapis.com',
      path: req.url,   // already stripped of /api/google by Express
      method: req.method,
      headers: {
        ...req.headers,
        host: 'www.googleapis.com',
        authorization: 'Bearer ' + req.googleToken,
        // Tell Google not to compress — we pipe raw bytes straight to the browser
        // and stripping content-encoding without decompressing breaks JSON parsing.
        'accept-encoding': 'identity',
      },
      timeout: 30_000,
    },
    (proxyRes) => {
      res.status(proxyRes.statusCode);
      for (const [k, v] of Object.entries(proxyRes.headers)) {
        // Skip encoding headers — piping the raw stream handles them directly
        if (k !== 'content-encoding' && k !== 'transfer-encoding') res.setHeader(k, v);
      }
      proxyRes.pipe(res);
    }
  );

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    if (!res.headersSent) res.status(504).json({ error: 'Google API request timed out' });
  });

  proxyReq.on('error', (err) => {
    console.error('Google API proxy error:', err.message);
    if (!res.headersSent) res.status(502).json({ error: 'Proxy error: ' + err.message });
  });

  req.pipe(proxyReq);
});

// Quick Drive connectivity test — visit /api/drive/test to verify token works
app.get('/api/drive/test', requireGoogleAuth, async (req, res) => {
  try {
    const r = await fetch('https://www.googleapis.com/drive/v3/about?fields=user', {
      headers: { authorization: 'Bearer ' + req.googleToken },
    });
    const data = await r.json();
    res.json({ ok: r.ok, status: r.status, user: data.user ?? data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Static files ──────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// SPA fallback
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
