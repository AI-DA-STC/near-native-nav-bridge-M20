// Map panel: the RViz scene drawn top-down. The hub forwards /m20/map (the SLAM map)
// and the /m20/viz markers unchanged, so this shows exactly what RViz shows.
// Scroll to zoom, drag to pan, double-click to fit the site again.
'use strict';

const MapView = (() => {
  // visualization_msgs/Marker types
  const ARROW = 0, CUBE = 1, SPHERE = 2, CYLINDER = 3, LINE_STRIP = 4, LINE_LIST = 5,
    CUBE_LIST = 6, SPHERE_LIST = 7, POINTS = 8, TEXT = 9;
  const canvas = document.getElementById('map');
  const ctx = canvas.getContext('2d');
  let grid = null;            // {w, h, res, origin, img: offscreen canvas}
  let markers = [];
  let cam = null;             // {x, y, k}: world point at the centre, pixels per metre
  let userMoved = false;

  const rgba = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${c[3] * a})`;

  function setMap(m) {
    const cells = Uint8Array.from(atob(m.data), (ch) => ch.charCodeAt(0));
    const img = document.createElement('canvas');
    img.width = m.w; img.height = m.h;
    const g = img.getContext('2d');
    const px = g.createImageData(m.w, m.h);
    // RViz "map" scheme: unknown teal-grey, free light grey, occupied black. Rows run
    // bottom-up.
    for (let row = 0; row < m.h; row++) {
      for (let col = 0; col < m.w; col++) {
        const v = cells[row * m.w + col];
        const occ = v > 127 ? -1 : v;         // int8 -> -1 unknown, 0..100
        const i = ((m.h - 1 - row) * m.w + col) * 4;
        if (occ < 0) {
          px.data[i] = 96; px.data[i + 1] = 122; px.data[i + 2] = 120;
        } else {
          px.data[i] = px.data[i + 1] = px.data[i + 2] = Math.round(220 * (1 - occ / 100));
        }
        px.data[i + 3] = 255;
      }
    }
    g.putImageData(px, 0, 0);
    grid = { ...m, img };
    draw();
  }

  function setScene(list) {
    markers = list;
    if (!cam || !userMoved) fit();
    draw();
  }

  // Frame the site (places, lanes, zones, targets); the map if there is no site yet.
  function fit() {
    let xs = [], ys = [];
    for (const m of markers) {
      if (!m.ns.startsWith('site/')) continue;
      for (const p of m.pts.length ? m.pts : [m.p]) { xs.push(p[0]); ys.push(p[1]); }
    }
    if (!xs.length && grid) {
      xs = [grid.origin[0], grid.origin[0] + grid.w * grid.res];
      ys = [grid.origin[1], grid.origin[1] + grid.h * grid.res];
    }
    if (!xs.length) return;
    const pad = 2.0;                   // metres of map around the site
    const x0 = Math.min(...xs) - pad, x1 = Math.max(...xs) + pad;
    const y0 = Math.min(...ys) - pad, y1 = Math.max(...ys) + pad;
    const { w, h } = size();
    // Frame it in the part of the map below the floating phase panel.
    const stage = document.getElementById('stage');
    const top = stage ? stage.getBoundingClientRect().bottom - canvas.getBoundingClientRect().top + 12 : 0;
    const k = Math.min(w / (x1 - x0), (h - top) / (y1 - y0));
    const cy = (y0 + y1) / 2;
    cam = { x: (x0 + x1) / 2, y: cy - (h / 2 - (top + (h - top) / 2)) / k, k };
  }

  function size() {
    const r = canvas.getBoundingClientRect();
    return { w: r.width, h: r.height };
  }

  const sx = (x) => (x - cam.x) * cam.k + size().w / 2;
  const sy = (y) => size().h / 2 - (y - cam.y) * cam.k;

  function draw() {
    const { w, h } = size();
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#607a78';           // as unknown map cells
    ctx.fillRect(0, 0, w, h);
    if (!cam) return;
    if (grid) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(grid.img, sx(grid.origin[0]), sy(grid.origin[1] + grid.h * grid.res),
        grid.w * grid.res * cam.k, grid.h * grid.res * cam.k);
    }
    // Top-down: higher markers over lower ones, labels last.
    const z = (m) => (m.t === TEXT ? 1e3 : m.pts.length ? m.pts[0][2] : m.p[2]);
    for (const m of [...markers].sort((a, b) => z(a) - z(b))) drawMarker(m);
  }

  function dot(x, y, r, color) {
    ctx.beginPath();
    ctx.arc(sx(x), sy(y), Math.max(2, r * cam.k), 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();
  }

  function box(x, y, yaw, lx, ly, color) {
    ctx.save();
    ctx.translate(sx(x), sy(y));
    ctx.rotate(-yaw);
    ctx.fillStyle = color;
    ctx.fillRect(-lx * cam.k / 2, -ly * cam.k / 2, lx * cam.k, ly * cam.k);
    ctx.strokeStyle = 'rgba(15,23,42,0.7)';   // outline: pale colours on the light map
    ctx.lineWidth = 1.5;
    ctx.strokeRect(-lx * cam.k / 2, -ly * cam.k / 2, lx * cam.k, ly * cam.k);
    ctx.restore();
  }

  function drawMarker(m) {
    const color = rgba(m.c);
    ctx.lineCap = ctx.lineJoin = 'round';
    switch (m.t) {
      case LINE_STRIP:
      case LINE_LIST: {
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(1.5, m.s[0] * cam.k);
        ctx.beginPath();
        m.pts.forEach((p, i) => {
          const move = m.t === LINE_LIST ? i % 2 === 0 : i === 0;
          move ? ctx.moveTo(sx(p[0]), sy(p[1])) : ctx.lineTo(sx(p[0]), sy(p[1]));
        });
        ctx.stroke();
        break;
      }
      case SPHERE_LIST:
      case POINTS:
        for (const p of m.pts) dot(p[0], p[1], m.s[0] / 2, color);
        break;
      case CUBE_LIST:
        for (const p of m.pts) box(p[0], p[1], 0, m.s[0], m.s[1], color);
        break;
      case SPHERE:
      case CYLINDER:
        dot(m.p[0], m.p[1], m.s[0] / 2, color);
        break;
      case CUBE:
        box(m.p[0], m.p[1], m.yaw, m.s[0], m.s[1], color);
        break;
      case ARROW: {
        if (m.pts.length < 2) break;
        const [a, b] = m.pts;
        const ang = Math.atan2(-(b[1] - a[1]), b[0] - a[0]);
        const head = Math.max(6, m.s[2] * cam.k);
        ctx.strokeStyle = ctx.fillStyle = color;
        ctx.lineWidth = Math.max(1.5, m.s[0] * cam.k);
        ctx.beginPath(); ctx.moveTo(sx(a[0]), sy(a[1])); ctx.lineTo(sx(b[0]), sy(b[1])); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(sx(b[0]), sy(b[1]));
        ctx.lineTo(sx(b[0]) - head * Math.cos(ang - 0.5), sy(b[1]) - head * Math.sin(ang - 0.5));
        ctx.lineTo(sx(b[0]) - head * Math.cos(ang + 0.5), sy(b[1]) - head * Math.sin(ang + 0.5));
        ctx.fill();
        break;
      }
      case TEXT: {
        const px = Math.max(11, Math.min(22, m.s[2] * cam.k));
        ctx.font = `600 ${px}px Inter, "Segoe UI", system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const lines = m.txt.split('\n');
        lines.forEach((line, i) => {
          const y = sy(m.p[1]) + (i - (lines.length - 1) / 2) * px * 1.1;
          ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,0.8)';
          ctx.strokeText(line, sx(m.p[0]), y);
          ctx.fillStyle = color;
          ctx.fillText(line, sx(m.p[0]), y);
        });
        break;
      }
      default:
        break;
    }
  }

  // --- pan / zoom -----------------------------------------------------------------
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag || !cam) return;
    cam.x -= (e.clientX - drag.x) / cam.k;
    cam.y += (e.clientY - drag.y) / cam.k;
    drag = { x: e.clientX, y: e.clientY };
    userMoved = true;
    draw();
  });
  canvas.addEventListener('pointerup', () => { drag = null; });
  canvas.addEventListener('wheel', (e) => {
    if (!cam) return;
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    // keep the world point under the cursor fixed
    const wx = cam.x + (mx - r.width / 2) / cam.k, wy = cam.y - (my - r.height / 2) / cam.k;
    cam.k *= Math.exp(-e.deltaY * 0.0015);
    cam.x = wx - (mx - r.width / 2) / cam.k;
    cam.y = wy + (my - r.height / 2) / cam.k;
    userMoved = true;
    draw();
  }, { passive: false });
  canvas.addEventListener('dblclick', () => { userMoved = false; fit(); draw(); });
  window.addEventListener('resize', () => { if (!userMoved) fit(); draw(); });

  return { setMap, setScene };
})();
