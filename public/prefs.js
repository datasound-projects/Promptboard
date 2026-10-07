'use strict';
// Loads before the stylesheet, so a saved dark theme or collapsed sidebar applies on the first paint.
try {
  const root = document.documentElement;
  // One theme for every page; dark unless the person chose light or system.
  const theme = localStorage.getItem('ste-prompt-engineer.theme') || 'dark';
  if (theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)) {
    root.dataset.theme = 'dark';
    document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', 'dark');
  }
  if (localStorage.getItem('ste-prompt-engineer.sidebar') === 'collapsed') root.dataset.sidebar = 'collapsed';
} catch {}
