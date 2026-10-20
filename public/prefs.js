'use strict';
// Loads before the stylesheet, so a saved dark theme or collapsed sidebar applies on the first paint.
try {
  const root = document.documentElement;
  // One theme for every page; dark unless the person chose light or system (an unknown stored value is ignored).
  const theme = localStorage.getItem('ste-prompt-engineer.theme');
  if (theme !== 'light' && (theme !== 'system' || matchMedia('(prefers-color-scheme: dark)').matches)) {
    root.dataset.theme = 'dark';
    document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', 'dark');
  }
  if (localStorage.getItem('ste-prompt-engineer.sidebar') === 'collapsed') root.dataset.sidebar = 'collapsed';
  const width = Number(localStorage.getItem('ste-prompt-engineer.sidebar-width'));
  if (width >= 200 && width <= 560) root.style.setProperty('--sidebar', `${width}px`);
} catch {}
