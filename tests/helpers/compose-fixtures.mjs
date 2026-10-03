/** Tiny uncompressed PDFs generated in memory: real parser fixtures, no binary artifacts. */
export function pdfFixture(pages) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const kids = [];
  for (const text of pages) {
    const page = objects.length + 1, content = page + 1;
    kids.push(`${page} 0 R`);
    const lines = text.match(/.{1,90}/g) || [''];
    const stream = 'BT /F1 10 Tf 20 750 Td ' + lines.map(line => '(' + line.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)') + ') Tj 0 -12 Td').join(' ') + ' ET';
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${content} 0 R >>`, `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Count ${pages.length} /Kids [${kids.join(' ')}] >>`;
  let out = '%PDF-1.7\n'; const offsets = [0];
  for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  return Buffer.from(out + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}
export const questTask = 'Implement a Python service that writes high-frequency crypto market ticks into QuestDB.';
export const questText = 'QuestDB crypto ingestion uses ILP over HTTP for high throughput market ticks. Select a designated timestamp. Deduplication requires configured upsert keys.';
export const questPlan = { questions: [
  { id: 'q1', question: 'What ingestion rate must the service handle?', answerFrom: 'user', required: false, sourceQueries: [] },
  { id: 'q2', question: 'Which QuestDB ingestion protocol supports high throughput market ticks?', answerFrom: 'sources', required: false, sourceQueries: [{ sourceHint: 'all', libraryHint: 'QuestDB', query: 'QuestDB crypto ingestion high throughput ILP protocol' }] },
  { id: 'q3', question: 'Which field is the designated timestamp?', answerFrom: 'either', required: false, sourceQueries: [{ sourceHint: 'document', libraryHint: 'QuestDB', query: 'QuestDB designated timestamp field' }] },
] };
