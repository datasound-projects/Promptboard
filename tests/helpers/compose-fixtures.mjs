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

export function researchPlan(input = questTask, overrides = {}) {
  return { assessment: { actionable: true, goal: input, entities: ['QuestDB', 'Python'], operations: ['ingestion'], constraints: [], expectedOutput: 'An implementation-ready prompt', complexity: 'moderate', research: 'standard', needsProject: false, reason: 'Verify the ingestion protocol and timestamp semantics.', ...overrides },
    questions: [
      { id: 'r1', question: 'Which QuestDB ingestion protocol supports Python market ticks?', reason: 'Select a compatible ingestion API.', sourceHint: 'all', libraryHint: 'QuestDB', query: 'QuestDB Python crypto ingestion high throughput ILP protocol' },
      { id: 'r2', question: 'How should the QuestDB timestamp and duplicates be configured?', reason: 'Preserve financial time-series semantics.', sourceHint: 'document', libraryHint: 'QuestDB', query: 'QuestDB designated timestamp deduplication upsert keys' },
    ], assumptions: [], unverified: ['Detect the actual ingestion rate and timestamp field from the implementation environment.'] };
}
export function researchReview(prompt, overrides = {}) {
  const data = JSON.parse(prompt.split('# Research data\n')[1]);
  return { findings: data.evidence.slice(0, 3).map(item => ({ evidenceId: item.id, statement: 'Use only the documented ingestion facts supported by this excerpt.', quote: item.text.slice(0, 250) })),
    questions: [], assumptions: [], unverified: [], continueResearch: false, reason: 'Enough relevant context; further research would not materially improve the prompt.', ...overrides };
}
