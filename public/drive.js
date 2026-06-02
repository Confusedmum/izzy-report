// Google Drive helpers — all API calls proxied through /api/google on our server.
// The server adds the Authorization header; no token is needed client-side.
const Drive = {
  folderId: null,
  stateFileId: null,
  state: { reportedTxIds: {}, categoryPrefs: null, receipts: {} },

  async init() {
    this.folderId = await this.getOrCreateFolder(CONFIG.DRIVE_FOLDER_NAME);
    await this.loadState();
  },

  // Proxy all Google API calls through our server
  async apiFetch(url, options = {}) {
    const proxyUrl = url.replace('https://www.googleapis.com/', '/api/google/');
    const res = await fetch(proxyUrl, options);
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Drive API error ${res.status}: ${err}`);
    }
    return res;
  },

  async apiJson(url, options = {}) {
    const res = await this.apiFetch(url, options);
    return res.json();
  },

  async getOrCreateFolder(name) {
    const data = await this.apiJson(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`)}&fields=files(id)`
    );
    if (data.files && data.files.length > 0) return data.files[0].id;
    const created = await this.apiJson('https://www.googleapis.com/drive/v3/files?fields=id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder' })
    });
    return created.id;
  },

  async loadState() {
    const data = await this.apiJson(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`name='state.json' and '${this.folderId}' in parents and trashed=false`)}&fields=files(id)`
    );
    if (!data.files || data.files.length === 0) { this.stateFileId = null; return; }
    this.stateFileId = data.files[0].id;
    const res = await this.apiFetch(`https://www.googleapis.com/drive/v3/files/${this.stateFileId}?alt=media`);
    try { this.state = await res.json(); } catch(e) {}
  },

  async saveState() {
    const body = JSON.stringify(this.state);
    if (this.stateFileId) {
      await this.apiFetch(`https://www.googleapis.com/upload/drive/v3/files/${this.stateFileId}?uploadType=media`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body
      });
    } else {
      const meta = await this.apiJson('https://www.googleapis.com/drive/v3/files?fields=id', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'state.json', parents: [this.folderId] })
      });
      this.stateFileId = meta.id;
      await this.apiFetch(`https://www.googleapis.com/upload/drive/v3/files/${this.stateFileId}?uploadType=media`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body
      });
    }
  },

  async uploadReceipt(txId, dataUrl, filename) {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const existingId = this.state.receipts[txId]?.fileId;
    if (existingId) {
      await this.apiFetch(`https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=media`, {
        method: 'PATCH', headers: { 'Content-Type': blob.type }, body: blob
      });
      this.state.receipts[txId] = { fileId: existingId, filename };
    } else {
      const form = new FormData();
      form.append('metadata', new Blob([JSON.stringify({ name: `receipt_${txId}_${filename}`, parents: [this.folderId] })], { type: 'application/json' }));
      form.append('file', blob);
      const up = await this.apiJson('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
        method: 'POST', body: form
      });
      this.state.receipts[txId] = { fileId: up.id, filename };
    }
    await this.saveState();
  },

  async deleteReceipt(txId) {
    const entry = this.state.receipts[txId];
    if (!entry) return;
    try { await this.apiFetch(`https://www.googleapis.com/drive/v3/files/${entry.fileId}`, { method: 'DELETE' }); } catch(e) {}
    delete this.state.receipts[txId];
    await this.saveState();
  },

  async getReceiptDataUrl(txId) {
    const entry = this.state.receipts[txId];
    if (!entry) return null;
    try {
      const res = await this.apiFetch(`https://www.googleapis.com/drive/v3/files/${entry.fileId}?alt=media`);
      const blob = await res.blob();
      return await new Promise(resolve => {
        const r = new FileReader(); r.onload = e => resolve(e.target.result); r.readAsDataURL(blob);
      });
    } catch(e) { return null; }
  },

  async markReported(txIds, period) {
    txIds.forEach(id => { this.state.reportedTxIds[id] = period; });
    return this.saveState();
  },

  isReported(txId) { return !!this.state.reportedTxIds[txId]; },
  getReportedPeriod(txId) { return this.state.reportedTxIds[txId] || null; },
  saveCategoryPrefs(prefs) { this.state.categoryPrefs = prefs; return this.saveState(); },
  getCategoryPrefs() { return this.state.categoryPrefs; },

  async createGoogleDoc(title, htmlContent) {
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify({
      name: title, parents: [this.folderId],
      mimeType: 'application/vnd.google-apps.document'
    })], { type: 'application/json' }));
    form.append('file', new Blob([htmlContent], { type: 'text/html' }));
    return this.apiJson('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink', {
      method: 'POST', body: form
    });
  }
};
