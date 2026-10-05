/* Attachment authoring is separate from the literal task prompt. */
(() => {
  'use strict';
  const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
  const button = (text, action) => { const node = el('button', text, 'text-button'); node.type = 'button'; node.addEventListener('click', action); return node; };
  const imageType = bytes => bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 ? 'image/png'
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
      : String.fromCharCode(...bytes.slice(0, 3)) === 'GIF' ? 'image/gif'
        : String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP' ? 'image/webp' : null;
  window.PromptboardTaskFiles = {
    mount({ host, prompt, api, announce }) {
      let owner = null, files = [], refs = [], generation = 0, busy = false, suggestions = [], selected = 0, marker = null;
      const urls = new Set(), status = el('p', '', 'note'), error = el('p', '', 'inline-error'); error.setAttribute('role', 'alert'); error.hidden = true;
      const legend = el('legend', 'Attachments and file references'), input = el('input'); input.type = 'file'; input.multiple = true; input.setAttribute('aria-label', 'Attach files');
      const list = el('ul', undefined, 'task-file-list'), reference = el('input'); reference.type = 'text'; reference.placeholder = 'src/example.js'; reference.setAttribute('aria-label', 'Project-relative file reference');
      const choices = el('div', undefined, 'task-file-suggestions'); choices.hidden = true; choices.setAttribute('role', 'listbox'); choices.setAttribute('aria-label', 'Project file suggestions');
      const refRow = el('div', undefined, 'task-file-reference-row');
      const message = text => { status.textContent = text; if (text) announce(text); };
      const failure = problem => { error.textContent = problem.message; error.hidden = false; };
      const route = action => `/api/projects/${encodeURIComponent(owner)}/${action}`;
      const release = () => { for (const url of urls) URL.revokeObjectURL(url); urls.clear(); };
      const render = () => {
        list.replaceChildren();
        for (const file of files) {
          const row = el('li'); row.append(el('span', `${file.name} · ${Math.ceil(file.size / 1024)} KiB`));
          row.append(button(`Preview / download ${file.name}`, async () => {
            const captured = generation, projectId = owner;
            try {
              const response = await api(`/api/projects/${encodeURIComponent(projectId)}/attachment-read`, { method: 'POST', body: file });
              if (captured !== generation) return;
              const bytes = Uint8Array.from(atob(response.attachment.base64), ch => ch.charCodeAt(0)), type = imageType(bytes), url = URL.createObjectURL(new Blob([bytes], { type: type || 'application/octet-stream' })); urls.add(url);
              if (type) { const image = el('img'); image.src = url; image.alt = `Preview of ${file.name}`; image.className = 'task-file-preview'; row.append(image); }
              const download = el('a', `Download ${file.name}`, 'text-button'); download.href = url; download.download = file.name; row.append(download);
            } catch (problem) { if (captured === generation) failure(problem); }
          }), button(`Remove ${file.name}`, () => { if (busy) return; files = files.filter(value => value.id !== file.id); release(); render(); })); list.append(row);
        }
        for (const path of refs) { const row = el('li'); row.append(el('span', `@${path}`), button(`Remove reference ${path}`, () => { if (busy) return; refs = refs.filter(value => value !== path); render(); })); list.append(row); }
        input.disabled = busy;
      };
      async function upload(incoming) {
        if (!owner || busy) return;
        const batch = [...incoming]; if (!batch.length) return;
        const captured = generation; busy = true; error.hidden = true; message('Uploading attachments…'); render();
        try {
          if (files.length + batch.length > 20) throw new Error('A task accepts up to 20 attachments.');
          for (const file of batch) {
            if (file.size > 4 * 1024 * 1024 || files.reduce((size, row) => size + row.size, 0) + file.size > 24 * 1024 * 1024) throw new Error('Use files up to 4 MiB each and 24 MiB per task.');
            const base64 = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('This file could not be read.')); reader.readAsDataURL(file); });
            if (captured !== generation) return;
            const response = await api(route('attachments'), { method: 'POST', body: { name: file.name, base64 } });
            if (captured !== generation) return;
            if (!files.some(row => row.id === response.attachment.id)) files.push(response.attachment); render();
          }
          message('Attachments ready. Save this task to keep their assignments.');
        } catch (problem) { if (captured === generation) { failure(problem); message('Review the attachments before saving.'); } }
        finally { if (captured === generation) { busy = false; input.value = ''; render(); } }
      }
      async function addReference(path, insert = false) {
        if (!owner || busy) return;
        const captured = generation; error.hidden = true;
        try {
          const next = [...new Set([...refs, path])];
          await api(route('file-references'), { method: 'POST', body: { fileReferences: next } });
          if (captured !== generation) return;
          refs = next; reference.value = '';
          if (insert && marker) { prompt.setRangeText(`@${path} `, marker.start, marker.end, 'end'); prompt.dispatchEvent(new Event('input', { bubbles: true })); prompt.focus(); }
          choices.hidden = true; render(); message(`Added reference ${path}.`);
        } catch (problem) { if (captured === generation) failure(problem); }
      }
      refRow.append(reference, button('Add reference', () => addReference(reference.value))); reference.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); addReference(reference.value); } });
      host.append(legend, el('p', 'Choose files, paste images or drop files here. Type @ in the prompt to choose project files.', 'note'), input, refRow, list, choices, status, error);
      input.addEventListener('change', () => upload(input.files));
      for (const target of [host, prompt]) {
        target.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files') && !host.hidden) event.preventDefault(); });
        target.addEventListener('drop', event => { if (event.dataTransfer?.files.length && !host.hidden) { event.preventDefault(); upload(event.dataTransfer.files); } });
        target.addEventListener('paste', event => { if (event.clipboardData?.files.length && !host.hidden) { event.preventDefault(); upload(event.clipboardData.files); } });
      }
      prompt.addEventListener('input', async () => {
        choices.hidden = true; marker = null; if (!owner || host.hidden || busy) return;
        const before = prompt.value.slice(0, prompt.selectionStart), match = before.match(/(?:^|\s)@([^\s]*)$/); if (!match) return;
        const query = match[1], slash = query.lastIndexOf('/'), folder = slash < 0 ? '' : query.slice(0, slash), prefix = query.slice(slash + 1), captured = generation;
        marker = { start: prompt.selectionStart - query.length - 1, end: prompt.selectionStart }; const capturedMarker = marker;
        try {
          const data = await api(route('files') + '?path=' + encodeURIComponent(folder));
          if (captured !== generation || marker !== capturedMarker) return;
          suggestions = data.entries.filter(row => !row.blocked && row.name.toLowerCase().startsWith(prefix.toLowerCase())).slice(0, 20).map(row => folder ? `${folder}/${row.name}` : row.name); selected = 0;
          choices.replaceChildren(...suggestions.map((path, index) => { const node = button(path, () => addReference(path, true)); node.setAttribute('role', 'option'); node.setAttribute('aria-selected', String(index === 0)); return node; })); choices.hidden = !suggestions.length;
        } catch (problem) { if (captured === generation && marker === capturedMarker) failure(problem); }
      });
      prompt.addEventListener('keydown', event => {
        if (choices.hidden || !suggestions.length) return;
        if (['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(event.key)) event.preventDefault();
        if (event.key === 'Escape') choices.hidden = true;
        if (event.key === 'Enter') addReference(suggestions[selected], true);
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { selected = (selected + (event.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length; [...choices.children].forEach((node, index) => node.setAttribute('aria-selected', String(index === selected))); message(`File suggestion: ${suggestions[selected]}`); }
      });
      return {
        open(projectId, task = {}, enabled = true) { generation++; release(); owner = projectId; files = structuredClone(task.attachments || []); refs = [...(task.fileReferences || [])]; busy = false; error.hidden = true; status.textContent = ''; choices.hidden = true; marker = null; input.value = ''; host.hidden = !enabled; render(); },
        value() { if (busy) throw new Error('Wait for attachment uploads before saving.'); return host.hidden ? {} : { attachments: structuredClone(files), fileReferences: [...refs] }; },
        close() { generation++; owner = null; release(); }
      };
    }
  };
})();
