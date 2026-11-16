// Renderizador 2D em Canvas com zoom, pan, seleção e destaque.
import { pointInRing } from './scene.js';

const HILITE = '#ffb020';
const HOVER = '#4cc3ff';

export class Viewer {
  constructor(canvas, { onSelect, onHover, onCursor } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onSelect = onSelect || (() => {});
    this.onHover = onHover || (() => {});
    this.onCursor = onCursor || (() => {});
    this.scene = null;
    this.hidden = new Set(); // camadas ocultas
    this.s = 1; this.tx = 0; this.ty = 0;
    this.dpr = window.devicePixelRatio || 1;
    this.selectedId = -1;
    this.hoverId = -1;
    this.light = false;
    this.pathCache = new Map();
    this.pointers = new Map();
    this.frame = 0;
    this.bindEvents();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.resize();
  }

  /* ---------- cena ---------- */
  setScene(scene) {
    this.scene = scene;
    this.hidden = new Set(scene.layers.filter((l) => l.off).map((l) => l.name));
    this.selectedId = -1;
    this.hoverId = -1;
    this.pathCache.clear();
    this.buildBatches();
    this.buildGrid();
    this.fit();
  }

  clear() {
    this.scene = null;
    this.batches = null;
    this.request();
  }

  setLayerVisible(name, visible) {
    if (visible) this.hidden.delete(name); else this.hidden.add(name);
    this.buildBatches();
    this.request();
  }

  setLayersVisible(names, visible) {
    for (const n of names) { if (visible) this.hidden.delete(n); else this.hidden.add(n); }
    this.buildBatches();
    this.request();
  }

  setLight(light) {
    this.light = light;
    this.request();
  }

  isVisible(rec) {
    return !this.hidden.has(rec.layer);
  }

  buildBatches() {
    const strokes = new Map();
    const fills = [];
    const texts = [];
    const points = [];
    const strokeFor = (c) => {
      let p = strokes.get(c);
      if (!p) { p = new Path2D(); strokes.set(c, p); }
      return p;
    };
    for (const rec of this.scene.records) {
      if (!this.isVisible(rec)) continue;
      for (const pr of rec.prims) {
        const color = pr.col || rec.color;
        if (pr.k === 'l') addPoly(strokeFor(color), pr.p, pr.c);
        else if (pr.k === 'f') {
          const path = new Path2D();
          for (const ring of pr.rings) addPoly(path, ring, true);
          fills.push({ path, color, solid: pr.solid === undefined ? true : pr.solid });
        } else if (pr.k === 't') texts.push({ pr, color, bbox: rec.bbox });
        else if (pr.k === 'p') points.push({ x: pr.x, y: pr.y, color });
      }
    }
    this.batches = { strokes, fills, texts, points };
  }

  buildGrid() {
    const recs = this.scene.records;
    const { minX, minY, maxX, maxY } = this.extents();
    const w = Math.max(maxX - minX, 1e-9), h = Math.max(maxY - minY, 1e-9);
    const cs = Math.max(w, h) / 256;
    const nx = Math.ceil(w / cs) + 1, ny = Math.ceil(h / cs) + 1;
    const cells = new Map();
    const big = [];
    for (const r of recs) {
      const b = r.bbox;
      const x0 = Math.floor((b[0] - minX) / cs), x1 = Math.floor((b[2] - minX) / cs);
      const y0 = Math.floor((b[1] - minY) / cs), y1 = Math.floor((b[3] - minY) / cs);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > 2048) { big.push(r.id); continue; }
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const k = y * nx + x;
          let a = cells.get(k);
          if (!a) { a = []; cells.set(k, a); }
          a.push(r.id);
        }
      }
    }
    this.grid = { minX, minY, cs, nx, ny, cells, big };
    this.stamp = new Uint32Array(recs.length);
    this.stampId = 0;
  }

  extents() {
    // Extensão no sistema deslocado (a cena foi transladada para perto da origem)
    const e = this.scene.info.extents, o = this.scene.info.origin;
    return { minX: e.minX - o.x, minY: e.minY - o.y, maxX: e.maxX - o.x, maxY: e.maxY - o.y };
  }

  /* ---------- vista ---------- */
  resize() {
    const el = this.canvas.parentElement;
    const w = el.clientWidth, h = el.clientHeight;
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(w * this.dpr));
    this.canvas.height = Math.max(1, Math.round(h * this.dpr));
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    if (this.W && this.scene) {
      // mantém o centro da vista
      this.tx += (w - this.W) / 2;
      this.ty += (h - this.H) / 2;
    }
    this.W = w; this.H = h;
    this.request();
  }

  fitBox(minX, minY, maxX, maxY, margin = 0.06) {
    const w = Math.max(maxX - minX, 1e-9), h = Math.max(maxY - minY, 1e-9);
    const W = this.W || 1, H = this.H || 1;
    this.s = Math.min((W * (1 - 2 * margin)) / w, (H * (1 - 2 * margin)) / h);
    this.tx = W / 2 - ((minX + maxX) / 2) * this.s;
    this.ty = H / 2 + ((minY + maxY) / 2) * this.s;
    this.request();
  }

  fit() {
    if (!this.scene) return;
    const e = this.extents();
    this.fitBox(e.minX, e.minY, e.maxX, e.maxY);
  }

  zoomToRecord(id) {
    const r = this.scene && this.scene.records[id];
    if (!r) return;
    const b = r.bbox;
    const pad = Math.max(b[2] - b[0], b[3] - b[1]) * 0.6 || 1;
    this.fitBox(b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad, 0.02);
  }

  zoomAt(factor, sx, sy) {
    const ns = Math.min(Math.max(this.s * factor, 1e-9), 1e9);
    const f = ns / this.s;
    this.tx = sx - (sx - this.tx) * f;
    this.ty = sy - (sy - this.ty) * f;
    this.s = ns;
    this.request();
  }

  zoomBy(factor) {
    this.zoomAt(factor, this.W / 2, this.H / 2);
  }

  toWorld(sx, sy) {
    return [(sx - this.tx) / this.s, (this.ty - sy) / this.s];
  }

  /* ---------- seleção ---------- */
  select(id, { zoom = false, notify = true } = {}) {
    this.selectedId = id;
    if (zoom && id >= 0) this.zoomToRecord(id);
    this.request();
    if (notify) this.onSelect(id >= 0 ? this.scene.records[id] : null);
  }

  candidates(x0, y0, x1, y1) {
    const g = this.grid;
    const out = [];
    const st = ++this.stampId;
    const cx0 = Math.max(0, Math.floor((x0 - g.minX) / g.cs)), cx1 = Math.min(g.nx - 1, Math.floor((x1 - g.minX) / g.cs));
    const cy0 = Math.max(0, Math.floor((y0 - g.minY) / g.cs)), cy1 = Math.min(g.ny - 1, Math.floor((y1 - g.minY) / g.cs));
    for (let y = cy0; y <= cy1; y++) {
      for (let x = cx0; x <= cx1; x++) {
        const a = g.cells.get(y * g.nx + x);
        if (!a) continue;
        for (const id of a) if (this.stamp[id] !== st) { this.stamp[id] = st; out.push(id); }
      }
    }
    for (const id of g.big) if (this.stamp[id] !== st) { this.stamp[id] = st; out.push(id); }
    return out;
  }

  pick(sx, sy) {
    if (!this.scene) return -1;
    const [wx, wy] = this.toWorld(sx, sy);
    const tol = 6 / this.s;
    const recs = this.scene.records;
    let best = -1, bestD = tol;
    let encl = -1, enclA = Infinity;
    for (const id of this.candidates(wx - tol, wy - tol, wx + tol, wy + tol)) {
      const r = recs[id];
      if (!this.isVisible(r)) continue;
      const b = r.bbox;
      if (wx < b[0] - tol || wx > b[2] + tol || wy < b[1] - tol || wy > b[3] + tol) continue;
      const { d, inside } = recDistance(r, wx, wy, bestD);
      if (d < bestD) { bestD = d; best = id; }
      if (inside) {
        const a = area(r);
        if (a < enclA) { enclA = a; encl = id; }
      }
    }
    return best >= 0 ? best : encl;
  }

  /* ---------- eventos ---------- */
  bindEvents() {
    const c = this.canvas;
    c.addEventListener('wheel', (e) => {
      if (!this.scene) return;
      e.preventDefault();
      const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const r = c.getBoundingClientRect();
      this.zoomAt(Math.exp(-e.deltaY * k * 0.0015), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });

    c.addEventListener('pointerdown', (e) => {
      if (!this.scene) return;
      c.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY });
      this.moved = false;
      if (this.pointers.size === 2) this.pinch = this.pinchState();
    });

    c.addEventListener('pointermove', (e) => {
      const r = c.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      if (this.scene) {
        const [wx, wy] = this.toWorld(sx, sy);
        const o = this.scene.info.origin;
        this.onCursor(wx + o.x, wy + o.y);
      }
      const p = this.pointers.get(e.pointerId);
      if (!p) { this.scheduleHover(sx, sy); return; }
      if (this.pointers.size === 1) {
        if (Math.hypot(e.clientX - p.x0, e.clientY - p.y0) > 3) this.moved = true;
        if (this.moved) {
          this.tx += e.clientX - p.x;
          this.ty += e.clientY - p.y;
          c.style.cursor = 'grabbing';
          this.request();
        }
      }
      p.x = e.clientX; p.y = e.clientY;
      if (this.pointers.size === 2 && this.pinch) {
        this.moved = true;
        const now = this.pinchState();
        const f = now.d / (this.pinch.d || 1);
        this.tx += now.mx - this.pinch.mx;
        this.ty += now.my - this.pinch.my;
        this.zoomAt(f, now.mx - r.left, now.my - r.top);
        this.pinch = now;
      }
    });

    const end = (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinch = null;
      c.style.cursor = '';
      if (!this.moved && e.type === 'pointerup' && this.pointers.size === 0) {
        const r = c.getBoundingClientRect();
        this.select(this.pick(e.clientX - r.left, e.clientY - r.top));
      }
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => {
      if (this.hoverId !== -1) { this.hoverId = -1; this.onHover(null); this.request(); }
    });
    c.addEventListener('dblclick', () => this.fit());
  }

  pinchState() {
    const [a, b] = [...this.pointers.values()];
    return { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  }

  scheduleHover(sx, sy) {
    if (!this.scene) return;
    this.hoverPos = [sx, sy];
    if (this.hoverPending) return;
    this.hoverPending = true;
    requestAnimationFrame(() => {
      this.hoverPending = false;
      const id = this.pick(...this.hoverPos);
      if (id !== this.hoverId) {
        this.hoverId = id;
        this.canvas.style.cursor = id >= 0 ? 'pointer' : '';
        this.onHover(id >= 0 ? this.scene.records[id] : null);
        this.request();
      }
    });
  }

  /* ---------- desenho ---------- */
  request() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.draw(); });
  }

  col(c) {
    if (!this.light) return c;
    // Em fundo claro, branco/quase branco vira preto (como no AutoCAD)
    const n = parseInt(c.slice(1), 16);
    const r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    return r > 200 && g > 200 && b > 200 ? '#000000' : c;
  }

  recordPath(id) {
    let p = this.pathCache.get(id);
    if (!p) {
      p = new Path2D();
      for (const pr of this.scene.records[id].prims) {
        if (pr.k === 'l') addPoly(p, pr.p, pr.c);
        else if (pr.k === 'f') for (const ring of pr.rings) addPoly(p, ring, true);
        else if (pr.k === 't') addPoly(p, pr.box, true);
      }
      if (this.pathCache.size > 200) this.pathCache.clear();
      this.pathCache.set(id, p);
    }
    return p;
  }

  draw() {
    const ctx = this.ctx, d = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.light ? '#ffffff' : '#14171c';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.scene || !this.batches) return;
    const { strokes, fills, texts, points } = this.batches;
    const s = this.s;

    ctx.setTransform(d * s, 0, 0, -d * s, d * this.tx, d * this.ty);
    for (const f of fills) {
      ctx.globalAlpha = f.solid ? 0.6 : 0.16;
      ctx.fillStyle = this.col(f.color);
      ctx.fill(f.path, 'evenodd');
    }
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1 / s;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const [color, path] of strokes) {
      ctx.strokeStyle = this.col(color);
      ctx.stroke(path);
    }

    // Destaques
    const hl = (id, color, width, fillAlpha) => {
      if (id < 0) return;
      const rec = this.scene.records[id];
      const p = this.recordPath(id);
      if (fillAlpha && rec.closed) {
        ctx.globalAlpha = fillAlpha;
        ctx.fillStyle = color;
        ctx.fill(p, 'evenodd');
        ctx.globalAlpha = 1;
      }
      ctx.lineWidth = width / s;
      ctx.strokeStyle = color;
      ctx.stroke(p);
    };
    if (this.hoverId !== this.selectedId) hl(this.hoverId, HOVER, 2, 0.12);
    hl(this.selectedId, HILITE, 3, 0.22);

    // Textos e pontos em coordenadas de tela
    ctx.setTransform(d, 0, 0, d, 0, 0);
    const W = this.W, H = this.H;
    for (const { pr, color, bbox } of texts) {
      const hpx = pr.h * s;
      if (hpx < 2.5 || hpx > 4000) continue;
      const x0 = bbox[0] * s + this.tx, x1 = bbox[2] * s + this.tx;
      const y0 = this.ty - bbox[3] * s, y1 = this.ty - bbox[1] * s;
      if (x1 < 0 || x0 > W || y1 < 0 || y0 > H) continue;
      ctx.save();
      ctx.translate(pr.x * s + this.tx, this.ty - pr.y * s);
      ctx.rotate(-pr.r);
      if (pr.xs && pr.xs !== 1) ctx.scale(pr.xs, 1);
      ctx.fillStyle = this.col(color);
      ctx.font = `${hpx}px "Arial Narrow", Arial, sans-serif`;
      ctx.textAlign = pr.ha;
      if (pr.multi) {
        const lh = hpx * 1.6;
        const total = pr.lines.length * lh - (lh - hpx);
        let y = pr.va === 'top' ? 0 : pr.va === 'middle' ? -total / 2 : -total;
        ctx.textBaseline = 'top';
        for (const line of pr.lines) { ctx.fillText(line, 0, y); y += lh; }
      } else {
        ctx.textBaseline = pr.va;
        ctx.fillText(pr.lines[0], 0, 0);
      }
      ctx.restore();
    }
    for (const p of points) {
      const x = p.x * s + this.tx, y = this.ty - p.y * s;
      if (x < 0 || x > W || y < 0 || y > H) continue;
      ctx.fillStyle = this.col(p.color);
      ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
    }
  }
}

function addPoly(path, p, closed) {
  if (p.length < 2) return;
  path.moveTo(p[0], p[1]);
  for (let i = 2; i < p.length; i += 2) path.lineTo(p[i], p[i + 1]);
  if (closed) path.closePath();
}

function area(r) {
  if (r.m && r.m.area > 0) return r.m.area;
  const b = r.bbox;
  return (b[2] - b[0]) * (b[3] - b[1]);
}

function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function polyDist(p, closed, x, y, limit) {
  let d = Infinity;
  const n = p.length;
  if (n === 2) return Math.hypot(x - p[0], y - p[1]);
  for (let i = 2; i < n; i += 2) {
    const v = segDist(x, y, p[i - 2], p[i - 1], p[i], p[i + 1]);
    if (v < d) { d = v; if (d === 0) return 0; }
  }
  if (closed && n >= 6) d = Math.min(d, segDist(x, y, p[n - 2], p[n - 1], p[0], p[1]));
  return d;
}

// Distância do ponto à entidade (bordas) e se o ponto está dentro de uma região fechada.
function recDistance(r, x, y, limit) {
  let d = Infinity;
  let inside = false;
  for (const pr of r.prims) {
    if (pr.k === 'l') {
      d = Math.min(d, polyDist(pr.p, pr.c, x, y, limit));
      if (r.closed && pr.c && pointInRing(x, y, pr.p)) inside = !inside;
    } else if (pr.k === 'f') {
      for (const ring of pr.rings) {
        d = Math.min(d, polyDist(ring, true, x, y, limit));
        if (pointInRing(x, y, ring)) inside = !inside;
      }
    } else if (pr.k === 't') {
      if (pointInRing(x, y, pr.box)) d = 0;
    } else if (pr.k === 'p') {
      d = Math.min(d, Math.hypot(x - pr.x, y - pr.y));
    }
  }
  return { d, inside };
}
