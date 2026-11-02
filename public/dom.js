'use strict';

// Small DOM helpers shared by the page modules. Text is always set as text, never parsed as HTML.
window.PromptboardDom = (() => {
  const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
  const button = (text, onClick, className, title = '') => { const node = el('button', className, text); node.type = 'button'; if (title) node.title = title; node.addEventListener('click', onClick); return node; };
  const pref = (key, fallback = null) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
  const setPref = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
  const plural = (n, word, many = `${word}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? word : many}`;
  const clip = (text, max) => { const value = String(text || '').trim(); return value.length > max ? `${value.slice(0, max - 1)}…` : value; };
  /** The address when it is a plain http(s) URL without credentials, otherwise ''. */
  const safeUrl = value => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; } catch { return ''; } };
  /** Saves `content` as a file named `name` through the browser's own download. */
  function download(name, content, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = el('a'); link.href = url; link.download = name; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  /** A short, readable duration: "45s", "3:05", "1 h 20 min". */
  const duration = ms => { const s = Math.max(0, Math.round(ms / 1000)), m = Math.round(s / 60); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(m / 60)} h ${m % 60} min`; };
  const relativeTime = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  /** How long ago a time (ms) was, in words: "just now", "5 minutes ago", "yesterday". */
  const ago = at => {
    const seconds = (at - Date.now()) / 1000;
    for (const [unit, size] of [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]]) {
      if (Math.abs(seconds) >= size) return relativeTime.format(Math.round(seconds / size), unit);
    }
    return 'just now';
  };
  /** Minutes left in words, rounded up: "less than a minute", "about 12 min". */
  const left = ms => (ms < 60000 ? 'less than a minute' : `about ${Math.ceil(ms / 60000)} min`);
  /**
   * An estimate for one running step: its elapsed time against the typical time of finished steps. Without a finished
   * step there is no basis, so `percent` is null (the bar moves instead of claiming a number). Stays below 100 until done.
   */
  const estimate = (elapsed, typical) => (typical > 0 ? { percent: Math.min(95, Math.round((elapsed / typical) * 100)), left: Math.max(0, typical - elapsed) } : { percent: null, left: null });
  /**
   * Time left for a set of runs: what the running ones still need, plus the waiting ones, shared by the runs that work at
   * the same time. Null before a finished run gives a typical time.
   */
  const remaining = ({ startedAt = [], waiting = 0, typical = 0, slots = 1, now = Date.now() }) => (typical > 0
    ? (startedAt.reduce((sum, at) => sum + Math.max(0, typical - (now - at)), 0) + waiting * typical) / Math.max(1, Math.min(slots, startedAt.length + waiting)) : null);
  /** A thin progress bar. `set(percent)` fills it; `set(null)` makes it a moving "working" bar. */
  function meter(label) {
    const bar = el('div', 'pb-meter'), fill = el('span', 'pb-meter-fill');
    bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-label', label); bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100'); bar.append(fill);
    bar.set = percent => {
      bar.classList.toggle('is-moving', percent === null);
      if (percent === null) { bar.removeAttribute('aria-valuenow'); fill.style.width = ''; return bar; }
      bar.setAttribute('aria-valuenow', String(percent)); fill.style.width = `${percent}%`; return bar;
    };
    return bar.set(0);
  }
  /** An error line that screen readers announce when it appears. */
  const errorLine = (text, tag = 'p') => { const node = el(tag, 'inline-error', text); node.setAttribute('role', 'alert'); return node; };
  /**
   * A modal dialog keeps keyboard focus: Tab and Shift+Tab wrap inside it, and focus that falls out while it is open (a
   * focused submit button disabled during its request) comes back to the error the dialog shows, or else to that control.
   */
  function holdFocus(dialog) {
    const stops = () => [...dialog.querySelectorAll('button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])')].filter(node => !node.disabled && node.getClientRects().length);
    let last = null;
    dialog.addEventListener('focusin', event => { last = event.target; });
    dialog.addEventListener('keydown', event => {
      if (event.key !== 'Tab' || event.defaultPrevented) return;
      const all = stops();
      if (all.length && document.activeElement === (event.shiftKey ? all[0] : all.at(-1))) { event.preventDefault(); (event.shiftKey ? all.at(-1) : all[0]).focus(); }
    });
    new MutationObserver(() => {
      if (!dialog.open || ![document.body, null].includes(document.activeElement)) return;
      const shown = [...dialog.querySelectorAll('[role="alert"]')].find(node => node.textContent.trim() && node.getClientRects().length);
      if (shown) { if (!shown.hasAttribute('tabindex')) shown.tabIndex = -1; shown.focus(); }
      else if (last?.isConnected && dialog.contains(last) && !last.disabled) last.focus();
    }).observe(dialog, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'disabled'] });
  }
  /** A persistent notice for settings whose backup was recovered with access and automation switched off. */
  function recoveryNotice(parent, recovery) {
    let notice = [...parent.children].find(node => node.hasAttribute('data-network-recovery'));
    if (!recovery) { notice?.remove(); return; }
    if (!notice) { notice = el('p', 'note network-stale'); notice.setAttribute('data-network-recovery', ''); notice.setAttribute('role', 'status'); parent.prepend(notice); }
    notice.textContent = recovery.message;
  }
  return { el, button, pref, setPref, plural, clip, safeUrl, download, duration, ago, left, estimate, remaining, meter, errorLine, holdFocus, recoveryNotice };
})();
