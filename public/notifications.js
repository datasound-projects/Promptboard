/* Browser opt-in and display receipts. The server never sends an alert twice. */
(() => {
  'use strict';
  const KEY = 'promptboard:browser-notifications', ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
  const validId = value => typeof value === 'string' && ID.test(value);
  class BrowserNotifications {
    constructor({ token, onChange = () => {}, onOpen = () => {} }) {
      this.token = token; this.onChange = onChange; this.onOpen = onOpen;
      this.clientId = `browser_${window.crypto?.randomUUID?.() || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`}`; this.lease = null; this.controller = null;
      this.owned = new Map(); this.seen = new Set(); this.busy = false; this.connected = false;
      this.enabled = false; try { this.enabled = localStorage.getItem(KEY) === '1'; } catch {}
      this.status = this.supported() ? this.enabled ? 'Notifications enabled for this browser. Connect to receive future alerts.' : 'Notifications are off for this browser.' : 'Desktop notifications are unavailable in this browser.';
    }
    supported() { return typeof window.Notification === 'function' && typeof window.Notification.requestPermission === 'function' && window.isSecureContext === true; }
    changed() { this.onChange(this); }
    remember(enabled) { this.enabled = enabled; try { localStorage.setItem(KEY, enabled ? '1' : '0'); } catch {} }
    async enable() {
      if (this.busy || !this.supported()) return;
      this.busy = true; this.changed();
      try {
        // This method is called only by the settings button's click handler.
        const permission = window.Notification.permission === 'granted' ? 'granted' : await window.Notification.requestPermission();
        if (permission !== 'granted') { this.remember(false); this.status = 'Permission was not granted. Change browser permissions to enable notifications.'; return; }
        this.remember(true); this.connect();
      } catch { this.status = 'Browser notification permission could not be enabled.'; }
      finally { this.busy = false; this.changed(); }
    }
    resume() {
      if (this.enabled && this.supported() && window.Notification.permission === 'granted') this.connect();
      else if (this.enabled) { this.status = 'Notifications need browser permission. Enable them in Settings.'; this.changed(); }
    }
    disable() { this.remember(false); this.stop(); this.status = 'Notifications are off for this browser.'; this.changed(); }
    stop() {
      this.controller?.abort(); this.controller = null; this.lease = null; this.connected = false;
      for (const entry of [...this.owned.values()]) this.dismiss(entry);
    }
    dismiss(entry) {
      if (this.owned.get(entry.id) !== entry) return;
      this.owned.delete(entry.id); entry.revoked = true;
      try { entry.notification.close(); } catch {}
    }
    ack(entry, status) {
      if (entry.revoked || entry.acknowledged || this.owned.get(entry.id) !== entry || this.lease !== entry.lease || this.controller?.signal.aborted) return;
      entry.acknowledged = true;
      // No retry: a lost response must not imply a fresh display grant.
      const control = new AbortController(), timer = setTimeout(() => control.abort(), 5000);
      fetch('/api/notifications/ack', { method: 'POST', cache: 'no-store', signal: control.signal,
        headers: { 'Content-Type': 'application/json', 'X-STE-Token': this.token() },
        body: JSON.stringify({ clientId: this.clientId, lease: entry.lease, id: entry.id, receipt: entry.receipt, status }) })
        .catch(() => {}).finally(() => clearTimeout(timer));
    }
    receive(row, controller) {
      if (this.controller !== controller || controller.signal.aborted || !row || typeof row !== 'object') return;
      if (row.type === 'ping') return;
      if (row.type === 'ready') {
        if (this.lease || row.clientId !== this.clientId || !validId(row.lease)) throw new Error('Invalid receiver lease.');
        this.lease = row.lease; this.connected = true; this.status = 'Connected. Column alerts will appear in this browser.'; this.changed(); return;
      }
      if (row.type === 'cancel') {
        const entry = this.owned.get(row.id); if (entry && entry.receipt === row.receipt) this.dismiss(entry); return;
      }
      if (row.type !== 'notification' || row.lease !== this.lease || ![row.id, row.receipt, row.taskId, row.projectId].every(validId)
        || typeof row.title !== 'string' || row.title.length > 500 || typeof row.body !== 'string' || row.body.length > 4000) throw new Error('Invalid notification event.');
      const entry = { ...row, acknowledged: false, revoked: false, notification: null };
      if (this.seen.has(row.id) || this.seen.size >= 10000 || this.owned.size >= 64 || !this.enabled || window.Notification.permission !== 'granted') {
        // Own the failure receipt temporarily without disturbing an existing alert.
        if (!this.owned.has(row.id)) { this.owned.set(row.id, entry); this.ack(entry, 'failed'); this.owned.delete(row.id); } return;
      }
      this.seen.add(row.id); this.owned.set(row.id, entry);
      try {
        entry.notification = new window.Notification(row.title, { body: row.body, tag: row.id, renotify: false });
        entry.notification.onshow = () => this.ack(entry, 'shown');
        entry.notification.onerror = () => { this.ack(entry, 'failed'); this.dismiss(entry); };
        entry.notification.onclose = () => { this.ack(entry, 'closed'); this.dismiss(entry); };
        entry.notification.onclick = () => {
          if (entry.revoked || this.owned.get(entry.id) !== entry) return;
          try { window.focus(); } catch {}
          try { Promise.resolve(this.onOpen({ taskId: row.taskId, projectId: row.projectId })).catch(() => {}); } catch {}
          this.dismiss(entry);
        };
      } catch { this.ack(entry, 'failed'); this.dismiss(entry); }
    }
    connect() {
      if (!this.enabled || !this.supported() || window.Notification.permission !== 'granted' || !this.token()) { this.status = 'Reload the app and enable browser notification permission.'; return; }
      this.stop(); const controller = new AbortController(); this.controller = controller;
      this.status = 'Connecting browser notifications…'; this.changed();
      this.read(controller).catch(() => {}).finally(() => {
        if (this.controller !== controller) return;
        this.stop(); this.status = 'Notification reception disconnected. Reconnect for future alerts.'; this.changed();
      });
    }
    async read(controller) {
      const opening = setTimeout(() => controller.abort(), 10000);
      let response;
      try { response = await fetch('/api/notifications/connect', { method: 'POST', cache: 'no-store', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-STE-Token': this.token() },
        body: JSON.stringify({ clientId: this.clientId, permission: 'granted', consent: true }) }); }
      finally { clearTimeout(opening); }
      if (!response.ok || !response.body) throw new Error('Receiver unavailable.');
      const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true }); let buffer = '';
      try {
        while (!controller.signal.aborted) {
          const { value, done } = await reader.read(); if (done) break;
          buffer += decoder.decode(value, { stream: true });
          if (buffer.length > 65536) throw new Error('Receiver event too large.');
          let at;
          while ((at = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); if (line) this.receive(JSON.parse(line), controller); }
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
  }
  window.PromptboardNotifications = BrowserNotifications;
})();
