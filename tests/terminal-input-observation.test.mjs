import test from 'node:test';
import assert from 'node:assert/strict';
import { TerminalInputObservation } from '../src/terminal-input-observation.mjs';
import { Supervisor } from '../src/supervisor.mjs';

const on = '\x1b[?2004h', off = '\x1b[?2004l';
const state = observation => observation.snapshot();

test('terminal paste mode is unknown initially and split controls resolve only at their final byte', () => {
  for (const [control, enabled] of [[on, true], [off, false]]) for (let split = 1; split < control.length; split++) {
    const observed = new TerminalInputObservation();
    observed.observeOutput(control.slice(0, split));
    assert.equal(state(observed).bracketedPaste, null); assert.equal(state(observed).controlPending, true);
    observed.observeOutput(control.slice(split));
    assert.equal(state(observed).bracketedPaste, enabled); assert.equal(state(observed).controlPending, false);
  }
});

test('mode changes retain stream order, recognize grouped/zero-padded modes and ignore ordinary output', () => {
  const observed = new TerminalInputObservation();
  for (const [text, expected] of [[on + off, false], [off + on, true], ['\x1b[?25;02004l', false], ['\x1b[?2004;25h', true], ['😀 code mentions \\x1b[?2004l\n\x1b[?25l', true]]) {
    for (const character of text) observed.observeOutput(character);
    assert.equal(state(observed).bracketedPaste, expected);
  }
});

test('opaque OSC/DCS/APC/PM/SOS payloads cannot establish paste mode and are never retained', () => {
  for (const start of ['\x1b]', '\x1bP', '\x1b_', '\x1b^', '\x1bX', '\x9d', '\x90', '\x98', '\x9e', '\x9f']) {
    const observed = new TerminalInputObservation(); observed.observeOutput(on);
    observed.observeOutput(start + 'PRIVATE payload ' + on);
    assert.equal(state(observed).bracketedPaste, null); assert.equal(state(observed).controlPending, true);
    observed.observeOutput('\x1b'); observed.observeOutput('\\');
    assert.equal(state(observed).controlPending, false); assert.equal(state(observed).bracketedPaste, null);
    assert.doesNotMatch(JSON.stringify(observed) + JSON.stringify(state(observed)), /PRIVATE|payload|2004/);
    observed.observeOutput(on); assert.equal(state(observed).bracketedPaste, true);
  }
});

test('BEL terminates OSC only; other opaque strings keep embedded controls unavailable', () => {
  const osc = new TerminalInputObservation(); osc.observeOutput('\x1b]title\x07' + on); assert.equal(state(osc).bracketedPaste, true);
  for (const start of ['\x1bP', '\x1b_', '\x1b^', '\x1bX']) {
    const observed = new TerminalInputObservation(); observed.observeOutput(start + '\x07' + on);
    assert.equal(state(observed).bracketedPaste, null); assert.equal(state(observed).controlPending, true);
  }
});

test('ordinary title/string metadata retains the mode only after its complete terminator', () => {
  for (const [start, end] of [['\x1b]', '\x07'], ['\x1bP', '\x1b\\'], ['\x9d', '\x9c']]) {
    const observed = new TerminalInputObservation(); observed.observeOutput(on + start + 'PRIVATE metadata');
    assert.equal(state(observed).controlPending, true);
    for (const character of end) observed.observeOutput(character);
    assert.equal(state(observed).controlPending, false); assert.equal(state(observed).bracketedPaste, true);
    assert.doesNotMatch(JSON.stringify(state(observed)), /PRIVATE|metadata/);
  }
});

test('C1 CSI/ST, cancellation and intervening C0/DEL controls remain bounded observations', () => {
  const observed = new TerminalInputObservation(); observed.observeOutput('\x9b?2004h'); assert.equal(state(observed).bracketedPaste, true);
  observed.observeOutput('\x1b[?2004\x18l'); assert.equal(state(observed).bracketedPaste, true);
  observed.observeOutput('\x1b[?2004\x1al'); assert.equal(state(observed).bracketedPaste, true);
  observed.observeOutput('\x1b[?2004\x00\x7fl'); assert.equal(state(observed).bracketedPaste, false);
  observed.observeOutput('\x1b]private\x9c' + on); assert.equal(state(observed).bracketedPaste, true);
});

test('hard and soft resets disable paste mode; unsupported mode controls lose affirmative evidence', () => {
  for (const reset of ['\x1bc', '\x1b\x00\x7fc', '\x1b[!p', '\x1b[0!p']) {
    const observed = new TerminalInputObservation(); observed.observeOutput(on + reset); assert.equal(state(observed).bracketedPaste, false);
  }
  for (const unsupported of ['\x1b[?2004:1l', '\x1b[?2004;0:1l', '\x1b[??2004l', '\x1b[2004h', '\x1b[?' + ';'.repeat(33) + '2004h']) {
    const observed = new TerminalInputObservation(); observed.observeOutput(on + unsupported); assert.equal(state(observed).bracketedPaste, null);
  }
});

test('oversized or malformed controls cannot retain an enabled claim or keep a text payload', () => {
  const observed = new TerminalInputObservation(); observed.observeOutput(on + '\x1b[?' + '1;'.repeat(100000));
  assert.equal(state(observed).bracketedPaste, null); assert.equal(state(observed).controlPending, true);
  observed.observeOutput('2004h'); assert.equal(state(observed).bracketedPaste, null); assert.equal(state(observed).controlPending, false);
  observed.observeOutput(on + '\x1b[?😀2004l'); assert.equal(state(observed).bracketedPaste, null);
  assert.equal(JSON.stringify(observed), '{}'); assert.ok(JSON.stringify(state(observed)).length < 150);
  observed.observeOutput(on); assert.equal(state(observed).bracketedPaste, true);
});

test('manual-input evidence never clears on output, Enter, reset or startup-looking text; closed owners cannot reopen', () => {
  const observed = new TerminalInputObservation(); observed.manualInput(''); observed.manualInput(null); assert.equal(state(observed).manualInputObserved, false);
  observed.manualInput('PRIVATE draft'); observed.observeOutput(on + '\x1bc\r\nSessionStart'); observed.manualInput('\r');
  assert.equal(state(observed).manualInputObserved, true); assert.doesNotMatch(JSON.stringify(state(observed)), /PRIVATE/);
  observed.close(); observed.observeOutput(on); observed.manualInput('more');
  assert.deepEqual(state(observed), { bracketedPaste: null, controlPending: false, manualInputObserved: true, closed: true });
  assert.equal(state(new TerminalInputObservation()).manualInputObserved, false);
});

test('Supervisor marks manual input before transport failure while empty or rejected input remains inert', () => {
  const supervisor = new Supervisor({ board: {}, dataDir: '/unused' }), observed = new TerminalInputObservation();
  supervisor.sessions.set('owned', { proc: { write() { throw new Error('PRIVATE transport'); } }, terminalInput: observed, inputEpoch: 0 });
  assert.throws(() => supervisor.input('owned', null), { code: 'INPUT_TOO_LARGE' });
  assert.throws(() => supervisor.input('owned', ''), /PRIVATE transport/); assert.equal(state(observed).manualInputObserved, false);
  assert.throws(() => supervisor.input('owned', 'human draft'), /PRIVATE transport/); assert.equal(state(observed).manualInputObserved, true);
  assert.doesNotMatch(JSON.stringify(state(observed)), /PRIVATE|human draft/);
});
