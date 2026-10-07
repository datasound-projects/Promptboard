'use strict';
// Loads before the stylesheet, so a saved dark theme or collapsed sidebar applies on the first paint.
try {
  const root = document.documentElement;
  // Origin keeps its own theme (dark unless switched to light); app.js uses the same keys.
  const origin = location.hash === '#/origin' || (!location.hash && localStorage.getItem('promptboard.settings.start-page') === 'origin');
  if (origin) root.dataset.page = 'origin';
  const theme = origin ? (localStorage.getItem('promptboard.origin.theme') === 'light' ? 'light' : 'dark') : localStorage.getItem('ste-prompt-engineer.theme');
  if (theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)) {
    root.dataset.theme = 'dark';
    document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', 'dark');
  }
  if (localStorage.getItem('ste-prompt-engineer.sidebar') === 'collapsed') root.dataset.sidebar = 'collapsed';
} catch {}
