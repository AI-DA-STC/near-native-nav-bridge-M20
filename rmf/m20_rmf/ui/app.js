// M20 fleet console: renders the hub's fleet view, sends operator commands.
'use strict';

const $ = (id) => document.getElementById(id);
let ws = null;
let view = null;

function connect() {
  // the websocket listens on the page's port + 1 (8080 -> 8081)
  ws = new WebSocket(`ws://${location.hostname}:${Number(location.port || 80) + 1}`);
  ws.onopen = () => $('link').classList.add('up');
  ws.onclose = () => { $('link').classList.remove('up'); setTimeout(connect, 1500); };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'view') { view = m.view; render(); }
    else if (m.type === 'missions') renderMissions(m.missions);
    else if (m.type === 'reply' && m.error) alert(m.error);
  };
}

function send(cmd) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(cmd));
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
  sel.replaceChildren(...list.map((m) => el('option', { value: m.file }, m.name)));
  if (keep) sel.value = keep;
}

function render() {
  const m = view.mission || {};
  const running = m.running || m.state === 'running';

  // Stage: mission name, the phase, elapsed. One line each, nothing else.
  $('mission-name').textContent = m.name || '';
  $('phase').textContent = running
    ? (m.phase || 'Starting…')
    : ({ complete: 'Mission complete', aborted: 'Mission aborted', failed: 'Mission failed' }[m.state] || 'No mission running');
  $('elapsed').textContent = running && m.started ? fmtElapsed(view.t - m.started) : (m.error || '');
  $('start').hidden = running;
  $('mission-file').hidden = running;
  $('abort').hidden = !running;

  // Actions: only what needs the operator now.
  const actions = [];
  if (m.waiting) {
    const w = m.waiting;
    actions.push(el('div', { class: 'action' },
      el('div', { class: 'text' }, w.prompt || w.label,
        w.seconds ? el('div', { class: 'sub' }, `continues by itself in ${Math.max(0, Math.round(w.seconds - (view.t - w.since)))} s`) : null),
      w.event
        ? el('button', { class: 'btn primary', onclick: () => send({ cmd: 'signal', event: w.event, data: signalData(m, w.event) }) }, w.label)
        : null));
  }
  for (const [id, ins] of Object.entries(view.inspections || {})) {
    actions.push(el('div', { class: 'action' },
      el('div', { class: 'text' }, `${ins.robot} is inspecting ${ins.label}`,
        el('div', { class: 'sub' }, 'what does it find?')),
      el('button', { class: 'btn', onclick: () => send({ cmd: 'verdict', id, verdict: 'clear' }) }, 'Clear'),
      el('button', { class: 'btn primary', onclick: () => send({ cmd: 'verdict', id, verdict: 'threat' }) }, 'Threat')));
  }
  $('actions').replaceChildren(...actions);

  // Robots: one colour, one mode word, one detail line.
  $('robots').replaceChildren(...view.robots.map((r) => el('div', { class: 'robot', style: { '--mode': r.color } },
    el('div', { class: 'id' }, `M20 · ${r.id}`,
      el('button', { class: 'btn small', title: 'stop this robot (no drop)', onclick: () => send({ cmd: 'stop', robot: r.id }) }, 'Stop')),
    el('div', { class: 'mode' }, r.mode),
    el('div', { class: 'detail' }, prettyDetail(r)),
    el('div', { class: 'meta' },
      r.battery != null ? el('span', {}, `${Math.round(r.battery * 100)}%`) : null,
      r.warning ? el('span', { class: 'warn' }, `⚠ ${r.warning}`) : null))));

  // Signals the mission offers, except the one it is already asking for.
  // ...and not ones the mission has already used (unless it is waiting for one again).
  const offered = (running && m.signals || []).filter((s) =>
    !(m.waiting && m.waiting.event === s.event) && !(m.used || []).includes(s.event));
  $('signals').hidden = offered.length === 0;
  $('signals').replaceChildren(
    el('span', { class: 'label' }, 'Signal'),
    ...offered.map((s) => (m.queued || []).includes(s.event)
      ? el('button', { class: 'btn', disabled: true, title: 'sent; used when the mission gets there' }, `✓ ${s.label || s.event} (queued)`)
      : el('button', { class: 'btn', onclick: () => send({ cmd: 'signal', event: s.event, data: s.data || {} }) }, s.label || s.event)));

  // Timeline: the last few things that happened.
  $('timeline').replaceChildren(...[...(view.timeline || [])].reverse().slice(0, 6).map((e) =>
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

$('start').onclick = () => send({ cmd: 'start', file: $('mission-file').value });
$('abort').onclick = () => send({ cmd: 'abort' });
$('stop-all').onclick = () => send({ cmd: 'stop', robot: 'all' });

connect();
