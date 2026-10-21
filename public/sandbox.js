'use strict';

// Settings → Docker sandbox: whether card agents can run in Docker (Docker found and running, the image, the sign-ins),
// the image build with live progress and Cancel, Claude Code's token for containers, and an optional image of your own
// under More. Nothing here starts an agent: a project turns Docker mode on in Columns → How agents work → Advanced.
window.PromptboardSandbox = (() => {
  const { el, button } = window.PromptboardDom;
  const DOCKER = {
    running: [true, 'Docker is running.'],
    stopped: [false, 'Docker is installed but not running. Start it (for Colima: colima start).'],
    missing: [false, 'Docker is not installed. Install Docker Desktop or Colima.'],
    unsupported: [false, 'Docker mode runs on macOS and Linux.'],
  };

  function create({ api, announce }) {
    const section = document.getElementById('settings-sandbox-section'), box = document.getElementById('set-sandbox-group');
    if (!section || !box) return null;
    const legend = box.querySelector('legend'), buildBox = el('div', 'sandbox-build');
    let status = null, error = '', busy = false, timer = null, token = '', image = null, more = false;
    const call = async (method, path, body) => {
      const { response, data } = await api(path, { method, timeoutMs: 30000, ...(body ? { body } : {}) });
      if (!response.ok) throw new Error(data.error || 'The Docker sandbox request failed. Nothing was changed.');
      return data;
    };
    const actions = (...nodes) => { const row = el('div', 'detail-actions'); row.append(...nodes); return row; };
    const act = async (work, done = '') => {
      busy = true; error = ''; render();
      try { await work(); if (done) announce(done); } catch (failure) { error = failure.message; }
      finally { busy = false; render(); poll(); }
    };
    const load = () => act(async () => { status = (await call('GET', '/api/sandbox')).sandbox; });

    // While an image builds, only the progress area refreshes, so typing elsewhere in the section is never interrupted.
    function poll() {
      clearTimeout(timer);
      if (status?.build?.status !== 'running' || !section.open || section.closest('dialog')?.open === false) return;
      timer = setTimeout(async () => {
        try {
          status.build = (await call('GET', '/api/sandbox/build')).build;
          if (status.build.status !== 'running') { announce(status.build.status === 'succeeded' ? 'The Docker image is built.' : status.build.status === 'cancelled' ? 'The image build was cancelled.' : 'The image build failed.'); return load(); }
        } catch (failure) { error = failure.message; }
        renderBuild(); poll();
      }, 1000);
    }

    function renderBuild() {
      const build = status?.build, nodes = [];
      if (!status || status.image.custom || status.docker !== 'running') return buildBox.replaceChildren();
      const log = rows => { const pre = el('pre', 'sandbox-log', rows.slice(-12).join('\n')); pre.tabIndex = 0; pre.setAttribute('aria-label', 'Image build output'); return pre; };
      if (build?.status === 'running') {
        const cancel = button('Cancel build', () => act(async () => { status.build = (await call('POST', '/api/sandbox/build/cancel', {})).build; }), 'secondary-button');
        cancel.id = 'set-sandbox-cancel';
        nodes.push(el('p', 'note', 'Building the image. This takes a few minutes the first time.'), actions(cancel), log(build.lines));
      } else {
        const start = button(status.image.ready ? 'Build again' : 'Build image', () => act(async () => { status = (await call('POST', '/api/sandbox/build', {})).sandbox; }, 'Building the Docker image.'), status.image.ready ? 'secondary-button' : 'danger'); // Filled, like Connect GitHub.
        start.id = 'set-sandbox-build'; start.disabled = busy;
        nodes.push(actions(start), el('p', 'note', 'Uses the Claude Code and Codex versions on this computer, and about 1.5 GB of disk. A new image replaces Promptboard’s older ones.'));
        if (build?.status === 'failed') nodes.push(el('p', 'inline-error', 'The build failed. The last lines say why.'), log(build.lines));
        if (build?.status === 'cancelled') nodes.push(el('p', 'note', 'The build was cancelled.'));
      }
      buildBox.replaceChildren(...nodes);
    }

    function render() {
      const focused = box.contains(document.activeElement) ? document.activeElement.id : '';
      if (!status) {
        box.replaceChildren(legend, el('p', error ? 'inline-error' : 'note', error || 'Checking Docker…'), ...(error ? [actions(button('Try again', load, 'secondary-button'))] : []));
        return;
      }
      const [dockerOk, dockerText] = DOCKER[status.docker] || DOCKER.missing;
      const checks = [[dockerOk, dockerText],
        [status.image.ready, status.image.ready ? `Image ready: ${status.image.name}` : status.image.custom ? `Your image ${status.image.name} is not on this Docker.` : 'The image is not built yet.'],
        [status.signIn.codex, status.signIn.codex ? 'Codex uses this computer’s Codex sign-in, read-only.' : 'Codex is not signed in. Run codex login in your terminal.'],
        [status.signIn.claude, status.signIn.claude ? 'Claude Code has its token for Docker.' : 'Claude Code needs a token: run claude setup-token in your terminal and paste it below.']];
      const list = el('ul', 'sandbox-checks');
      for (const [ok, text] of checks) { const item = el('li'); item.dataset.ok = String(Boolean(ok)); const mark = el('span', 'sandbox-mark', ok ? '✓' : '!'); mark.setAttribute('aria-hidden', 'true'); item.append(mark, el('span', '', text)); list.append(item); }
      const ready = dockerOk && status.image.ready && (status.signIn.codex || status.signIn.claude);
      const summary = el('p', 'sandbox-summary', ready ? 'Ready: card agents can run in Docker.' : 'Not ready yet. The list below says what is missing.');
      summary.setAttribute('role', 'status');
      const tokenNodes = [];
      if (status.signIn.claude) tokenNodes.push(actions(button('Remove Claude Code token', () => act(async () => { status = (await call('DELETE', '/api/sandbox/claude-token')).sandbox; }, 'The Claude Code token for Docker was removed.'), 'secondary-button')));
      else {
        const input = el('input'); input.type = 'password'; input.id = 'set-sandbox-token'; input.autocomplete = 'off'; input.spellcheck = false; input.value = token;
        input.addEventListener('input', () => { token = input.value; });
        const save = button('Save token', () => act(async () => { status = (await call('PUT', '/api/sandbox/claude-token', { token })).sandbox; token = ''; }, 'The Claude Code token for Docker is saved.'), 'secondary-button');
        save.id = 'set-sandbox-token-save'; save.disabled = busy;
        const field = el('label', 'field-label'); field.append('Claude Code token for Docker', input);
        tokenNodes.push(field, actions(save));
      }
      const details = el('details', 'sandbox-more'); details.open = more;
      details.addEventListener('toggle', () => { more = details.open; });
      const name = el('input'); name.id = 'set-sandbox-image'; name.autocomplete = 'off'; name.spellcheck = false; name.placeholder = 'Promptboard’s image';
      name.value = image ?? (status.image.custom ? status.image.name : '');
      name.addEventListener('input', () => { image = name.value; });
      const saveName = button('Save image name', () => act(async () => { status = (await call('PUT', '/api/sandbox/settings', { image: name.value })).sandbox; image = null; }, 'The Docker image setting is saved.'), 'secondary-button');
      saveName.disabled = busy;
      const nameField = el('label', 'field-label'); nameField.append('Your own image (optional)', name);
      details.append(el('summary', '', 'More'), nameField, el('p', 'note', 'Leave it empty to use Promptboard’s image. Your own image needs Node.js, Git and the CLIs you use.'), actions(saveName));
      renderBuild();
      box.replaceChildren(legend, el('p', 'note', 'Card agents can run in a container that sees only their card’s workspace. Turn it on for a project in Columns → How agents work → Advanced.'),
        summary, list, buildBox, ...tokenNodes, details, ...(error ? [el('p', 'inline-error', error)] : []), actions(button('Check again', load, 'text-button')));
      if (focused) document.getElementById(focused)?.focus();
    }

    section.addEventListener('toggle', () => { if (section.open) load(); else clearTimeout(timer); });
    document.getElementById('app-settings-open')?.addEventListener('click', () => { if (section.open) load(); });
    return { load };
  }
  return { create };
})();
