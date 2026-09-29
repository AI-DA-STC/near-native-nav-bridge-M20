// M20 fleet console: renders the hub's fleet view, sends operator commands.
'use strict';

const $ = (id) => document.getElementById(id);
let ws = null;
let view = null;
let nextId = 1;
const shown = {};                     // section id -> key of what it shows

function connect() {
  // the websocket listens on the page's port + 1 (8080 -> 8081)
  ws = new WebSocket(`ws://${location.hostname}:${Number(location.port || 80) + 1}`);
  ws.onopen = () => { $('link').classList.add('up'); toast(''); };
  ws.onclose = () => {
    $('link').classList.remove('up');
    toast('No connection to the console hub. Stop robots from the tmux "mission" pane (Ctrl-C) or with `m20 stop`.');
    setTimeout(connect, 1000);
  };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'view') { view = m.view; render(); }
    else if (m.type === 'map') MapView.setMap(m.map);
    else if (m.type === 'scene') MapView.setScene(m.markers);
    else if (m.type === 'missions') renderMissions(m.missions);
    else if (m.type === 'reply') {
      document.querySelectorAll(`[data-cmd="${m.id}"]`).forEach((b) => b.classList.remove('busy'));
      if (m.error) toast(m.error);
    }
  };
}

function toast(text, kind = '') {
  const t = $('toast');
  t.hidden = !text;
  t.textContent = text;
  t.className = `toast ${kind}`;
}
$('toast').onclick = () => toast('');

// Send a command; the button that sent it dims until the hub replies.
function send(cmd, button) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    toast('Not connected: command not sent.');
    return;
  }
  cmd.id = nextId++;
  if (button) { button.classList.add('busy'); button.dataset.cmd = cmd.id; }
  ws.send(JSON.stringify(cmd));
}

// Rebuild a section only when what it shows changed: a node replaced under the
// pointer would swallow the click.
function renderIf(id, key, build) {
  const k = JSON.stringify(key);
  if (shown[id] === k) return;
  shown[id] = k;
  $(id).replaceChildren(...build());
}

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'style') for (const [p, x] of Object.entries(v)) n.style.setProperty(p, x);
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) n.append(c);
  return n;
}

function fmtElapsed(s) {
  s = Math.max(0, Math.floor(s));
  const m = Math.floor(s / 60), r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function renderMissions(list) {
  const sel = $('mission-file');
  const keep = sel.value;
  sel.replaceChildren(...(list.length
    ? list.map((m) => el('option', { value: m.file }, m.name))
    : [el('option', { value: '', disabled: true }, 'no mission fits this site')]));
  if (keep && list.some((m) => m.file === keep)) sel.value = keep;
  $('start').dataset.none = list.length ? '' : '1';
}

function render() {
  const m = view.mission || {};
  const running = !!m.running;
  const host = view.host || {};

  // Stage: mission name, the phase, elapsed. One line each, nothing else.
  $('mission-name').textContent = m.name || '';
  $('phase').textContent = running
    ? (m.phase || 'Starting…')
    : ({ complete: 'Mission complete', aborted: 'Mission stopped', failed: 'Mission failed',
         lost: 'Mission lost' }[m.state] || 'No mission running');
  $('elapsed').textContent = running && m.started ? fmtElapsed(view.t - m.started)
    : (m.error || (m.state === 'aborted' && m.reason) || '');
  $('start').hidden = running;
  $('mission-file').hidden = running;
  const none = $('start').dataset.none === '1';
  $('start').disabled = !host.up || none;
  $('start').title = none ? 'no mission in missions/ fits this site (check: m20 mission <file> --check)'
    : host.up ? 'run the selected mission'
    : 'no mission host: it runs in the tmux "mission" pane (m20 mission-host)';

  // Actions: only what needs the operator now.
  const w = m.waiting;
  const left = w && w.seconds ? Math.max(0, Math.round(w.seconds - (view.t - w.since))) : null;
  renderIf('actions', [w, left, view.inspections], () => {
    const actions = [];
    if (w) {
      actions.push(el('div', { class: 'action' },
        el('div', { class: 'text' }, w.prompt || w.label,
          left != null ? el('div', { class: 'sub' }, `continues by itself in ${left} s`) : null),
        w.event
          ? el('button', { class: 'btn primary', onclick: (e) => send({ cmd: 'signal', event: w.event, data: signalData(m, w.event) }, e.currentTarget) }, w.label)
          : null));
    }
    for (const [id, ins] of Object.entries(view.inspections || {})) {
      actions.push(el('div', { class: 'action' },
        el('div', { class: 'text' }, `${ins.robot} is inspecting ${ins.label}`,
          el('div', { class: 'sub' }, 'what does it find?')),
        el('button', { class: 'btn', onclick: (e) => send({ cmd: 'verdict', id, verdict: 'clear' }, e.currentTarget) }, 'Clear'),
        el('button', { class: 'btn primary', onclick: (e) => send({ cmd: 'verdict', id, verdict: 'threat' }, e.currentTarget) }, 'Threat')));
    }
    return actions;
  });

  // Robots: one colour, one mode word, one detail line.
  // Per-robot Stop only outside a mission: a stop ends the mission, and so stops all of
  // its robots, which is what STOP ALL already says.
  const cards = view.robots.map((r) => ({ id: r.id, color: r.color, mode: r.mode, detail: prettyDetail(r),
    battery: r.battery != null ? Math.round(r.battery * 100) : null, warning: r.warning || null,
    stop: !running && r.mode !== 'OFFLINE' }));
  renderIf('robots', cards, () => cards.map((r) => el('div', { class: 'robot', style: { '--mode': r.color } },
    el('div', { class: 'id' }, `M20 · ${r.id}`,
      r.stop ? el('button', { class: 'btn small', title: 'stop this robot where it stands (no drop)',
                              onclick: (e) => send({ cmd: 'stop', robot: r.id }, e.currentTarget) }, 'Stop') : null),
    el('div', { class: 'mode' }, r.mode),
    el('div', { class: 'detail' }, r.detail),
    el('div', { class: 'meta' },
      r.battery != null ? el('span', {}, `${r.battery}%`) : null,
      r.warning ? el('span', { class: 'warn' }, `⚠ ${r.warning}`) : null))));

  // Signals the mission offers, except the one it is already asking for.
  // ...and not ones the mission has already used (unless it is waiting for one again).
  const offered = (running && m.signals || []).filter((s) =>
    !(w && w.event === s.event) && !(m.used || []).includes(s.event));
  $('signals').hidden = offered.length === 0;
  renderIf('signals', [offered, m.queued], () => [
    el('span', { class: 'label' }, 'Signal'),
    ...offered.map((s) => (m.queued || []).includes(s.event)
      ? el('button', { class: 'btn', disabled: true, title: 'sent; used when the mission gets there' }, `✓ ${s.label || s.event} (queued)`)
      : el('button', { class: 'btn', onclick: (e) => send({ cmd: 'signal', event: s.event, data: s.data || {} }, e.currentTarget) }, s.label || s.event))]);

  // Timeline: the last few things that happened.
  const recent = [...(view.timeline || [])].reverse();
  renderIf('timeline', recent, () => recent.map((e) =>
    el('li', { class: `${e.kind}-k` }, el('time', {}, new Date(e.t * 1000).toLocaleTimeString([], { hour12: false })), e.text)));
}

function signalData(m, event) {
  const s = (m.signals || []).find((x) => x.event === event);
  return (s && s.data) || {};
}

function prettyDetail(r) {
  if (!r.detail) return '';
  const d = r.detail.replace(/_/g, ' ');
  return { PATROL: `route ${d}`, EXPLORE: `zone ${d}`, INVESTIGATE: d, REGROUP: `formation ${d}` }[r.mode] || d;
}

$('start').onclick = (e) => send({ cmd: 'start', file: $('mission-file').value }, e.currentTarget);
$('stop-all').onclick = (e) => send({ cmd: 'stop', robot: 'all' }, e.currentTarget);

connect();
