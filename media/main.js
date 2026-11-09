// @ts-check
(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  const ROW_H = 24;
  const LANE_W = 14;
  const COLORS = ['#4e9de0', '#e5a33b', '#5fb760', '#d75f8b', '#9d7be0', '#3bbfb4', '#e06c4e', '#b5b53b'];
  const ACTIONS = ['pick', 'reword', 'edit', 'squash', 'fixup', 'drop'];

  /** @type {any} */
  let data = { commits: [], refs: [], head: null, branch: null, state: null, hasMore: false, filterRef: null, repo: '' };
  /** @type {Map<string, number>} */
  let indexByHash = new Map();
  let graph = { width: 0, svg: '' };
  /** @type {string[]} */
  let selected = [];
  let anchorIdx = -1;
  let filter = '';
  /** @type {any} */
  let details = null;
  /** @type {number[]} */
  let visible = [];
  const closedGroups = new Set();

  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const esc = (/** @type {any} */ s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => /** @type {any} */ ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const short = (/** @type {string} */ h) => (h ? h.slice(0, 8) : '');
  const post = (/** @type {any} */ msg) => vscode.postMessage(msg);
  const color = (/** @type {number} */ i) => COLORS[i % COLORS.length];
  const laneX = (/** @type {number} */ j) => LANE_W / 2 + 4 + j * LANE_W;

  window.addEventListener('message', (e) => {
    const m = e.data;
    switch (m.type) {
      case 'data':
        onData(m);
        break;
      case 'details':
        if (selected.length === 1 && m.details.hash === selected[0]) {
          details = m.details;
          renderDetails();
        }
        break;
      case 'rebasePlan':
        openRebaseDialog(m);
        break;
      case 'rewordPrompt':
        openRewordDialog(m);
        break;
      case 'busy':
        document.body.classList.toggle('busy', m.value);
        break;
      case 'error':
        $('list').innerHTML = `<div class="empty">${esc(m.message)}</div>`;
        $('graph').style.display = 'none';
        break;
    }
  });

  function onData(/** @type {any} */ m) {
    data = m;
    indexByHash = new Map(data.commits.map((/** @type {any} */ c, /** @type {number} */ i) => [c.hash, i]));
    selected = selected.filter((h) => indexByHash.has(h));
    if (!selected.length && data.head && indexByHash.has(data.head)) selected = [data.head];
    graph = buildGraph(data.commits);
    renderToolbar();
    renderRefs();
    renderBanner();
    renderList();
    selectionChanged(false);
  }

  // assigns each commit a lane and emits svg paths; lanes hold the hash each column is waiting for
  function buildGraph(/** @type {any[]} */ commits) {
    /** @type {(string|null)[]} */
    const lanes = [];
    const paths = COLORS.map(() => /** @type {string[]} */ ([]));
    const nodes = [];
    let maxLanes = 1;
    const free = () => {
      const i = lanes.indexOf(null);
      return i === -1 ? lanes.length : i;
    };
    const seg = (/** @type {number} */ a, /** @type {number} */ y1, /** @type {number} */ b, /** @type {number} */ y2, /** @type {number} */ ci) => {
      const x1 = laneX(a);
      const x2 = laneX(b);
      const d = x1 === x2 ? `M${x1} ${y1}V${y2}` : `M${x1} ${y1}C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`;
      paths[ci % COLORS.length].push(d);
    };

    commits.forEach((c, i) => {
      const before = lanes.slice();
      let col = lanes.indexOf(c.hash);
      if (col === -1) col = free();
      for (let j = 0; j < lanes.length; j++) if (lanes[j] === c.hash) lanes[j] = null;
      lanes[col] = null;
      /** @type {number[]} */
      const parentCols = [];
      c.parents.forEach((/** @type {string} */ p, /** @type {number} */ k) => {
        // first parent keeps the column; duplicate lanes converge at the parent row
        let j = k === 0 ? col : lanes.indexOf(p);
        if (j === -1) j = free();
        lanes[j] = p;
        parentCols.push(j);
      });
      while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();

      const y0 = i * ROW_H;
      const ym = y0 + ROW_H / 2;
      const y1 = y0 + ROW_H;
      before.forEach((h, j) => {
        if (!h) return;
        if (h === c.hash) seg(j, y0, col, ym, j);
        else seg(j, y0, j, y1, j);
      });
      parentCols.forEach((pj) => seg(col, ym, pj, y1, pj));
      nodes.push({ col, y: ym, merge: c.parents.length > 1, head: c.hash === data.head });
      maxLanes = Math.max(maxLanes, before.length, lanes.length, col + 1);
    });

    let svg = paths
      .map((d, ci) => (d.length ? `<path d="${d.join('')}" stroke="${COLORS[ci]}" stroke-width="2" fill="none"/>` : ''))
      .join('');
    for (const n of nodes) {
      const x = laneX(n.col);
      const c = color(n.col);
      if (n.head) svg += `<circle cx="${x}" cy="${n.y}" r="5.5" fill="var(--vscode-editor-background)" stroke="${c}" stroke-width="2.5"/>`;
      else if (n.merge) svg += `<circle cx="${x}" cy="${n.y}" r="4" fill="var(--vscode-editor-background)" stroke="${c}" stroke-width="2"/>`;
      else svg += `<circle cx="${x}" cy="${n.y}" r="4" fill="${c}"/>`;
    }
    return { width: laneX(maxLanes - 1) + LANE_W / 2 + 4, svg };
  }

  function renderToolbar() {
    const repoSel = /** @type {HTMLSelectElement} */ ($('repoSelect'));
    const multi = (data.repos || []).length > 1;
    $('repo').textContent = multi ? '' : data.repo;
    $('repo').classList.toggle('hidden', multi);
    repoSel.classList.toggle('hidden', !multi);
    if (multi) {
      repoSel.innerHTML = data.repos
        .map((/** @type {any} */ r) => `<option value="${esc(r.root)}" title="${esc(r.root)}" ${r.root === data.root ? 'selected' : ''}>${esc(r.name)}</option>`)
        .join('');
      repoSel.title = data.root;
    }
    const sel = /** @type {HTMLSelectElement} */ ($('branchFilter'));
    const opt = (/** @type {string} */ v, /** @type {string} */ l) => `<option value="${esc(v)}" ${v === (data.filterRef || '') ? 'selected' : ''}>${esc(l)}</option>`;
    const heads = data.refs.filter((/** @type {any} */ r) => r.type === 'head');
    const remotes = data.refs.filter((/** @type {any} */ r) => r.type === 'remote');
    sel.innerHTML =
      opt('', 'All branches') +
      (data.head ? opt('HEAD', 'HEAD') : '') +
      heads.map((/** @type {any} */ r) => opt(r.full, r.name)).join('') +
      remotes.map((/** @type {any} */ r) => opt(r.full, r.name)).join('');
  }

  function trackLabel(/** @type {string|undefined} */ t) {
    if (!t) return '';
    const a = /ahead (\d+)/.exec(t);
    const b = /behind (\d+)/.exec(t);
    return `${a ? ' ↑' + a[1] : ''}${b ? ' ↓' + b[1] : ''}${t.includes('gone') ? ' (gone)' : ''}`;
  }

  function renderRefs() {
    const groups = [
      ['Local', 'head'],
      ['Remote', 'remote'],
      ['Tags', 'tag'],
    ];
    $('refs').innerHTML = groups
      .map(([title, type]) => {
        const refs = data.refs.filter((/** @type {any} */ r) => r.type === type);
        if (!refs.length) return '';
        const items = refs
          .map((/** @type {any} */ r) => {
            const cur = type === 'head' && r.name === data.branch;
            const wt = r.worktree ? `\nchecked out in worktree: ${r.worktree}` : '';
            return `<div class="ref ${cur ? 'current' : ''} ${r.worktree ? 'in-worktree' : ''}" data-name="${esc(r.name)}" data-type="${type}" data-hash="${r.hash}" title="${esc(r.full)}${r.upstream ? ' → ' + esc(r.upstream) : ''}${esc(wt)}">${cur ? '● ' : ''}${r.worktree ? '<span class="wt">⧉</span>' : ''}${esc(r.name)}<span class="track">${esc(trackLabel(r.track))}</span></div>`;
          })
          .join('');
        return `<details data-group="${type}" ${closedGroups.has(type) ? '' : 'open'}><summary>${title} <span class="count">${refs.length}</span></summary>${items}</details>`;
      })
      .join('') + worktreesHtml();
  }

  function worktreesHtml() {
    const wts = data.worktrees || [];
    if (wts.length < 2) return '';
    const items = wts
      .map((/** @type {any} */ w, /** @type {number} */ k) => {
        const name = w.path.split(/[\\/]/).pop();
        const info = [w.main ? 'main' : '', w.locked ? 'locked' : '', w.prunable ? 'missing' : ''].filter(Boolean).join(', ');
        return `<div class="ref wt-item ${w.current ? 'current' : ''} ${w.prunable ? 'not-loaded' : ''}" data-wt="${k}" data-hash="${w.head || ''}" title="${esc(w.path)}${info ? ' (' + esc(info) + ')' : ''}">${w.current ? '● ' : ''}${esc(name)}<span class="track"> ${esc(w.branch || 'detached')}</span></div>`;
      })
      .join('');
    return `<details data-group="worktree" ${closedGroups.has('worktree') ? '' : 'open'}><summary>Worktrees <span class="count">${wts.length}</span></summary>${items}</details>`;
  }

  function worktreeMenu(/** @type {any} */ w) {
    const act = (/** @type {string} */ name) => () => post({ type: 'action', name, path: w.path });
    const anyPrunable = (data.worktrees || []).some((/** @type {any} */ x) => x.prunable);
    return /** @type {MenuItem[]} */ ([
      { label: 'Open in New Window', run: act('openWorktree'), hidden: w.current || w.prunable },
      { label: 'Copy Path', run: act('copyPath') },
      '-',
      { label: 'Remove Worktree…', run: act('removeWorktree'), hidden: w.main || w.current || w.prunable },
      { label: 'Prune Missing Worktrees', run: () => post({ type: 'action', name: 'pruneWorktrees' }), hidden: !anyPrunable },
    ]);
  }

  function renderBanner() {
    const b = $('banner');
    const s = data.state;
    if (!s) {
      b.className = 'hidden';
      return;
    }
    b.className = '';
    b.innerHTML = `<span><b>${esc(s)}</b> in progress. Resolve conflicts and stage files, then continue.</span>
      <button data-a="continue">Continue</button>${s !== 'merge' ? '<button data-a="skip" class="secondary">Skip</button>' : ''}<button data-a="abort" class="secondary">Abort</button>`;
  }

  function badges(/** @type {any} */ c) {
    const order = { detached: 0, head: 1, remote: 2, tag: 3 };
    return [...c.refs]
      .sort((/** @type {any} */ a, /** @type {any} */ b) => /** @type {any} */ (order)[a.type] - /** @type {any} */ (order)[b.type])
      .map((/** @type {any} */ r) => {
        const cur = r.type === 'head' && r.name === data.branch;
        return `<span class="badge b-${r.type} ${cur ? 'current' : ''}" data-name="${esc(r.name)}" data-type="${r.type}">${r.type === 'tag' ? '🏷 ' : ''}${esc(r.name)}</span>`;
      })
      .join('');
  }

  function fmtDate(/** @type {number} */ ts) {
    const d = new Date(ts * 1000);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return 'Today ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
  }

  function rowHtml(/** @type {any} */ c, /** @type {number} */ i) {
    const cls = ['row'];
    if (selected.includes(c.hash)) cls.push('selected');
    if (c.hash === data.head) cls.push('head');
    return `<div class="${cls.join(' ')}" data-i="${i}"><div class="c-graph"></div><div class="c-subject"><span class="subj">${esc(c.subject)}</span>${c.refs.length ? `<span class="badges">${badges(c)}</span>` : ''}</div><div class="c-author" title="${esc(c.email)}">${esc(c.author)}</div><div class="c-date" title="${esc(new Date(c.date * 1000).toString())}">${esc(fmtDate(c.date))}</div><div class="c-hash">${short(c.hash)}</div></div>`;
  }

  function matches(/** @type {any} */ c, /** @type {string} */ f) {
    return c.subject.toLowerCase().includes(f) || c.author.toLowerCase().includes(f) || c.hash.startsWith(f) || c.refs.some((/** @type {any} */ r) => r.name.toLowerCase().includes(f));
  }

  function renderList() {
    const log = $('log');
    const top = log.scrollTop;
    const f = filter.trim().toLowerCase();
    visible = [];
    data.commits.forEach((/** @type {any} */ c, /** @type {number} */ i) => {
      if (!f || matches(c, f)) visible.push(i);
    });
    const svg = $('graph');
    if (f) {
      svg.style.display = 'none';
      $('rows').style.setProperty('--gw', '8px');
    } else {
      svg.style.display = '';
      svg.setAttribute('width', String(graph.width));
      svg.setAttribute('height', String(data.commits.length * ROW_H));
      svg.innerHTML = graph.svg;
      $('rows').style.setProperty('--gw', graph.width + 'px');
    }
    $('list').innerHTML = visible.map((i) => rowHtml(data.commits[i], i)).join('') || '<div class="empty">No commits</div>';
    $('more').innerHTML = data.hasMore && !f ? '<button id="loadMore" class="secondary">Load more…</button>' : '';
    log.scrollTop = top;
  }

  function updateSelectionClasses() {
    const set = new Set(selected);
    document.querySelectorAll('#list .row').forEach((el) => {
      const i = Number(/** @type {HTMLElement} */ (el).dataset.i);
      el.classList.toggle('selected', set.has(data.commits[i].hash));
    });
  }

  function selectionChanged(clearDetails = true) {
    updateSelectionClasses();
    if (clearDetails) details = null;
    if (selected.length === 1) post({ type: 'details', hash: selected[0] });
    renderDetails();
  }

  /** oldest first */
  function sortedSelection() {
    return [...selected].sort((a, b) => /** @type {number} */ (indexByHash.get(b)) - /** @type {number} */ (indexByHash.get(a)));
  }

  function selectHash(/** @type {string} */ hash) {
    const i = indexByHash.get(hash);
    if (i === undefined) return false;
    selected = [hash];
    anchorIdx = i;
    selectionChanged();
    document.querySelector(`#list .row[data-i="${i}"]`)?.scrollIntoView({ block: 'center' });
    return true;
  }

  function renderDetails() {
    const el = $('details');
    if (selected.length !== 1) {
      el.innerHTML = `<div class="empty">${selected.length ? selected.length + ' commits selected' : 'No commit selected'}</div>`;
      return;
    }
    if (!details || details.hash !== selected[0]) {
      if (!el.querySelector('.d-msg')) el.innerHTML = '<div class="empty">Loading…</div>';
      return;
    }
    const d = details;
    const nl = d.message.indexOf('\n');
    const subject = nl === -1 ? d.message : d.message.slice(0, nl);
    const body = nl === -1 ? '' : d.message.slice(nl + 1).trim();
    const committer = d.committer !== d.author || d.committerEmail !== d.email ? `<div>committed by ${esc(d.committer)} on ${esc(new Date(d.commitDate * 1000).toLocaleString())}</div>` : '';
    const files = d.files
      .map((/** @type {any} */ f, /** @type {number} */ k) => {
        const slash = f.path.lastIndexOf('/');
        const name = f.path.slice(slash + 1);
        const dir = slash === -1 ? '' : f.path.slice(0, slash);
        const s = f.status[0];
        return `<div class="file" data-k="${k}" title="${esc(f.oldPath ? f.oldPath + ' → ' + f.path : f.path)}"><span class="st st-${s}">${s}</span><span class="fname">${esc(name)}</span><span class="fdir">${esc(dir)}</span></div>`;
      })
      .join('');
    el.innerHTML = `
      <div class="d-msg"><div class="d-subject">${esc(subject)}</div>${body ? `<pre class="d-body">${esc(body)}</pre>` : ''}</div>
      <div class="d-meta">
        <div><a class="link" data-copy="${d.hash}" title="Copy">${short(d.hash)}</a> by <b>${esc(d.author)}</b> &lt;${esc(d.email)}&gt;</div>
        <div>${esc(new Date(d.date * 1000).toLocaleString())}</div>
        ${committer}
        ${d.parents.length ? `<div>parents: ${d.parents.map((/** @type {string} */ p) => `<a class="link" data-goto="${p}">${short(p)}</a>`).join(' ')}</div>` : ''}
      </div>
      <div class="d-files-head">${d.files.length} file${d.files.length === 1 ? '' : 's'} changed${d.parents.length > 1 ? ' (vs first parent)' : ''}</div>
      <div class="files">${files}</div>`;
  }

  // ---------- context menu ----------

  /** @typedef {{label: string, run: () => void, disabled?: boolean, hidden?: boolean} | '-'} MenuItem */

  function showMenu(/** @type {number} */ x, /** @type {number} */ y, /** @type {MenuItem[]} */ items) {
    const menu = $('menu');
    const list = items.filter((it) => it === '-' || !it.hidden);
    while (list[0] === '-') list.shift();
    while (list[list.length - 1] === '-') list.pop();
    menu.innerHTML = list
      .map((it, k) => (it === '-' ? '<div class="sep"></div>' : `<div class="item ${it.disabled ? 'disabled' : ''}" data-k="${k}">${esc(it.label)}</div>`))
      .join('');
    menu.className = '';
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.min(x, window.innerWidth - r.width - 4) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - r.height - 4) + 'px';
    menu.onclick = (e) => {
      const el = /** @type {HTMLElement} */ (e.target).closest('.item');
      if (!el || el.classList.contains('disabled')) return;
      hideMenu();
      const it = list[Number(/** @type {HTMLElement} */ (el).dataset.k)];
      if (it !== '-') it.run();
    };
  }

  function hideMenu() {
    $('menu').className = 'hidden';
  }

  function commitMenu() {
    const hs = sortedSelection();
    const n = hs.length;
    const act = (/** @type {string} */ name) => () => post({ type: 'action', name, hashes: hs });
    if (n > 1) {
      return /** @type {MenuItem[]} */ ([
        { label: 'Copy Revision Numbers', run: act('copyHash') },
        '-',
        { label: `Cherry-Pick ${n} Commits`, run: act('cherryPick') },
        { label: `Squash ${n} Commits…`, run: act('squash') },
        { label: `Drop ${n} Commits`, run: act('drop') },
      ]);
    }
    const c = data.commits[/** @type {number} */ (indexByHash.get(hs[0]))];
    const isHead = c.hash === data.head;
    const cur = data.branch || 'HEAD';
    return /** @type {MenuItem[]} */ ([
      { label: 'Copy Revision Number', run: act('copyHash') },
      '-',
      { label: 'Checkout Revision', run: act('checkout'), disabled: isHead },
      { label: 'New Branch…', run: act('newBranch') },
      { label: 'New Tag…', run: act('newTag') },
      '-',
      { label: 'Cherry-Pick', run: act('cherryPick'), disabled: isHead },
      { label: 'Revert Commit', run: act('revert') },
      { label: `Reset ${cur} to Here…`, run: act('reset') },
      '-',
      { label: 'Edit Commit Message…', run: act('reword') },
      { label: 'Undo Commit', run: act('undo'), hidden: !isHead },
      { label: 'Drop Commit', run: act('drop') },
      { label: 'Interactively Rebase from Here…', run: act('interactive') },
      '-',
      { label: `Rebase ${cur} onto ${short(c.hash)}`, run: act('rebaseOnto'), disabled: isHead },
    ]);
  }

  function refMenu(/** @type {{name: string, type: string}} */ ref) {
    const act = (/** @type {string} */ name) => () => post({ type: 'action', name, ref });
    const cur = data.branch;
    const isCur = ref.type === 'head' && ref.name === cur;
    const wt = ref.type === 'head' && data.refs.find((/** @type {any} */ r) => r.type === 'head' && r.name === ref.name)?.worktree;
    /** @type {MenuItem[]} */
    const items = [];
    if (ref.type === 'head') {
      items.push(
        { label: 'Open Worktree in New Window', run: act('openWorktree'), hidden: !wt },
        { label: 'Remove Worktree…', run: act('removeWorktree'), hidden: !wt },
        { label: 'Checkout', run: act('checkout'), hidden: isCur || !!wt },
        { label: 'New Branch from Here…', run: act('newBranch') },
        { label: `Merge into ${cur}`, run: act('merge'), hidden: isCur || !cur },
        { label: `Rebase ${cur} onto ${ref.name}`, run: act('rebaseOnto'), hidden: isCur || !cur },
        { label: 'Pull', run: act('pull'), hidden: !isCur },
        '-',
        { label: 'Push', run: act('push') },
        { label: 'Force Push (with lease)', run: act('forcePush') },
        '-',
        { label: 'Rename…', run: act('renameBranch') },
        { label: 'Delete', run: act('deleteBranch'), disabled: isCur || !!wt },
      );
    } else if (ref.type === 'remote') {
      items.push(
        { label: 'Checkout', run: act('checkout') },
        { label: 'New Branch from Here…', run: act('newBranch') },
        { label: `Merge into ${cur}`, run: act('merge'), hidden: !cur },
        { label: `Rebase ${cur} onto ${ref.name}`, run: act('rebaseOnto'), hidden: !cur },
        '-',
        { label: 'Delete Remote Branch', run: act('deleteBranch') },
      );
    } else if (ref.type === 'tag') {
      items.push({ label: 'Checkout', run: act('checkout') }, { label: 'New Branch from Here…', run: act('newBranch') }, '-', { label: 'Delete Tag', run: act('deleteTag') });
    } else {
      return [];
    }
    items.push('-', { label: 'Copy Name', run: act('copyName') });
    return items;
  }

  // ---------- dialogs ----------

  function showModal(/** @type {string} */ html) {
    $('dialog').innerHTML = html;
    $('modal').className = '';
  }

  function closeModal() {
    $('modal').className = 'hidden';
    $('dialog').innerHTML = '';
  }

  function openRewordDialog(/** @type {any} */ m) {
    showModal(`<h3>Edit Commit Message <span class="muted">${short(m.hash)}</span></h3>
      <textarea id="rwMsg" rows="10" spellcheck="true">${esc(m.message)}</textarea>
      <div class="hint">Ctrl+Enter to save</div>
      <div class="btns"><button class="secondary" data-close>Cancel</button><button id="rwOk">Save</button></div>`);
    const ta = /** @type {HTMLTextAreaElement} */ ($('rwMsg'));
    ta.focus();
    const ok = () => {
      const message = ta.value.trim();
      if (!message) return;
      closeModal();
      if (message !== m.message.trim()) post({ type: 'reword', hash: m.hash, message });
    };
    $('rwOk').onclick = ok;
    ta.onkeydown = (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) ok();
    };
  }

  function openRebaseDialog(/** @type {any} */ m) {
    /** @type {any[]} */
    let entries = m.commits.map((/** @type {any} */ c) => ({ ...c, action: (m.preset && m.preset[c.hash]) || 'pick', newMessage: c.message }));
    if (m.squashTarget) {
      const target = entries.findIndex((e) => e.hash === m.squashTarget);
      const moved = entries.filter((e, k) => k > target && e.action === 'squash');
      const rest = entries.filter((e, k) => !(k > target && e.action === 'squash'));
      rest.splice(target + 1, 0, ...moved);
      entries = rest;
    }
    const original = entries.map((e) => e.hash).join();
    let dragFrom = -1;

    const render = () => {
      const rows = entries
        .map(
          (e, k) => `<div class="rb-row ${e.action}" draggable="true" data-k="${k}">
            <span class="grip" title="Drag to reorder">⋮⋮</span>
            <select data-k="${k}">${ACTIONS.map((a) => `<option ${a === e.action ? 'selected' : ''}>${a}</option>`).join('')}</select>
            <span class="hash">${short(e.hash)}</span>
            <span class="subj">${esc(e.subject)}</span>
            <button class="icon secondary" data-up="${k}" ${k === 0 ? 'disabled' : ''}>↑</button>
            <button class="icon secondary" data-down="${k}" ${k === entries.length - 1 ? 'disabled' : ''}>↓</button>
          </div>${e.action === 'reword' ? `<textarea class="rb-msg" data-msg="${k}" rows="4">${esc(e.newMessage)}</textarea>` : ''}`,
        )
        .join('');
      showModal(`<h3>Interactive Rebase <span class="muted">${entries.length} commit${entries.length === 1 ? '' : 's'} onto ${m.base ? short(m.base) : 'root'} · oldest first</span></h3>
        <div class="rb-list">${rows}</div>
        <div id="rbErr" class="err"></div>
        <div class="btns"><button class="secondary" data-close>Cancel</button><button id="rbStart">Start Rebasing</button></div>`);
      bind();
    };

    const bind = () => {
      const dlg = $('dialog');
      dlg.querySelectorAll('select[data-k]').forEach((s) =>
        s.addEventListener('change', () => {
          entries[Number(/** @type {HTMLElement} */ (s).dataset.k)].action = /** @type {HTMLSelectElement} */ (s).value;
          render();
        }),
      );
      dlg.querySelectorAll('textarea[data-msg]').forEach((t) =>
        t.addEventListener('input', () => {
          entries[Number(/** @type {HTMLElement} */ (t).dataset.msg)].newMessage = /** @type {HTMLTextAreaElement} */ (t).value;
        }),
      );
      const move = (/** @type {number} */ from, /** @type {number} */ to) => {
        if (to < 0 || to >= entries.length || from === to) return;
        const [e] = entries.splice(from, 1);
        entries.splice(to, 0, e);
        render();
      };
      dlg.querySelectorAll('[data-up]').forEach((b) => b.addEventListener('click', () => move(Number(/** @type {HTMLElement} */ (b).dataset.up), Number(/** @type {HTMLElement} */ (b).dataset.up) - 1)));
      dlg.querySelectorAll('[data-down]').forEach((b) => b.addEventListener('click', () => move(Number(/** @type {HTMLElement} */ (b).dataset.down), Number(/** @type {HTMLElement} */ (b).dataset.down) + 1)));
      dlg.querySelectorAll('.rb-row').forEach((row) => {
        const k = Number(/** @type {HTMLElement} */ (row).dataset.k);
        row.addEventListener('dragstart', () => (dragFrom = k));
        row.addEventListener('dragover', (e) => {
          e.preventDefault();
          row.classList.add('drop-target');
        });
        row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
        row.addEventListener('drop', (e) => {
          e.preventDefault();
          move(dragFrom, k);
        });
      });
      $('rbStart').onclick = () => {
        const err = $('rbErr');
        const first = entries.find((e) => e.action !== 'drop');
        if (first && (first.action === 'squash' || first.action === 'fixup')) {
          err.textContent = `The first commit cannot be '${first.action}': there is no previous commit to combine with.`;
          return;
        }
        if (entries.some((e) => e.action === 'reword' && !e.newMessage.trim())) {
          err.textContent = 'Commit messages cannot be empty.';
          return;
        }
        if (entries.every((e) => e.action === 'pick') && entries.map((e) => e.hash).join() === original) {
          closeModal();
          return;
        }
        closeModal();
        post({
          type: 'runRebase',
          base: m.base,
          entries: entries.map((e) => ({ hash: e.hash, action: e.action, message: e.action === 'reword' ? e.newMessage.trim() : undefined })),
        });
      };
    };
    render();
  }

  // ---------- events ----------

  $('list').addEventListener('click', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    const row = /** @type {HTMLElement|null} */ (target.closest('.row'));
    if (!row) return;
    const i = Number(row.dataset.i);
    const h = data.commits[i].hash;
    if (e.shiftKey && anchorIdx >= 0) {
      const a = visible.indexOf(anchorIdx);
      const b = visible.indexOf(i);
      selected = visible.slice(Math.min(a, b), Math.max(a, b) + 1).map((k) => data.commits[k].hash);
    } else if (e.ctrlKey || e.metaKey) {
      selected = selected.includes(h) ? selected.filter((x) => x !== h) : [...selected, h];
      anchorIdx = i;
    } else {
      selected = [h];
      anchorIdx = i;
    }
    selectionChanged();
  });

  $('list').addEventListener('dblclick', (e) => {
    const badge = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('.badge'));
    if (badge && badge.dataset.type !== 'detached') post({ type: 'action', name: 'checkout', ref: { name: badge.dataset.name, type: badge.dataset.type } });
  });

  $('list').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const target = /** @type {HTMLElement} */ (e.target);
    const badge = /** @type {HTMLElement|null} */ (target.closest('.badge'));
    if (badge) {
      const items = refMenu({ name: /** @type {string} */ (badge.dataset.name), type: /** @type {string} */ (badge.dataset.type) });
      if (items.length) return showMenu(e.clientX, e.clientY, items);
    }
    const row = /** @type {HTMLElement|null} */ (target.closest('.row'));
    if (!row) return;
    const i = Number(row.dataset.i);
    const h = data.commits[i].hash;
    if (!selected.includes(h)) {
      selected = [h];
      anchorIdx = i;
      selectionChanged();
    }
    showMenu(e.clientX, e.clientY, commitMenu());
  });

  $('log').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const cur = selected.length ? visible.indexOf(/** @type {number} */ (indexByHash.get(selected[selected.length - 1]))) : -1;
    const next = Math.max(0, Math.min(visible.length - 1, cur + (e.key === 'ArrowDown' ? 1 : -1)));
    if (visible[next] === undefined) return;
    selected = [data.commits[visible[next]].hash];
    anchorIdx = visible[next];
    selectionChanged();
    document.querySelector(`#list .row[data-i="${visible[next]}"]`)?.scrollIntoView({ block: 'nearest' });
  });

  $('more').addEventListener('click', (e) => {
    if (/** @type {HTMLElement} */ (e.target).id === 'loadMore') post({ type: 'loadMore' });
  });

  $('refs').addEventListener('click', (e) => {
    const el = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('.ref'));
    if (el && !selectHash(/** @type {string} */ (el.dataset.hash))) el.classList.add('not-loaded');
  });
  $('refs').addEventListener('dblclick', (e) => {
    const wtEl = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('.wt-item'));
    if (wtEl) {
      const w = data.worktrees[Number(wtEl.dataset.wt)];
      if (!w.current && !w.prunable) post({ type: 'action', name: 'openWorktree', path: w.path });
      return;
    }
    const el = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('.ref'));
    if (!el || (el.dataset.type === 'head' && el.dataset.name === data.branch)) return;
    post({ type: 'action', name: 'checkout', ref: { name: el.dataset.name, type: el.dataset.type } });
  });
  $('refs').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const wtEl = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('.wt-item'));
    if (wtEl) return showMenu(e.clientX, e.clientY, worktreeMenu(data.worktrees[Number(wtEl.dataset.wt)]));
    const el = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('.ref'));
    if (el) showMenu(e.clientX, e.clientY, refMenu({ name: /** @type {string} */ (el.dataset.name), type: /** @type {string} */ (el.dataset.type) }));
  });
  $('refs').addEventListener(
    'toggle',
    (e) => {
      const d = /** @type {HTMLDetailsElement} */ (e.target);
      if (d.open) closedGroups.delete(d.dataset.group);
      else closedGroups.add(d.dataset.group);
    },
    true,
  );

  $('details').addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    const file = /** @type {HTMLElement|null} */ (t.closest('.file'));
    if (file && details) {
      post({ type: 'openDiff', hash: details.hash, parent: details.parents[0] ?? null, file: details.files[Number(file.dataset.k)] });
      return;
    }
    if (t.dataset.goto) selectHash(t.dataset.goto);
    if (t.dataset.copy) post({ type: 'action', name: 'copyHash', hashes: [t.dataset.copy] });
  });

  $('banner').addEventListener('click', (e) => {
    const a = /** @type {HTMLElement} */ (e.target).dataset.a;
    if (a) post({ type: 'action', name: a });
  });

  $('toolbar').addEventListener('click', (e) => {
    const cmd = /** @type {HTMLElement} */ (e.target).dataset.cmd;
    if (cmd === 'refresh') post({ type: 'refresh' });
    else if (cmd) post({ type: 'action', name: cmd });
  });

  $('repoSelect').addEventListener('change', (e) => post({ type: 'selectRepo', root: /** @type {HTMLSelectElement} */ (e.target).value }));

  $('branchFilter').addEventListener('change', (e) => post({ type: 'setFilter', ref: /** @type {HTMLSelectElement} */ (e.target).value }));

  let searchTimer = 0;
  $('search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      filter = /** @type {HTMLInputElement} */ (e.target).value;
      renderList();
    }, 150);
  });

  $('modal').addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    if (t.id === 'modal' || t.hasAttribute('data-close')) closeModal();
  });

  document.addEventListener('mousedown', (e) => {
    if (!(/** @type {HTMLElement} */ (e.target).closest('#menu'))) hideMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideMenu();
      closeModal();
    }
  });
  window.addEventListener('blur', hideMenu);
  $('log').addEventListener('scroll', hideMenu);

  document.querySelectorAll('.splitter').forEach((sp) =>
    sp.addEventListener('mousedown', (ev) => {
      const e = /** @type {MouseEvent} */ (ev);
      e.preventDefault();
      const el = /** @type {HTMLElement} */ (sp);
      const target = $(/** @type {string} */ (el.dataset.target));
      const sign = el.dataset.side === 'left' ? 1 : -1;
      const start = e.clientX;
      const w0 = target.getBoundingClientRect().width;
      const move = (/** @type {MouseEvent} */ m) => (target.style.width = Math.max(120, w0 + sign * (m.clientX - start)) + 'px');
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        document.body.classList.remove('resizing');
      };
      document.body.classList.add('resizing');
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    }),
  );

  post({ type: 'ready' });
})();
