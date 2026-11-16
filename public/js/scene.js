// Converte o DwgDatabase (libredwg-web) em uma "cena" 2D pronta para desenhar:
// cada entidade vira um registro com primitivas em coordenadas do mundo (WCS)
// e métricas (área, perímetro, comprimento) calculadas de forma exata quando possível.
//
// Primitivas:
//   { k: 'l', p: Float64Array[x0,y0,x1,y1,...], c: fechado? }   linha/polilinha
//   { k: 'f', rings: [Float64Array, ...] }                       preenchimento (par-ímpar)
//   { k: 't', x, y, h, r, lines: [...], ha, va }                 texto
//   { k: 'p', x, y }                                             ponto
// Qualquer primitiva pode ter `col` (cor própria, usada em cotas).

import { aciToHex, intToHex } from './aci.js';

const TAU = Math.PI * 2;
const MAX_DEPTH = 16;
const MAX_INSERT_COPIES = 2500;
const MAX_RECORDS = 600000;
const CIRCLE_SEGMENTS = 96;

export const UNITS = {
  0: { name: 'Sem unidade', abbr: 'u', m: null },
  1: { name: 'Polegadas', abbr: 'in', m: 0.0254 },
  2: { name: 'Pés', abbr: 'ft', m: 0.3048 },
  3: { name: 'Milhas', abbr: 'mi', m: 1609.344 },
  4: { name: 'Milímetros', abbr: 'mm', m: 0.001 },
  5: { name: 'Centímetros', abbr: 'cm', m: 0.01 },
  6: { name: 'Metros', abbr: 'm', m: 1 },
  7: { name: 'Quilômetros', abbr: 'km', m: 1000 },
  10: { name: 'Jardas', abbr: 'yd', m: 0.9144 },
  14: { name: 'Decímetros', abbr: 'dm', m: 0.1 },
};

const VERSIONS = {
  AC1009: 'AutoCAD R11/R12', AC1012: 'AutoCAD R13', AC1014: 'AutoCAD R14',
  AC1015: 'AutoCAD 2000–2002', AC1018: 'AutoCAD 2004–2006', AC1021: 'AutoCAD 2007–2009',
  AC1024: 'AutoCAD 2010–2012', AC1027: 'AutoCAD 2013–2017', AC1032: 'AutoCAD 2018 ou superior',
};

/* ---------------- matrizes afins 2D: [a, b, c, d, e, f] ----------------
   x' = a·x + c·y + e ;  y' = b·x + d·y + f                                   */
const ID = [1, 0, 0, 1, 0, 0];
const MIRROR_X = [-1, 0, 0, 1, 0, 0];
function mul(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}
const translate = (x, y) => [1, 0, 0, 1, x, y];
const rotate = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, s, -s, c, 0, 0]; };
const scale = (sx, sy) => [sx, 0, 0, sy, 0, 0];
const det = (m) => m[0] * m[3] - m[1] * m[2];
function isSimilarity(m) {
  const tol = 1e-6 * (Math.abs(m[0]) + Math.abs(m[1]) + Math.abs(m[2]) + Math.abs(m[3]));
  return (Math.abs(m[0] - m[3]) <= tol && Math.abs(m[1] + m[2]) <= tol) ||
    (Math.abs(m[0] + m[3]) <= tol && Math.abs(m[1] - m[2]) <= tol);
}
// Entidades com extrusão (0,0,-1) têm o sistema de coordenadas do objeto (OCS) espelhado em X.
function withOcs(M, e) {
  const z = e && e.extrusionDirection && e.extrusionDirection.z;
  return typeof z === 'number' && z < -1e-9 ? mul(M, MIRROR_X) : M;
}
function tf(M, local) {
  const n = local.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 2) {
    const x = local[i], y = local[i + 1];
    out[i] = M[0] * x + M[2] * y + M[4];
    out[i + 1] = M[1] * x + M[3] * y + M[5];
  }
  return out;
}
function tfPt(M, x, y) {
  return [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]];
}

/* ---------------- geometria ---------------- */
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const normAngle = (a) => { a %= TAU; return a < 0 ? a + TAU : a; };

// Ângulo positivo de start até end (anti-horário), em (0, 2π].
function ccwSweep(a0, a1) {
  const s = normAngle(a1 - a0);
  return s < 1e-12 ? TAU : s;
}

function segCount(sweep) {
  return Math.max(2, Math.ceil((Math.abs(sweep) / TAU) * CIRCLE_SEGMENTS));
}

// Acrescenta pontos de um arco. Se includeFirst=false, omite o ponto inicial.
function arcPts(cx, cy, rx, ry, rot, a0, sweep, out, includeFirst = true) {
  const n = segCount(sweep);
  const cr = Math.cos(rot), sr = Math.sin(rot);
  for (let i = includeFirst ? 0 : 1; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    const x = rx * Math.cos(a), y = ry * Math.sin(a);
    out.push(cx + x * cr - y * sr, cy + x * sr + y * cr);
  }
}

// Segmento de polilinha com bulge (tan(θ/4)); acrescenta pontos após p1 até p2.
function bulgeSeg(x1, y1, x2, y2, b, out) {
  const dx = x2 - x1, dy = y2 - y1, c = Math.hypot(dx, dy);
  if (!b || Math.abs(b) < 1e-12 || c < 1e-12) { out.push(x2, y2); return; }
  const th = 4 * Math.atan(b);
  const r = c / (2 * Math.sin(th / 2)); // com sinal
  const h = r * Math.cos(th / 2);
  const cx = (x1 + x2) / 2 - (h * dy) / c;
  const cy = (y1 + y2) / 2 + (h * dx) / c;
  const a0 = Math.atan2(y1 - cy, x1 - cx);
  const R = Math.abs(r);
  const n = segCount(th);
  for (let i = 1; i < n; i++) {
    const a = a0 + (th * i) / n;
    out.push(cx + R * Math.cos(a), cy + R * Math.sin(a));
  }
  out.push(x2, y2);
}

function prepVerts(raw, flagClosed) {
  const v = [];
  for (const p of raw || []) {
    if (p && fin(p.x) && fin(p.y)) v.push({ x: p.x, y: p.y, bulge: fin(p.bulge) ? p.bulge : 0 });
  }
  let closed = !!flagClosed;
  if (v.length > 2) {
    const a = v[0], z = v[v.length - 1];
    const tol = 1e-9 * Math.max(1, Math.abs(a.x), Math.abs(a.y));
    if (Math.abs(a.x - z.x) <= tol && Math.abs(a.y - z.y) <= tol) { v.pop(); closed = true; }
  }
  if (closed && !(v.length >= 3 || (v.length === 2 && v.some((p) => p.bulge)))) closed = false;
  return { v, closed };
}

function flattenBulged(v, closed) {
  const out = [];
  const n = v.length;
  if (!n) return out;
  out.push(v[0].x, v[0].y);
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = v[i], b = v[(i + 1) % n];
    bulgeSeg(a.x, a.y, b.x, b.y, a.bulge, out);
  }
  if (closed) out.length -= 2; // último ponto == primeiro
  return out;
}

// Área (exata, incluindo segmentos de arco) e comprimento de uma polilinha com bulges.
function polyMetrics(v, closed) {
  let a2 = 0, seg = 0, len = 0;
  const n = v.length;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = v[i], b = v[(i + 1) % n];
    a2 += a.x * b.y - b.x * a.y;
    const c = Math.hypot(b.x - a.x, b.y - a.y);
    if (Math.abs(a.bulge) > 1e-12 && c > 1e-12) {
      const th = 4 * Math.atan(a.bulge);
      const r = c / (2 * Math.abs(Math.sin(th / 2)));
      len += r * Math.abs(th);
      seg += ((r * r) / 2) * (th - Math.sin(th));
    } else len += c;
  }
  return { length: len, area: closed ? Math.abs(a2 / 2 + seg) : null };
}

export function ringArea(p) {
  let s = 0;
  const n = p.length;
  for (let i = 0; i < n; i += 2) {
    const j = (i + 2) % n;
    s += p[i] * p[j + 1] - p[j] * p[i + 1];
  }
  return s / 2;
}

function pathLength(p, closed) {
  let len = 0;
  const n = p.length;
  for (let i = 2; i < n; i += 2) len += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
  if (closed && n >= 4) len += Math.hypot(p[0] - p[n - 2], p[1] - p[n - 1]);
  return len;
}

export function pointInRing(x, y, p) {
  let inside = false;
  const n = p.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const xi = p[i], yi = p[i + 1], xj = p[j], yj = p[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// NURBS por de Boor. ctrl: [{x,y}], weights opcional.
function nurbsPts(deg, knots, ctrl, weights) {
  const m = ctrl.length;
  const p = deg | 0;
  if (m < 2 || p < 1 || !knots || knots.length !== m + p + 1) {
    const out = [];
    for (const c of ctrl) out.push(c.x, c.y);
    return out;
  }
  const t0 = knots[p], t1 = knots[m];
  const samples = Math.min(2000, Math.max(32, m * 10));
  const out = [];
  const d = new Array(p + 1);
  for (let si = 0; si <= samples; si++) {
    const t = t0 + ((t1 - t0) * si) / samples;
    let s = p;
    while (s < m - 1 && knots[s + 1] <= t) s++;
    for (let j = 0; j <= p; j++) {
      const c = ctrl[s - p + j];
      const w = weights && fin(weights[s - p + j]) && weights[s - p + j] > 0 ? weights[s - p + j] : 1;
      d[j] = [c.x * w, c.y * w, w];
    }
    for (let r = 1; r <= p; r++) {
      for (let j = p; j >= r; j--) {
        const i = s - p + j;
        const den = knots[i + p - r + 1] - knots[i];
        const a = den ? (t - knots[i]) / den : 0;
        d[j] = [
          (1 - a) * d[j - 1][0] + a * d[j][0],
          (1 - a) * d[j - 1][1] + a * d[j][1],
          (1 - a) * d[j - 1][2] + a * d[j][2],
        ];
      }
    }
    const w = d[p][2] || 1;
    out.push(d[p][0] / w, d[p][1] / w);
  }
  return out;
}

function pushUnique(out, x, y) {
  const n = out.length;
  if (n >= 2) {
    const tol = 1e-9 * Math.max(1, Math.abs(x), Math.abs(y));
    if (Math.abs(out[n - 2] - x) <= tol && Math.abs(out[n - 1] - y) <= tol) return;
  }
  out.push(x, y);
}

function closeRing(out) {
  const n = out.length;
  if (n >= 4) {
    const tol = 1e-7 * Math.max(1, Math.abs(out[0]), Math.abs(out[1]));
    if (Math.abs(out[0] - out[n - 2]) <= tol && Math.abs(out[1] - out[n - 1]) <= tol) out.length -= 2;
  }
  return out;
}

// Contorno de hachura definido por arestas (linha, arco, elipse, spline).
function edgeLoop(edges) {
  const out = [];
  for (const ed of edges || []) {
    const tmp = [];
    switch (ed.type) {
      case 1: // linha
        if (ed.start && ed.end) tmp.push(ed.start.x, ed.start.y, ed.end.x, ed.end.y);
        break;
      case 2: { // arco
        if (!ed.center || !fin(ed.radius)) break;
        const ccw = ed.isCCW !== false;
        let a0 = ed.startAngle || 0, a1 = ed.endAngle || 0;
        if (ccw) arcPts(ed.center.x, ed.center.y, ed.radius, ed.radius, 0, a0, ccwSweep(a0, a1), tmp);
        else arcPts(ed.center.x, ed.center.y, ed.radius, ed.radius, 0, -a0, -ccwSweep(a0, a1), tmp);
        break;
      }
      case 3: { // arco de elipse
        if (!ed.center || !ed.end) break;
        const rx = Math.hypot(ed.end.x, ed.end.y);
        const ry = rx * (ed.lengthOfMinorAxis || 1);
        const rot = Math.atan2(ed.end.y, ed.end.x);
        const ccw = ed.isCCW !== false;
        const a0 = ed.startAngle || 0, a1 = ed.endAngle || 0;
        if (ccw) arcPts(ed.center.x, ed.center.y, rx, ry, rot, a0, ccwSweep(a0, a1), tmp);
        else arcPts(ed.center.x, ed.center.y, rx, ry, rot, -a0, -ccwSweep(a0, a1), tmp);
        break;
      }
      case 4: { // spline
        const cps = ed.controlPoints || [];
        if (cps.length >= 2) {
          const w = cps.map((c) => c.weight);
          tmp.push(...nurbsPts(ed.degree, ed.knots, cps, w.some(fin) ? w : null));
        } else if ((ed.fitDatum || []).length >= 2) {
          for (const f of ed.fitDatum) tmp.push(f.x, f.y);
        }
        break;
      }
    }
    for (let i = 0; i < tmp.length; i += 2) pushUnique(out, tmp[i], tmp[i + 1]);
  }
  return closeRing(out);
}

/* ---------------- textos ---------------- */
function cleanText(s) {
  if (!s) return '';
  return String(s)
    .replace(/%%[cC]/g, 'Ø').replace(/%%[dD]/g, '°').replace(/%%[pP]/g, '±')
    .replace(/%%[uUoOkK]/g, '').replace(/%%%/g, '%');
}

function cleanMText(s) {
  if (!s) return '';
  const BS = '\u0000';
  return cleanText(
    String(s)
      .replace(/\\\\/g, BS)
      .replace(/\\P/g, '\n')
      .replace(/\\X/g, '\n')
      .replace(/\\S([^;]*?)[\^#/]([^;]*);/g, '$1/$2')
      .replace(/\\[ACcFfHhQqTtWwp][^;\\]*;/g, '')
      .replace(/\\[LlOoKkN]/g, '')
      .replace(/\\~/g, ' ')
      .replace(/\\([{}])/g, '$1\u0001')
      .replace(/[{}](?!\u0001)/g, '')
      .replace(/\u0001/g, '')
      .split(BS).join('\\'),
  );
}

function wrapLine(line, maxChars) {
  if (line.length <= maxChars) return [line];
  const out = [];
  let cur = '';
  for (const word of line.split(' ')) {
    if (cur && (cur + ' ' + word).length > maxChars) { out.push(cur); cur = word; }
    else cur = cur ? cur + ' ' + word : word;
  }
  if (cur) out.push(cur);
  return out;
}

const HALIGN = ['left', 'center', 'right', 'left', 'center', 'left'];
const VALIGN = ['alphabetic', 'bottom', 'middle', 'top'];

/* ---------------- construção da cena ---------------- */
class SceneBuilder {
  constructor(db) {
    this.db = db;
    this.blocks = new Map();
    for (const br of db.tables?.BLOCK_RECORD?.entries || []) {
      if (br && br.name) this.blocks.set(br.name.toUpperCase(), br);
    }
    this.layers = new Map();
    for (const l of db.tables?.LAYER?.entries || []) if (l && l.name != null) this.layers.set(l.name, l);
    this.layerColor = new Map();
    for (const [name, l] of this.layers) this.layerColor.set(name, this.resolveLayerColor(l));
    this.records = [];
    this.texts = [];
    this.typeCounts = {};
    this.skipped = {};
    this.errors = 0;
    this.truncated = false;
  }

  resolveLayerColor(l) {
    const ci = Math.abs(l.colorIndex | 0);
    if (ci >= 1 && ci <= 255) return ci === 7 ? '#ffffff' : aciToHex(ci);
    if (fin(l.color)) return intToHex(l.color);
    return '#ffffff';
  }

  isLayerOff(l) {
    return !!(l && (l.off || l.frozen || (l.colorIndex | 0) < 0));
  }

  color(e, layer, ctx) {
    if (fin(e.color)) return intToHex(e.color);
    const ci = e.colorIndex;
    if (ci === 0) return ctx.byBlock;
    if (fin(ci) && ci >= 1 && ci <= 255) return ci === 7 ? '#ffffff' : aciToHex(ci);
    return this.layerColor.get(layer) || '#ffffff';
  }

  run() {
    const ms = this.blocks.get('*MODEL_SPACE');
    let ents;
    if (ms && Array.isArray(ms.entities) && ms.entities.length) ents = ms.entities;
    else ents = (this.db.entities || []).filter((e) => !e.isInPaperSpace && e.type !== 'ATTRIB');
    this.topCount = ents.length;
    const ctx = { M: ID, layer: null, byBlock: '#ffffff', block: null, depth: 0, stack: [], sink: null };
    for (const e of ents) {
      if (!e) continue;
      this.typeCounts[e.type] = (this.typeCounts[e.type] || 0) + 1;
      this.safeEntity(e, ctx);
      if (this.truncated) break;
    }
  }

  safeEntity(e, ctx) {
    try {
      this.entity(e, ctx);
    } catch (err) {
      this.errors++;
      this.skip(e.type);
    }
  }

  skip(type) {
    this.skipped[type] = (this.skipped[type] || 0) + 1;
  }

  add(e, ctx, layer, color, prims, local, opts = {}) {
    if (!prims.length) return;
    if (ctx.sink) {
      for (const p of prims) { if (!p.col) p.col = color; ctx.sink.push(p); }
      return;
    }
    const bbox = primsBBox(prims);
    if (!bbox) return;
    const M = opts.M || ctx.M;
    const m = {};
    const d = Math.abs(det(M));
    const sim = isSimilarity(M);
    if (local) {
      if (local.area != null) m.area = local.area * d;
      if (local.length != null) {
        m.length = sim ? local.length * Math.sqrt(d) : prims.reduce((s, p) => s + (p.k === 'l' ? pathLength(p.p, p.c) : 0), 0);
      }
      if (local.radius != null && sim) m.radius = local.radius * Math.sqrt(d);
      if (local.world) Object.assign(m, local.world);
    }
    if (this.records.length >= MAX_RECORDS) { this.truncated = true; return; }
    this.records.push({
      id: this.records.length,
      type: opts.type || e.type,
      handle: e.handle || '',
      layer,
      color,
      block: ctx.block,
      closed: !!opts.closed,
      prims,
      bbox,
      m,
    });
  }

  entity(e, ctx) {
    if (e.isVisible === false) return;
    const layer = ctx.layer && (!e.layer || e.layer === '0') ? ctx.layer : e.layer || '0';
    const color = this.color(e, layer, ctx);
    const M = ctx.M;

    switch (e.type) {
      case 'LINE': {
        const s = e.startPoint, t = e.endPoint;
        if (!s || !t) return;
        const w = tf(M, [s.x, s.y, t.x, t.y]);
        this.add(e, ctx, layer, color, [{ k: 'l', p: w, c: false }], { world: { length: Math.hypot(w[2] - w[0], w[3] - w[1]) } });
        return;
      }
      case 'LWPOLYLINE': {
        const flag = e.flag | 0;
        const { v, closed } = prepVerts(e.vertices, (flag & 512) !== 0);
        this.polyline(e, ctx, layer, color, v, closed, withOcs(M, e));
        return;
      }
      case 'POLYLINE2D': {
        const flag = e.flag | 0;
        if (flag & (16 | 64)) { this.mesh(e, ctx, layer, color); return; }
        const raw = (e.vertices || []).filter((p) => !((p.flag | 0) & 16));
        const { v, closed } = prepVerts(raw, (flag & 1) !== 0);
        this.polyline(e, ctx, layer, color, v, closed, withOcs(M, e));
        return;
      }
      case 'POLYLINE3D': {
        const flag = e.flag | 0;
        const raw = (e.vertices || []).filter((p) => !((p.flag | 0) & 16)).map((p) => ({ x: p.x, y: p.y, bulge: 0 }));
        const { v, closed } = prepVerts(raw, (flag & 1) !== 0);
        this.polyline(e, ctx, layer, color, v, closed, M);
        return;
      }
      case 'CIRCLE': {
        if (!e.center || !fin(e.radius) || e.radius <= 0) return;
        const Mo = withOcs(M, e);
        const loc = [];
        arcPts(e.center.x, e.center.y, e.radius, e.radius, 0, 0, TAU, loc);
        loc.length -= 2;
        const r = e.radius;
        this.add(e, ctx, layer, color, [{ k: 'l', p: tf(Mo, loc), c: true }],
          { area: Math.PI * r * r, length: TAU * r, radius: r }, { M: Mo, closed: true });
        return;
      }
      case 'ARC': {
        if (!e.center || !fin(e.radius) || e.radius <= 0) return;
        const Mo = withOcs(M, e);
        const sweep = ccwSweep(e.startAngle || 0, e.endAngle || 0);
        const loc = [];
        arcPts(e.center.x, e.center.y, e.radius, e.radius, 0, e.startAngle || 0, sweep, loc);
        this.add(e, ctx, layer, color, [{ k: 'l', p: tf(Mo, loc), c: false }],
          { length: e.radius * sweep, radius: e.radius, world: { angle: (sweep * 180) / Math.PI } }, { M: Mo });
        return;
      }
      case 'ELLIPSE': {
        const c = e.center, mj = e.majorAxisEndPoint;
        if (!c || !mj) return;
        const a = Math.hypot(mj.x, mj.y);
        const ratio = e.axisRatio || 1;
        const b = a * ratio;
        let rot = Math.atan2(mj.y, mj.x);
        const s0 = e.startAngle || 0, s1 = e.endAngle ?? TAU;
        const sweep = ccwSweep(s0, s1);
        const full = Math.abs(sweep - TAU) < 1e-9;
        const loc = [];
        const flip = e.extrusionDirection && e.extrusionDirection.z < -1e-9;
        arcPts(c.x, c.y, a, flip ? -b : b, rot, s0, sweep, loc);
        if (full) loc.length -= 2;
        const w = tf(M, loc);
        const local = { length: null };
        if (full) {
          local.area = Math.PI * a * b;
          const h = ((a - b) * (a - b)) / ((a + b) * (a + b));
          local.length = Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h))); // Ramanujan
        } else local.world = { length: pathLength(w, false) };
        if (local.length == null) delete local.length;
        this.add(e, ctx, layer, color, [{ k: 'l', p: w, c: full }], local, { closed: full });
        return;
      }
      case 'SPLINE': {
        let loc;
        const cps = e.controlPoints || [];
        if (cps.length >= 2) loc = nurbsPts(e.degree, e.knots, cps, e.weights && e.weights.length === cps.length ? e.weights : null);
        else if ((e.fitPoints || []).length >= 2) { loc = []; for (const f of e.fitPoints) loc.push(f.x, f.y); }
        else return;
        const closed = ((e.flag | 0) & 1) !== 0;
        const w = tf(M, closed ? closeRing(loc) : loc);
        const world = { length: pathLength(w, closed) };
        if (closed && w.length >= 6) world.area = Math.abs(ringArea(w));
        this.add(e, ctx, layer, color, [{ k: 'l', p: w, c: closed }], { world }, { closed });
        return;
      }
      case 'HATCH': {
        this.hatch(e, ctx, layer, color);
        return;
      }
      case 'SOLID':
      case 'TRACE': {
        const cs = [e.corner1, e.corner2, e.corner4 || e.corner3, e.corner3].filter(Boolean);
        if (cs.length < 3) return;
        const loc = [];
        for (const p of cs) pushUnique(loc, p.x, p.y);
        closeRing(loc);
        const Mo = withOcs(M, e);
        const w = tf(Mo, loc);
        this.add(e, ctx, layer, color, [{ k: 'f', rings: [w] }],
          { area: Math.abs(ringArea(loc)), length: pathLength(loc, true) }, { M: Mo, closed: true });
        return;
      }
      case '3DFACE': {
        const cs = [e.corner1, e.corner2, e.corner3, e.corner4].filter(Boolean);
        if (cs.length < 3) return;
        const loc = [];
        for (const p of cs) pushUnique(loc, p.x, p.y);
        closeRing(loc);
        this.add(e, ctx, layer, color, [{ k: 'l', p: tf(M, loc), c: true }], null);
        return;
      }
      case 'POINT': {
        if (!e.position) return;
        const [x, y] = tfPt(M, e.position.x, e.position.y);
        this.add(e, ctx, layer, color, [{ k: 'p', x, y }], null);
        return;
      }
      case 'LEADER': {
        const vs = e.vertices || [];
        if (vs.length < 2) return;
        const loc = [];
        for (const p of vs) loc.push(p.x, p.y);
        const w = tf(M, loc);
        this.add(e, ctx, layer, color, [{ k: 'l', p: w, c: false }], { world: { length: pathLength(w, false) } });
        return;
      }
      case 'MLINE': {
        // Cada elemento da multilinha é deslocado do vértice ao longo da direção de mitra.
        const vs = e.vertices || [];
        if (vs.length < 2) return;
        const nLines = Math.max(...vs.map((v) => (v.lines || []).length), 0);
        const closed = ((e.flags | 0) & 2) !== 0;
        const prims = [];
        let len = 0;
        for (let li = 0; li < nLines; li++) {
          const loc = [];
          for (const v of vs) {
            const off = v.lines?.[li]?.segmentParams?.[0] ?? 0;
            const md = v.miterDirection || { x: 0, y: 0 };
            loc.push(v.vertex.x + md.x * off, v.vertex.y + md.y * off);
          }
          const w = tf(M, loc);
          len = Math.max(len, pathLength(w, closed));
          prims.push({ k: 'l', p: w, c: closed });
        }
        if (prims.length) this.add(e, ctx, layer, color, prims, { world: { length: len } });
        return;
      }
      case 'TEXT': {
        this.text(e, e, ctx, layer, color);
        return;
      }
      case 'ATTRIB': {
        if ((e.flags | 0) & 1) return; // atributo invisível
        if (e.text) this.text(e, e.text, ctx, layer, color);
        return;
      }
      case 'MTEXT': {
        this.mtext(e, ctx, layer, color);
        return;
      }
      case 'INSERT': {
        this.insert(e, ctx, layer, color);
        return;
      }
      case 'DIMENSION': {
        this.dimension(e, ctx, layer, color);
        return;
      }
      default:
        if (ctx.depth === 0) this.skip(e.type);
    }
  }

  polyline(e, ctx, layer, color, v, closed, Mo) {
    if (v.length < 2) return;
    const loc = flattenBulged(v, closed);
    const local = polyMetrics(v, closed);
    this.add(e, ctx, layer, color, [{ k: 'l', p: tf(Mo, loc), c: closed }], local, { M: Mo, closed });
  }

  mesh(e, ctx, layer, color) {
    // Malhas/polyface: desenha apenas as arestas entre vértices consecutivos.
    const vs = (e.vertices || []).filter((p) => fin(p.x) && fin(p.y));
    if (vs.length < 2) return;
    const loc = [];
    for (const p of vs) loc.push(p.x, p.y);
    this.add(e, ctx, layer, color, [{ k: 'l', p: tf(ctx.M, loc), c: false }], null);
  }

  hatch(e, ctx, layer, color) {
    const loops = [];
    for (const path of e.boundaryPaths || []) {
      let ring;
      if (Array.isArray(path.vertices)) {
        const { v } = prepVerts(path.vertices, true);
        if (v.length < 2) continue;
        ring = flattenBulged(v, true);
      } else if (Array.isArray(path.edges)) {
        ring = edgeLoop(path.edges);
      } else continue;
      if (ring.length >= 6) loops.push(ring);
    }
    if (!loops.length) return;
    // Área com regra par-ímpar: ilhas (contornos contidos em número ímpar de outros) são subtraídas.
    let area = 0;
    for (let i = 0; i < loops.length; i++) {
      const a = Math.abs(ringArea(loops[i]));
      let depth = 0;
      for (let j = 0; j < loops.length; j++) {
        if (i !== j && Math.abs(ringArea(loops[j])) > a && pointInRing(loops[i][0], loops[i][1], loops[j])) depth++;
      }
      area += depth % 2 ? -a : a;
    }
    const Mo = withOcs(ctx.M, e);
    const rings = loops.map((l) => tf(Mo, l));
    const perim = loops.reduce((s, l) => s + pathLength(l, true), 0);
    const solid = e.solidFill === 1;
    this.add(e, ctx, layer, color, [{ k: 'f', rings, solid, pattern: e.patternName || '' }],
      { area: Math.abs(area), length: perim, world: { pattern: e.patternName || (solid ? 'SOLID' : '') } },
      { M: Mo, closed: true });
  }

  text(e, t, ctx, layer, color) {
    const str = cleanText(t.text);
    if (!str.trim() || !fin(t.textHeight) || t.textHeight <= 0) return;
    const ha = t.halign | 0, va = t.valign | 0;
    const useEnd = (ha !== 0 || va !== 0) && t.endPoint && (t.endPoint.x || t.endPoint.y);
    const p = useEnd ? t.endPoint : t.startPoint || { x: 0, y: 0 };
    const Mo = withOcs(ctx.M, t);
    this.textPrim(e, ctx, layer, color, Mo, p.x, p.y, t.textHeight, t.rotation || 0, [str],
      HALIGN[ha] || 'left', ha === 4 ? 'middle' : VALIGN[va] || 'alphabetic', (t.xScale || 1));
  }

  mtext(e, ctx, layer, color) {
    const str = cleanMText(e.text);
    if (!str.trim() || !e.insertionPoint) return;
    const h = fin(e.textHeight) && e.textHeight > 0 ? e.textHeight : 1;
    let rot = e.rotation || 0;
    if (!rot && e.direction && (e.direction.x || e.direction.y)) rot = Math.atan2(e.direction.y, e.direction.x);
    const ap = Math.min(9, Math.max(1, e.attachmentPoint | 0 || 1));
    const ha = ['left', 'center', 'right'][(ap - 1) % 3];
    const va = ['top', 'middle', 'bottom'][Math.floor((ap - 1) / 3)];
    let lines = str.split('\n');
    // Quebra de linha aproximada pela largura do retângulo do MTEXT
    if (fin(e.rectWidth) && e.rectWidth > 0) {
      const maxChars = Math.max(4, Math.floor(e.rectWidth / (h * 0.55)));
      lines = lines.flatMap((l) => wrapLine(l, maxChars));
    }
    this.textPrim(e, ctx, layer, color, ctx.M, e.insertionPoint.x, e.insertionPoint.y, h, rot, lines, ha, va, 1, true);
  }

  textPrim(e, ctx, layer, color, M, x, y, h, rot, lines, ha, va, xs, multi = false) {
    const [wx, wy] = tfPt(M, x, y);
    const sc = Math.sqrt(Math.abs(det(M))) || 1;
    const wr = rot + Math.atan2(M[1], M[0]);
    const H = h * sc;
    const prim = { k: 't', x: wx, y: wy, h: H, r: wr, lines, ha, va, xs: xs || 1, multi };
    // Caixa aproximada do texto (para seleção e extensão)
    const maxLen = lines.reduce((m, l) => Math.max(m, l.length), 0);
    const W = maxLen * H * 0.6 * (xs || 1);
    const lh = multi ? H * 1.6 : H;
    const TH = lines.length * lh;
    let x0 = ha === 'center' ? -W / 2 : ha === 'right' ? -W : 0;
    let y0;
    if (multi) y0 = va === 'top' ? -TH : va === 'middle' ? -TH / 2 : 0;
    else y0 = va === 'top' ? -H : va === 'middle' ? -H / 2 : va === 'bottom' ? 0 : -0.2 * H;
    const c = Math.cos(wr), s = Math.sin(wr);
    const box = [];
    for (const [dx, dy] of [[x0, y0], [x0 + W, y0], [x0 + W, y0 + (multi ? TH : H * 1.2)], [x0, y0 + (multi ? TH : H * 1.2)]]) {
      box.push(wx + dx * c - dy * s, wy + dx * s + dy * c);
    }
    prim.box = Float64Array.from(box);
    if (!ctx.sink) {
      let label = lines.join(' ').replace(/\s+/g, ' ').trim();
      if (label.length > 60) label = label.slice(0, 57) + '…';
      this.texts.push({ x: (box[0] + box[4]) / 2, y: (box[1] + box[5]) / 2, s: label, h: H });
    }
    this.add(e, ctx, layer, color, [prim], null);
  }

  insert(e, ctx, layer, color) {
    const blk = this.blocks.get(String(e.name || '').toUpperCase());
    if (blk && ctx.depth < MAX_DEPTH && !ctx.stack.includes(blk)) {
      const base = blk.basePoint || { x: 0, y: 0 };
      const ip = e.insertionPoint || { x: 0, y: 0 };
      const sx = fin(e.xScale) && e.xScale !== 0 ? e.xScale : 1;
      const sy = fin(e.yScale) && e.yScale !== 0 ? e.yScale : 1;
      let cols = Math.max(1, e.columnCount | 0), rows = Math.max(1, e.rowCount | 0);
      if (cols * rows > MAX_INSERT_COPIES) { cols = Math.min(cols, MAX_INSERT_COPIES); rows = Math.max(1, Math.floor(MAX_INSERT_COPIES / cols)); }
      const Mo = withOcs(ctx.M, e);
      const R = rotate(e.rotation || 0);
      const SB = mul(scale(sx, sy), translate(-base.x, -base.y));
      const stack = ctx.stack.concat([blk]);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const L = mul(translate(ip.x, ip.y), mul(R, mul(translate(c * (e.columnSpacing || 0), r * (e.rowSpacing || 0)), SB)));
          const child = {
            M: mul(Mo, L), layer, byBlock: color, block: ctx.block || e.name,
            depth: ctx.depth + 1, stack, sink: ctx.sink,
          };
          for (const ce of blk.entities || []) {
            if (!ce || ce.type === 'ATTDEF') continue;
            this.safeEntity(ce, child);
            if (this.truncated) return;
          }
        }
      }
    }
    for (const a of e.attribs || []) this.safeEntity(a, ctx);
  }

  dimension(e, ctx, layer, color) {
    const blk = this.blocks.get(String(e.name || '').toUpperCase());
    if (!blk || ctx.stack.includes(blk) || ctx.depth >= MAX_DEPTH) { if (ctx.depth === 0) this.skip('DIMENSION'); return; }
    const sink = [];
    const child = { M: ctx.M, layer, byBlock: color, block: ctx.block, depth: ctx.depth + 1, stack: ctx.stack.concat([blk]), sink };
    for (const ce of blk.entities || []) {
      if (!ce || ce.type === 'ATTDEF') continue;
      this.safeEntity(ce, child);
    }
    const world = {};
    if (fin(e.measurement)) world.measurement = e.measurement;
    if (e.text) world.text = cleanMText(e.text);
    this.add(e, ctx, layer, color, sink, { world }, { type: 'DIMENSION' });
  }

  // Associa textos (nomes de ambientes) ao menor polígono fechado que os contém.
  labelPolygons(polys) {
    if (!polys.length || !this.texts.length) return;
    const sorted = polys.slice().sort((a, b) => a.area - b.area);
    for (const t of this.texts) {
      for (const p of sorted) {
        const b = p.bbox;
        if (t.x < b[0] || t.x > b[2] || t.y < b[1] || t.y > b[3]) continue;
        if (p.rings.some((r) => pointInRing(t.x, t.y, r))) {
          if (!p.labels) p.labels = [];
          if (p.labels.length < 4 && !p.labels.includes(t.s)) p.labels.push(t.s);
          break;
        }
      }
    }
  }

  finish(meta) {
    const recs = this.records;
    // Extensão do desenho
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const r of recs) {
      const b = r.bbox;
      if (b[0] < minX) minX = b[0];
      if (b[1] < minY) minY = b[1];
      if (b[2] > maxX) maxX = b[2];
      if (b[3] > maxY) maxY = b[3];
    }
    if (!recs.length) { minX = minY = 0; maxX = maxY = 1; }

    // Polígonos fechados (com área)
    const polys = [];
    for (const r of recs) {
      if (!r.closed || !(r.m.area > 0)) continue;
      const rings = [];
      for (const p of r.prims) {
        if (p.k === 'l' && p.c) rings.push(p.p);
        else if (p.k === 'f') rings.push(...p.rings);
      }
      if (rings.length) polys.push({ rec: r, area: r.m.area, bbox: r.bbox, rings });
    }
    this.labelPolygons(polys);

    // Desloca tudo para perto da origem (evita perda de precisão em float32 no canvas
    // quando o desenho usa coordenadas grandes, ex.: UTM).
    const ox = (minX + maxX) / 2, oy = (minY + maxY) / 2;
    const shift = (a) => { for (let i = 0; i < a.length; i += 2) { a[i] -= ox; a[i + 1] -= oy; } };
    for (const r of recs) {
      r.bbox = [r.bbox[0] - ox, r.bbox[1] - oy, r.bbox[2] - ox, r.bbox[3] - oy];
      for (const p of r.prims) {
        if (p.k === 'l') shift(p.p);
        else if (p.k === 'f') p.rings.forEach(shift);
        else if (p.k === 't') { p.x -= ox; p.y -= oy; shift(p.box); }
        else if (p.k === 'p') { p.x -= ox; p.y -= oy; }
      }
    }

    // Camadas
    const layerCount = new Map();
    for (const r of recs) layerCount.set(r.layer, (layerCount.get(r.layer) || 0) + 1);
    const layers = [];
    const seen = new Set();
    for (const [name, l] of this.layers) {
      seen.add(name);
      layers.push({ name, color: this.layerColor.get(name), off: this.isLayerOff(l), count: layerCount.get(name) || 0 });
    }
    for (const [name, count] of layerCount) {
      if (!seen.has(name)) layers.push({ name, color: '#ffffff', off: false, count });
    }
    layers.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { numeric: true }));

    const header = this.db.header || {};
    const sig = meta.signature || header.ACADVER || '';
    const userBlocks = [...this.blocks.values()].filter((b) => !b.name.startsWith('*')).length;

    return {
      info: {
        fileName: meta.fileName || '',
        fileSize: meta.fileSize || 0,
        format: meta.format || 'DWG',
        versionCode: sig,
        version: VERSIONS[sig] || sig || 'desconhecida',
        insunits: fin(header.INSUNITS) ? header.INSUNITS : 0,
        extents: { minX, minY, maxX, maxY },
        origin: { x: ox, y: oy },
        entityCount: this.topCount || 0,
        recordCount: recs.length,
        blockCount: userBlocks,
        typeCounts: this.typeCounts,
        skipped: this.skipped,
        errors: this.errors,
        truncated: this.truncated,
      },
      layers,
      records: recs,
      polygons: polys.map((p) => ({
        id: p.rec.id,
        type: p.rec.type,
        layer: p.rec.layer,
        block: p.rec.block,
        area: p.area,
        perimeter: p.rec.m.length ?? null,
        label: p.labels ? p.labels.join(' · ') : '',
      })),
    };
  }
}

function primsBBox(prims) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const ext = (a) => {
    for (let i = 0; i < a.length; i += 2) {
      const x = a[i], y = a[i + 1];
      if (!(Number.isFinite(x) && Number.isFinite(y))) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  };
  for (const p of prims) {
    if (p.k === 'l') ext(p.p);
    else if (p.k === 'f') p.rings.forEach(ext);
    else if (p.k === 't') ext(p.box);
    else if (p.k === 'p') ext([p.x, p.y]);
  }
  return minX <= maxX ? [minX, minY, maxX, maxY] : null;
}

export function buildScene(db, meta = {}) {
  const b = new SceneBuilder(db);
  b.run();
  return b.finish(meta);
}
