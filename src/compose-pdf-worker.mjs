/** Lazy, terminable PDF extraction. No rendering, scripts, URLs, fonts, or OCR. */
import { parentPort, workerData } from 'node:worker_threads';
try {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: new Uint8Array(workerData.bytes), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, useWorkerFetch: false, verbosity: 0 });
  const pdf = await task.promise;
  try {
    const from = workerData.from ?? 1, to = workerData.to ?? pdf.numPages;
    if (from > pdf.numPages || to > pdf.numPages) throw new Error('The page range is outside this PDF.');
    if (to - from + 1 > 200) throw new Error('Select at most 200 pages per document.');
    const pages = []; let size = 0;
    for (let number = from; number <= to; number++) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      const text = content.items.map(item => typeof item.str === 'string' ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('');
      size += text.length;
      if (size > 2_000_000) throw new Error('Extracted text is too large. Select fewer pages.');
      pages.push({ page: number, text }); page.cleanup();
    }
    if (pages.reduce((sum, page) => sum + page.text.trim().length, 0) < 40) throw new Error('This PDF appears to contain scanned pages. Text extraction found insufficient content.');
    parentPort.postMessage({ pages, pageCount: pdf.numPages });
  } finally { await task.destroy(); }
} catch (error) {
  const known = ['The page range is outside this PDF.', 'Select at most 200 pages per document.', 'Extracted text is too large. Select fewer pages.', 'This PDF appears to contain scanned pages. Text extraction found insufficient content.'];
  parentPort.postMessage({ error: known.includes(error.message) ? error.message : 'PDF extraction failed. Use an unencrypted PDF with selectable text, or continue without this document.' });
}
