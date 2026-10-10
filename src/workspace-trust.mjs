/**
 * Opt-in "Workspace trust" (Kanban execution permissions): answer a CLI's folder-trust question for a task worktree
 * that Promptboard created, and nothing else. The answer is given only when the rendered screen is positively
 * identified as that provider's folder-trust menu, the folder it names is exactly this run's worktree, and the screen
 * has settled. Any other startup question (sign-in, updates, background services, permissions) is left to the person.
 * Never a timer: no screen, no key.
 */
import { createRequire } from 'node:module';
const { Terminal } = createRequire(import.meta.url)('@xterm/xterm');

const SETTLE_MS = 1000;
export const TRUST_KEYS = Object.freeze({ down: '\x1b[B', up: '\x1b[A', confirm: '\r' });
// The exact menus of the installed CLIs (Claude Code 2.1, Codex CLI 0.160). The marker is the selection pointer.
const MENUS = {
  claude: { marker: '❯', yes: 'Yes, I trust this folder', no: 'No, exit', toYes: 'down',
    is: screen => screen.includes('Accessing workspace:') && screen.includes('Yes, I trust this folder') && screen.includes('No, exit') && screen.includes('Enter to confirm') },
  codex: { marker: '›', yes: '1. Trust and continue', no: '2. Quit', toYes: 'up',
    is: screen => screen.includes('Folder access') && screen.includes('Trust this folder?') && screen.includes('1. Trust and continue') && screen.includes('2. Quit') },
};

export const supportsWorkspaceTrust = provider => Object.hasOwn(MENUS, provider);

export class WorkspaceTrust {
  constructor(provider, workspacePath) {
    if (!supportsWorkspaceTrust(provider)) throw new Error('This CLI has no recognized folder-trust menu.');
    this.menu = MENUS[provider]; this.path = String(workspacePath || '').replace(/\s+/g, '');
    this.terminal = new Terminal({ cols: 120, rows: 32, allowProposedApi: true });
    this.output = ''; this.changedAt = null; this.phase = 'waiting';
  }

  /** Feed the whole output so far; returns a key name to send (down, up, confirm) or null. */
  async observe(output, now) {
    if (['confirmed', 'blocked', 'closed'].includes(this.phase)) return null;
    // Never infer a selection from stripped or truncated accumulated text.
    if (typeof output !== 'string' || output.length > 262144 || !output.startsWith(this.output) || !Number.isFinite(now) || !this.path) { this.phase = 'blocked'; return null; }
    if (output !== this.output) {
      await new Promise(resolve => this.terminal.write(output.slice(this.output.length), resolve));
      this.output = output; this.changedAt = now;
    }
    const buffer = this.terminal.buffer.active;
    const lines = Array.from({ length: this.terminal.rows }, (_, i) => buffer.getLine(buffer.baseY + i)?.translateToString(true) || '');
    const screen = lines.join('\n');
    if (!this.menu.is(screen) || !screen.replace(/\s+/g, '').includes(this.path)) return null;
    const pointer = new RegExp(`^\\s*${this.menu.marker}\\s*`, 'u');
    const choices = lines.filter(line => pointer.test(line)).map(line => line.replace(pointer, '').trim());
    if (choices.length !== 1 || ![this.menu.yes, this.menu.no].includes(choices[0])) return null;
    // Startup repaints can reset the choice: both navigation and confirmation need a settled, rendered menu.
    if (this.changedAt === null || now - this.changedAt < SETTLE_MS) return null;
    if (choices[0] === this.menu.yes) { this.phase = 'confirmed'; return 'confirm'; }
    if (this.phase === 'waiting') { this.phase = 'selection_sent'; return this.menu.toYes; }
    return null; // A reset to No is never confirmed or navigated again blindly.
  }

  close() { if (this.phase !== 'closed') { this.phase = this.phase === 'confirmed' ? 'confirmed' : 'closed'; this.terminal.dispose(); } }
}
