# Izzy Report Tool

Hosted at: https://confusedmum.github.io/izzy-report

## Setup steps after uploading to GitHub

### 1. Enable GitHub Pages
- Go to your repo Settings → Pages
- Set Branch to `main`, folder to `/ (root)`
- Click Save

### 2. Add authorised domain to Google Cloud
- Go to console.cloud.google.com
- APIs & Services → Credentials → your OAuth client
- Under Authorised JavaScript origins, confirm `https://confusedmum.github.io` is listed
- Save

### 3. Add yourself as a test user
- APIs & Services → OAuth consent screen → Test users
- Add your Google account email
- Save

### 4. Share with support workers
- Send them the URL: https://confusedmum.github.io/izzy-report
- They sign in with your shared Google account
- They land on worker view automatically (Izzy's Starling only, receipt attachment only)
- You enter PIN 190968 to unlock full access

## Files
- `index.html` — main app
- `config.js` — budget IDs, Google client ID, PIN
- `drive.js` — Google Drive helper functions

## Google Drive folder
The tool creates a folder called "Izzy Report Tool" in your Drive automatically.
Inside it stores:
- `state.json` — category prefs, reported transaction history, receipt index
- Receipt images named `receipt_{txId}_{filename}`
- Generated Google Docs (receipt annexes)

## Updating
To change budget IDs, categories, or the PIN, edit `config.js` and re-upload to GitHub.
