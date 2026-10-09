/**
 * The system's own folder picker, for choosing a project folder. A browser page cannot read the
 * absolute path of a folder it picks, so the local server asks the operating system instead.
 * Commands run without a shell. Nothing is read from the chosen folder here.
 */
import { execFile } from 'node:child_process';
import { BoardError } from './board.mjs';

const PROMPT = 'Choose a project folder for Promptboard';
// Each picker with how it reports Cancel. Any other failure (no display, no GUI session) makes it unusable here.
const PICKERS = {
  // `activate` brings the dialog in front of the browser without controlling other apps. Cancel is error -128.
  darwin: [['osascript', ['-e', 'activate', '-e', `POSIX path of (choose folder with prompt "${PROMPT}")`], (code, stderr) => code === 1 && /\(-128\)/.test(stderr)]],
  // Cancel prints nothing and exits 0, so every failure is a real one.
  win32: [['powershell.exe', ['-NoProfile', '-STA', '-Command',
    `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = '${PROMPT}'; if ($d.ShowDialog() -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }`], () => false]],
  // Both exit 1 on Cancel; GTK also exits 1 when it cannot open the display.
  linux: [['zenity', ['--file-selection', '--directory', `--title=${PROMPT}`], (code, stderr) => code === 1 && !/cannot open display/i.test(stderr)],
    ['kdialog', ['--getexistingdirectory', '.', '--title', PROMPT], code => code === 1]],
};

let open = null;

function run(command, args, cancelled) {
  return new Promise(resolve => {
    execFile(command, args, { shell: false, windowsHide: false, timeout: 10 * 60 * 1000, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
      if (!error) resolve({ path: String(stdout).trim() });
      // A dialog left open until the timeout was not answered: that is a cancel too.
      else if (error.killed || cancelled(error.code, String(stderr))) resolve({ path: '' });
      else resolve({ unusable: true });
    });
  });
}

/** Resolves { path } or { cancelled: true }; throws PICKER_UNAVAILABLE when the system has no picker that works. */
export async function chooseFolder() {
  if (open) throw new BoardError('A folder picker is already open. Finish or cancel it first.', 'PICKER_OPEN', 409);
  open = (async () => {
    for (const [command, args, cancelled] of PICKERS[process.platform] || []) {
      const result = await run(command, args, cancelled);
      if (result.unusable) continue;
      if (!result.path) return { cancelled: true };
      // macOS returns a trailing slash; keep the root folder as it is.
      return { path: result.path.length > 1 ? result.path.replace(/[\\/]+$/, '') : result.path };
    }
    throw new BoardError('This computer has no folder picker Promptboard can use. Type or paste the folder path instead.', 'PICKER_UNAVAILABLE', 501);
  })();
  try { return await open; } finally { open = null; }
}
