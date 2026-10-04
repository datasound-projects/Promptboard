/** Bounded, private PTY observations. None of these fields grants input. */
export class TerminalInputObservation {
  #state = 'ground';
  #control = '';
  #stringType = '';
  #mode = null;
  #manual = false;
  #closed = false;

  observeOutput(data) {
    if (this.#closed || typeof data !== 'string') return;
    for (const character of data) {
      const code = character.charCodeAt(0);
      if (this.#state === 'ground' && (code >= 0x20 && code < 0x7f || code >= 0xa0)) continue;
      if (this.#state === 'string' || this.#state === 'string-escape') {
        // Treat opaque strings conservatively. Their payload is never a mode
        // grant, and no payload is retained, regardless of its length.
        if (code === 0x9c || code === 0x18 || code === 0x1a || code === 7 && this.#stringType === 'osc'
          || this.#state === 'string-escape' && character === '\\') this.#state = 'ground';
        else {
          if (this.#state === 'string-escape' || code >= 0x90 && code <= 0x9f) this.#mode = null;
          this.#state = code === 0x1b ? 'string-escape' : 'string';
        }
        continue;
      }
      if (code === 0x7f) continue;
      if (code === 0x18 || code === 0x1a || code === 0x9c) {
        this.#state = 'ground'; this.#control = ''; continue;
      }
      if (code === 0x1b) { this.#state = 'escape'; this.#control = ''; continue; }
      if (code === 0x9b) { this.#state = 'csi'; this.#control = ''; continue; }
      if ([0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(code)) { this.#opaque(code === 0x9d ? 'osc' : 'opaque'); continue; }
      if (this.#state === 'escape') {
        if (character === '[') this.#state = 'csi';
        else if (['P', 'X', ']', '^', '_'].includes(character)) this.#opaque(character === ']' ? 'osc' : 'opaque');
        else if (code >= 0x20 && code <= 0x2f) this.#state = 'escape-intermediate';
        else if (code >= 0x30) { if (character === 'c') this.#mode = false; this.#state = 'ground'; }
        continue;
      }
      if (this.#state === 'escape-intermediate') {
        if (code >= 0x30) this.#state = 'ground';
        continue;
      }
      if (this.#state === 'csi' || this.#state === 'csi-ignore') {
        if (code >= 0x40 && code <= 0x7e) {
          if (this.#state === 'csi') this.#finish(character);
          this.#state = 'ground'; this.#control = '';
        } else if (code >= 0x20 && code <= 0x3f && this.#state === 'csi') {
          if (this.#control.length < 64) this.#control += character;
          else { this.#mode = null; this.#control = ''; this.#state = 'csi-ignore'; }
        } else if (code > 0x7f) { this.#mode = null; this.#state = 'ground'; this.#control = ''; }
      }
    }
  }

  #opaque(type) { this.#state = 'string'; this.#stringType = type; this.#control = ''; }

  #finish(final) {
    if (final === 'p' && /^[0-9;:]*!$/.test(this.#control)) this.#mode = false; // DECSTR, as rendered by xterm.
    else if (['h', 'l'].includes(final)) {
      if (/^\?[0-9;]+$/.test(this.#control)) {
        const parameters = this.#control.slice(1).split(';');
        if (parameters.length > 32) this.#mode = null; // xterm's parameter bound.
        else if (parameters.some(parameter => Number(parameter) === 2004)) this.#mode = final === 'h';
      } else this.#mode = null;
    }
  }

  manualInput(data) { if (!this.#closed && typeof data === 'string' && data) this.#manual = true; }

  snapshot() {
    return { bracketedPaste: this.#closed ? null : this.#mode,
      controlPending: !this.#closed && this.#state !== 'ground', manualInputObserved: this.#manual, closed: this.#closed };
  }

  close() { this.#closed = true; this.#mode = null; this.#state = 'ground'; this.#control = ''; }
}
