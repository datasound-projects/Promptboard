/** Only for the opt-in live check's own disposable folder; never a product approval. */
import { createRequire } from 'node:module';
const { Terminal } = createRequire(import.meta.url)('@xterm/xterm');

export class ClaudeFolderTrust {
  constructor() {
    this.terminal = new Terminal({ cols: 120, rows: 32, allowProposedApi: true });
    this.output = ''; this.changedAt = null; this.phase = 'waiting';
  }

  async observe(output, now) {
    if (['confirmed', 'blocked', 'closed'].includes(this.phase)) return null;
    // Never infer a current selection from stripped or truncated accumulated text.
    if (typeof output !== 'string' || output.length > 262144 || !output.startsWith(this.output)
      || !Number.isFinite(now)) { this.phase = 'blocked'; return null; }
    if (output !== this.output) {
      await new Promise(resolve => this.terminal.write(output.slice(this.output.length), resolve));
      this.output = output; this.changedAt = now;
    }
    const buffer = this.terminal.buffer.active;
    const lines = Array.from({ length: this.terminal.rows }, (_, i) => buffer.getLine(buffer.baseY + i)?.translateToString(true) || '');
    const screen = lines.join('\n');
    const choices = lines.filter(line => /^\s*❯\s*/u.test(line)).map(line => line.replace(/^\s*❯\s*/u, '').trim());
    const folder = screen.includes('Accessing workspace:') && screen.includes('Yes, I trust this folder')
      && screen.includes('No, exit') && screen.includes('Enter to confirm');
    if (!folder || choices.length !== 1 || !['No, exit', 'Yes, I trust this folder'].includes(choices[0])) return null;
    // Startup can repaint and reset the choice after the menu first appears.
    // Both navigation and confirmation require a settled, currently rendered menu.
    if (this.changedAt === null || now - this.changedAt < 1000) return null;
    if (choices[0] === 'Yes, I trust this folder') { this.phase = 'confirmed'; return 'confirm'; }
    if (this.phase === 'waiting') { this.phase = 'selection_sent'; return 'down'; }
    return null; // A reset to No must never be confirmed or navigated again blindly.
  }

  close() { this.phase = 'closed'; this.terminal.dispose(); }
}
