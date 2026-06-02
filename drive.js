// Google Drive helpers
const Drive = {
  folderId: null,
  stateFileId: null,

  async init() {
    this.folderId = await this.getOrCreateFolder(CONFIG.DRIVE_FOLDER_NAME);
    await this.loadState();
  },

  async getOrCreateFolder(name) {
    const res = await gapi.client.drive.files.list({
      q: `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id)'
    });
    if (res.result.files.length > 0) return res.result.files[0].id;
    const created = await gapi.client.drive.files.create({
      resource: { name, mimeType: 'application/vnd.google-apps.folder' },
      fields: 'id'
    });
    return created.result.id;
  },

  // State: stores reported tx IDs, category prefs, receipts index
  state: { reportedTxIds: {}, categoryPrefs: null, receipts: {} },

  async loadState() {
    const res = await gapi.client.drive.files.list({
      q: `name='state.json' and '${this.folderId}' in parents and trashed=false`,
      fields: 'files(id)'
    });
    if (res.result.files.length === 0) { this.stateFileId = null; return; }
    this.stateFileId = res.result.files[0].id;
    const content = await gapi.client.drive.files.get({
      fileId: this.stateFileId, alt: 'media'
    });
    try { this.state = JSON.parse(content.body); } catch(e) {}
  },

  async saveState() {
    const body = JSON.stringify(this.state);
    if (this.stateFileId) {
      await fetch(`https://www.googleapis.com/upload/drive/v3/files/${this.stateFileId}?uploadType=media`, {
        method: 'PATCH',
        headers: { 'Authorization': 'Bearer ' + gapi.client.getToken().access_token, 'Content-Type': 'application/json' },
        body
      });
    } else {
      const meta = await gapi.client.drive.files.create({
        resource: { name: 'state.json', parents: [this.folderId] },
        fields: 'id'
      });
      this.stateFileId = meta.result.id;
      await fetch(`https://www.googleapis.com/upload/drive/v3/files/${this.stateFileId}?uploadType=media`, {
        method: 'PATCH',
        headers: { 'Authorization': 'Bearer ' + gapi.client.getToken().access_token, 'Content-Type': 'application/json' },
        body
      });
    }
  },

  async uploadReceipt(txId, dataUrl, filename) {
    // Convert dataUrl to blob
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const existingId = this.state.receipts[txId]?.fileId;
    if (existingId) {
      // Update existing
      await fetch(`https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=media`, {
        method: 'PATCH',
        headers: { 'Authorization': 'Bearer ' + gapi.client.getToken().access_token, 'Content-Type': blob.type },
        body: blob
      });
      this.state.receipts[txId] = { fileId: existingId, filename };
    } else {
      const form = new FormData();
      form.append('metadata', new Blob([JSON.stringify({ name: `receipt_${txId}_${filename}`, parents: [this.folderId] })], { type: 'application/json' }));
      form.append('file', blob);
      const up = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + gapi.client.getToken().access_token },
        body: form
      });
      const json = await up.json();
      this.state.receipts[txId] = { fileId: json.id, filename };
    }
    await this.saveState();
  },

  async deleteReceipt(txId) {
    const entry = this.state.receipts[txId];
    if (!entry) return;
    try { await gapi.client.drive.files.delete({ fileId: entry.fileId }); } catch(e) {}
    delete this.state.receipts[txId];
    await this.saveState();
  },

  async getReceiptDataUrl(txId) {
    const entry = this.state.receipts[txId];
    if (!entry) return null;
    try {
      const token = gapi.client.getToken().access_token;
      const res = await fetch(`https://www.googleapis.com/drive/v3/files/${entry.fileId}?alt=media`, {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      const blob = await res.blob();
      return await new Promise(resolve => {
        const r = new FileReader();
        r.onload = e => resolve(e.target.result);
        r.readAsDataURL(blob);
      });
    } catch(e) { return null; }
  },

  markReported(txIds, period) {
    txIds.forEach(id => { this.state.reportedTxIds[id] = period; });
    return this.saveState();
  },

  isReported(txId) { return !!this.state.reportedTxIds[txId]; },
  getReportedPeriod(txId) { return this.state.reportedTxIds[txId] || null; },

  saveCategoryPrefs(prefs) { this.state.categoryPrefs = prefs; return this.saveState(); },
  getCategoryPrefs() { return this.state.categoryPrefs; },

  async createGoogleDoc(title, htmlContent) {
    // Create a Google Doc via Drive upload of HTML
    const blob = new Blob([htmlContent], { type: 'text/html' });
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify({
      name: title,
      parents: [this.folderId],
      mimeType: 'application/vnd.google-apps.document'
    })], { type: 'application/json' }));
    form.append('file', blob);
    const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + gapi.client.getToken().access_token },
      body: form
    });
    return await res.json();
  }
};
