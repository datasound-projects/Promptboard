/**
 * The system's own folder picker, for choosing a project folder. A browser page cannot read the
 * absolute path of a folder it picks, so the local server asks the operating system instead.
 * Commands run without a shell. Nothing is read from the chosen folder here.
 */
import { execFile } from 'node:child_process';
import { BoardError } from './board.mjs';

const PROMPT = 'Choose a project folder for Promptboard';
const PICKERS = {
  // `activate` brings the dialog in front of the browser without controlling other apps.
  darwin: [['osascript', ['-e', 'activate', '-e', `POSIX path of (choose folder with prompt "${PROMPT}")`]]],
  win32: [['powershell.exe', ['-NoProfile', '-STA', '-Command',
    `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = '${PROMPT}'; if ($d.ShowDialog() -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }`]]],
  linux: [['zenity', ['--file-selection', '--directory', `--title=${PROMPT}`]], ['kdialog', ['--getexistingdirectory', '.', '--title', PROMPT]]],
};

let open = null;

function run(command, args) {
  return new Promise(resolve => {
    execFile(command, args, { shell: false, windowsHide: false, timeout: 10 * 60 * 1000, maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error?.code === 'ENOENT') resolve({ missing: true });
      else resolve({ path: error ? '' : String(stdout).trim() });
    });
  });
}

/** Resolves { path } or { cancelled: true }; throws PICKER_UNAVAILABLE when the system has no picker. */
export async function chooseFolder() {
  if (open) throw new BoardError('A folder picker is already open. Finish or cancel it first.', 'PICKER_OPEN', 409);
  open = (async () => {
    for (const [command, args] of PICKERS[process.platform] || []) {
      const result = await run(command, args);
      if (result.missing) continue;
      if (!result.path) return { cancelled: true };
      // macOS returns a trailing slash; keep the root folder as it is.
      return { path: result.path.length > 1 ? result.path.replace(/[\\/]+$/, '') : result.path };
    }
    throw new BoardError('This computer has no folder picker Promptboard can use. Type or paste the folder path instead.', 'PICKER_UNAVAILABLE', 501);
  })();
  try { return await open; } finally { open = null; }
}
