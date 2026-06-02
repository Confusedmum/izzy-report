require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { google } = require('googleapis');
const { createProxyMiddleware } = require('http-proxy-middleware');
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
  const { token, expiry_date } = await oauthClient.getAccessToken();
  cachedToken = token;
  tokenExpiry = expiry_date ?? Date.now() + 55 * 60 * 1000;
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
    if (tokens.refresh_token) {
      req.session.newRefreshToken = tokens.refresh_token;
    }
    res.redirect('/auth/setup-done');
  } catch (e) {
    res.redirect('/?setup_error=' + encodeURIComponent('OAuth failed: ' + e.message));
  }
});

app.get('/auth/setup-done', (req, res) => {
  const rt = req.session.newRefreshToken || '';
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"/>
<title>Setup complete</title>
<style>body{font-family:system-ui,sans-serif;max-width:600px;margin:3rem auto;padding:1rem;line-height:1.6;}
code{background:#f5f4f0;padding:2px 6px;border-radius:4px;font-size:13px;}
textarea{width:100%;font-family:monospace;font-size:12px;background:#f5f4f0;border:1px solid #ddd;border-radius:6px;padding:8px;}
.box{background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:1rem;margin:1rem 0;}
.warn{background:#fefce8;border:1px solid #fde047;border-radius:8px;padding:1rem;margin:1rem 0;}
a{color:#2d5a3d;}</style>
</head><body>
<h2>✓ Google Drive connected</h2>
<div class="box"><p>The app is now connected to Google Drive and ready to use.</p></div>
${rt ? `<div class="warn">
<p><strong>Save this refresh token as an environment variable</strong> so the connection survives server restarts and redeployments:</p>
<p>Variable name: <code>GOOGLE_REFRESH_TOKEN</code></p>
<textarea rows="3" onclick="this.select()">${rt}</textarea>
<p style="font-size:13px;color:#666;">On Render: Dashboard → Environment → add the variable, then redeploy.<br/>
On Railway: Variables → add the variable (auto-redeployed).</p>
</div>` : ''}
<p><a href="/">← Open the app</a></p>
</body></html>`);
});

app.get('/auth/logout', (req, res) => {
  // Shared auth — nothing to clear server-side for workers
  // Just redirect home; client resets its state on page load
  res.redirect('/');
});

// ─── Status endpoint ───────────────────────────────────────────────────────────
app.get('/api/auth/status', (req, res) => {
  res.json({ configured: googleReady });
});

// ─── Google API proxy ──────────────────────────────────────────────────────────
async function requireGoogleAuth(req, res, next) {
  if (!googleReady) return res.status(401).json({ error: 'Google Drive not configured. Admin must sign in first.' });
  try {
    req.googleToken = await getFreshToken();
    next();
  } catch (e) {
    res.status(401).json({ error: 'Token refresh failed: ' + e.message });
  }
}

const googleProxy = createProxyMiddleware({
  target: 'https://www.googleapis.com',
  changeOrigin: true,
  pathRewrite: { '^/api/google': '' },
  on: {
    proxyReq(proxyReq, req) {
      proxyReq.setHeader('Authorization', 'Bearer ' + req.googleToken);
    },
    error(err, req, res) {
      if (!res.headersSent) res.status(502).json({ error: 'Proxy error: ' + err.message });
    }
  }
});

app.use('/api/google', requireGoogleAuth, googleProxy);

// ─── Static files ──────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Izzy Report running on http://localhost:${PORT}`);
  if (!googleReady) console.log('  ⚠  Google not configured — visit /auth/login to connect.');
});
