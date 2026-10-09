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
  return { el, button, pref, setPref, plural, clip, safeUrl, download };
})();
