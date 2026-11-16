import { Viewer } from './viewer.js';
import { UNITS } from './scene.js';

const $ = (id) => document.getElementById(id);
const els = {
  stage: $('stage'), canvas: $('canvas'), empty: $('empty'), dropCard: $('dropCard'), fileInput: $('fileInput'),
  fileName: $('fileName'), toolbar: $('toolbar'), statusbar: $('statusbar'), cursorPos: $('cursorPos'),
  hoverInfo: $('hoverInfo'), loading: $('loading'), loadingMsg: $('loadingMsg'), toast: $('toast'),
  panelEmpty: $('panelEmpty'), panelContent: $('panelContent'), fileInfo: $('fileInfo'),
  unitSelect: $('unitSelect'), unitWarn: $('unitWarn'), selection: $('selection'), areaStats: $('areaStats'),
  layerFilter: $('layerFilter'), polySearch: $('polySearch'), typeFilter: $('typeFilter'),
  polyTable: $('polyTable'), polyMore: $('polyMore'), layerAreaTable: $('layerAreaTable'), exportCsv: $('exportCsv'),
  layerList: $('layerList'), layerCount: $('layerCount'), entityTable: $('entityTable'), skippedNote: $('skippedNote'),
  dropOverlay: $('dropOverlay'),
};

const TYPE_NAMES = {
  LINE: 'Linha', LWPOLYLINE: 'Polilinha', POLYLINE2D: 'Polilinha 2D', POLYLINE3D: 'Polilinha 3D',
  CIRCLE: 'Círculo', ARC: 'Arco', ELLIPSE: 'Elipse', SPLINE: 'Spline', HATCH: 'Hachura', SOLID: 'Sólido 2D',
  TRACE: 'Traço', TEXT: 'Texto', MTEXT: 'Texto múltiplo', ATTRIB: 'Atributo', INSERT: 'Bloco (inserção)',
  DIMENSION: 'Cota', LEADER: 'Linha de chamada', MLINE: 'Multilinha', POINT: 'Ponto', '3DFACE': 'Face 3D',
  MULTILEADER: 'Chamada múltipla', ACAD_TABLE: 'Tabela', VIEWPORT: 'Viewport', IMAGE: 'Imagem',
  WIPEOUT: 'Máscara', XLINE: 'Linha infinita', RAY: 'Semirreta', '3DSOLID': 'Sólido 3D', OLE2FRAME: 'Objeto OLE',
  ACAD_PROXY_ENTITY: 'Entidade proxy', TOLERANCE: 'Tolerância', SHAPE: 'Forma', SECTION: 'Seção',
};
const typeName = (t) => TYPE_NAMES[t] || t;

const TYPE_GROUPS = [
  { key: 'poly', label: 'Polilinhas', types: ['LWPOLYLINE', 'POLYLINE2D', 'POLYLINE3D'] },
  { key: 'hatch', label: 'Hachuras', types: ['HATCH'] },
  { key: 'circ', label: 'Círculos e elipses', types: ['CIRCLE', 'ELLIPSE'] },
  { key: 'spline', label: 'Splines', types: ['SPLINE'] },
  { key: 'solid', label: 'Sólidos 2D', types: ['SOLID', 'TRACE'] },
];
const groupOf = (type) => TYPE_GROUPS.find((g) => g.types.includes(type))?.key || 'poly';

const nf = (d) => new Intl.NumberFormat('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
const NF2 = nf(2), NF0 = nf(0);
const fmtNum = (v, d = 2) => (Number.isFinite(v) ? (d === 2 ? NF2 : nf(d)).format(v) : '—');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  scene: null,
  unit: 0,
  sort: { key: 'area', dir: -1 },
  filter: { layer: '', search: '', groups: new Set(TYPE_GROUPS.map((g) => g.key)) },
  polyById: new Map(),
};

/* ---------------- unidades ---------------- */
function unitInfo() {
  return UNITS[state.unit] || UNITS[0];
}
function fmtArea(a) {
  const u = unitInfo();
  if (!Number.isFinite(a)) return '—';
  if (u.m) {
    const m2 = a * u.m * u.m;
    return fmtNum(m2, m2 < 0.01 && m2 > 0 ? 4 : 2) + ' m²';
  }
  return fmtNum(a) + ' u²';
}
function fmtLen(l) {
  const u = unitInfo();
  if (!Number.isFinite(l)) return '—';
  if (u.m) return fmtNum(l * u.m, l * u.m < 0.1 ? 4 : 2) + ' m';
  return fmtNum(l) + ' u';
}
function areaValue(a) {
  const u = unitInfo();
  return u.m ? a * u.m * u.m : a;
}
function lenValue(l) {
  const u = unitInfo();
  return u.m ? l * u.m : l;
}

// Estima a unidade a partir do tamanho do desenho (útil quando INSUNITS está vazio ou errado).
function estimateUnit(info) {
  const e = info.extents;
  const D = Math.max(e.maxX - e.minX, e.maxY - e.minY);
  if (D <= 600) return 6; // metros
  if (D <= 60000) return 5; // centímetros
  return 4; // milímetros
}

function setupUnits(info) {
  els.unitSelect.innerHTML = Object.entries(UNITS)
    .map(([k, u]) => `<option value="${k}">${esc(u.name)}${u.m ? ` (${u.abbr})` : ''}</option>`).join('');
  const declared = UNITS[info.insunits] ? info.insunits : 0;
  const est = estimateUnit(info);
  // Se a unidade declarada resulta num tamanho implausível para uma edificação, usa a estimada.
  state.unit = declared && !implausible(info, declared) ? declared : est;
  els.unitSelect.value = String(state.unit);
  updateUnitWarning(info, declared, est);
}

function drawingSize(info) {
  const e = info.extents;
  return Math.max(e.maxX - e.minX, e.maxY - e.minY);
}

function implausible(info, unit) {
  const m = UNITS[unit]?.m;
  if (!m) return false;
  const D = drawingSize(info) * m;
  return D < 1.5 || D > 50000;
}

function updateUnitWarning(info, declared, est) {
  const D = drawingSize(info);
  const dn = declared ? esc(UNITS[declared].name.toLowerCase()) : '';
  let msg = '';
  if (!declared && state.unit === est) {
    msg = `O arquivo não declara unidade. Pelo tamanho do desenho, estimamos <b>${esc(UNITS[est].name.toLowerCase())}</b>. Confira antes de usar as áreas.`;
  } else if (declared && state.unit !== declared && implausible(info, declared)) {
    msg = `O arquivo declara <b>${dn}</b>, mas nessa unidade o desenho teria ${fmtNum(D * UNITS[declared].m)} m. Por isso usamos <b>${esc(unitInfo().name.toLowerCase())}</b>. <button class="link" data-unit="${declared}" type="button">Usar ${dn}</button>`;
  } else if (declared && state.unit === declared && implausible(info, declared)) {
    msg = `Nesta unidade o desenho teria ${fmtNum(D * UNITS[declared].m)} m. Talvez esteja em ${esc(UNITS[est].name.toLowerCase())}. <button class="link" data-unit="${est}" type="button">Usar ${esc(UNITS[est].abbr)}</button>`;
  }
  els.unitWarn.innerHTML = msg;
  els.unitWarn.hidden = !msg;
}

/* ---------------- worker ---------------- */
let worker = null;
function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onerror = (e) => {
      hideLoading();
      showToast('Falha ao iniciar o leitor DWG: ' + (e.message || 'erro desconhecido'));
      worker.terminate();
      worker = null;
    };
  }
  return worker;
}

function parseFile(file) {
  return new Promise((resolve, reject) => {
    file.arrayBuffer().then((buffer) => {
      const w = getWorker();
      w.onmessage = (ev) => {
        const m = ev.data;
        if (m.type === 'progress') showLoading(m.msg);
        else if (m.type === 'result') resolve(m.scene);
        else if (m.type === 'error') {
          // recria o worker para limpar a memória do WASM
          w.terminate();
          worker = null;
          reject(new Error(m.message));
        }
      };
      w.postMessage({ name: file.name, buffer }, [buffer]);
    }, reject);
  });
}

async function openFile(file) {
  if (!file) return;
  if (!/\.(dwg|dxf)$/i.test(file.name)) {
    showToast('Formato não suportado. Escolha um arquivo .dwg ou .dxf.');
    return;
  }
  hideToast();
  showLoading('Lendo arquivo…');
  const t0 = performance.now();
  try {
    const scene = await parseFile(file);
    scene.info.ms = performance.now() - t0;
    loadScene(scene, file);
  } catch (err) {
    console.error(err);
    showToast('Não foi possível abrir “' + file.name + '”: ' + err.message);
  } finally {
    hideLoading();
  }
}

/* ---------------- cena ---------------- */
let viewer;

function loadScene(scene, file) {
  state.scene = scene;
  state.polyById = new Map(scene.polygons.map((p) => [p.id, p]));
  state.filter.layer = '';
  state.filter.search = '';
  els.polySearch.value = '';
  els.fileName.textContent = file.name;
  els.fileName.title = file.name;
  document.title = file.name + ' · Visualizador DWG';
  els.empty.hidden = true;
  els.toolbar.hidden = false;
  els.statusbar.hidden = false;
  els.panelEmpty.hidden = true;
  els.panelContent.hidden = false;

  setupUnits(scene.info);
  viewer.setScene(scene);
  renderAll();
  if (!scene.records.length) showToast('O arquivo foi lido, mas não há entidades desenháveis no espaço do modelo.');
}

function renderAll() {
  renderFileInfo();
  renderSelection(viewer.selectedId >= 0 ? state.scene.records[viewer.selectedId] : null);
  renderLayerFilter();
  renderTypeFilter();
  renderPolygons();
  renderLayers();
  renderEntities();
}

function renderFileInfo() {
  const { info } = state.scene;
  const e = info.extents;
  const w = e.maxX - e.minX, h = e.maxY - e.minY;
  const rows = [
    ['Nome', esc(info.fileName)],
    ['Tamanho', fmtSize(info.fileSize)],
    ['Formato', esc(info.format + (info.format === 'DWG' ? ' · ' + info.version : ''))],
    ['Unidade declarada', esc(UNITS[info.insunits]?.name || 'Sem unidade')],
    ['Dimensões', `${fmtLen(w)} × ${fmtLen(h)}`],
    ['Entidades (modelo)', NF0.format(info.entityCount)],
    ['Objetos desenhados', NF0.format(info.recordCount)],
    ['Camadas', NF0.format(state.scene.layers.length)],
    ['Blocos', NF0.format(info.blockCount)],
    ['Polígonos fechados', NF0.format(state.scene.polygons.length)],
    ['Tempo de leitura', fmtNum(info.ms / 1000, 1) + ' s'],
  ];
  els.fileInfo.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}

function fmtSize(b) {
  if (b > 1048576) return fmtNum(b / 1048576, 1) + ' MB';
  return fmtNum(b / 1024, 0) + ' KB';
}

/* ---------------- seleção ---------------- */
function renderSelection(rec) {
  if (!rec) {
    els.selection.innerHTML = '<p class="muted">Clique em um objeto do desenho ou em uma linha da tabela de áreas.</p>';
    markSelectedRow(-1);
    return;
  }
  const m = rec.m || {};
  const b = rec.bbox;
  const poly = state.polyById.get(rec.id);
  const rows = [];
  if (poly && poly.label) rows.push(['Ambiente', esc(poly.label)]);
  if (m.area != null) rows.push(['Área', `<span class="big">${fmtArea(m.area)}</span>`, 'big']);
  rows.push(['Tipo', esc(typeName(rec.type))]);
  rows.push(['Camada', esc(rec.layer)]);
  if (rec.block) rows.push(['Bloco', esc(rec.block)]);
  if (m.length != null) rows.push([rec.closed ? 'Perímetro' : 'Comprimento', fmtLen(m.length)]);
  if (m.radius != null) rows.push(['Raio', fmtLen(m.radius)]);
  if (m.angle != null) rows.push(['Ângulo', fmtNum(m.angle) + '°']);
  if (m.measurement != null) rows.push(['Medida da cota', fmtLen(m.measurement)]);
  if (m.pattern) rows.push(['Padrão', esc(m.pattern)]);
  const txt = rec.prims.find((p) => p.k === 't');
  if (txt && rec.type !== 'DIMENSION') rows.push(['Texto', esc(txt.lines.join(' ').slice(0, 200))]);
  rows.push(['Largura × altura', `${fmtLen(b[2] - b[0])} × ${fmtLen(b[3] - b[1])}`]);
  if (rec.handle) rows.push(['Handle', esc(rec.handle)]);
  rows.push(['Cor', `<span class="sw-inline" style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${esc(rec.color)};vertical-align:middle;margin-right:6px"></span>${esc(rec.color)}`]);
  els.selection.innerHTML = `<dl class="kv">${rows.map(([k, v, c]) => `<dt>${k}</dt><dd${c ? ` class="${c}"` : ''}>${v}</dd>`).join('')}</dl>`;
  markSelectedRow(rec.id);
}

function markSelectedRow(id) {
  for (const tr of els.polyTable.tBodies[0].rows) tr.classList.toggle('sel', Number(tr.dataset.id) === id);
  const tr = els.polyTable.tBodies[0].querySelector(`tr[data-id="${id}"]`);
  if (tr) tr.scrollIntoView({ block: 'nearest' });
}

/* ---------------- áreas ---------------- */
function renderLayerFilter() {
  const counts = new Map();
  for (const p of state.scene.polygons) counts.set(p.layer, (counts.get(p.layer) || 0) + 1);
  const names = [...counts.keys()].sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true }));
  els.layerFilter.innerHTML = `<option value="">Todas as camadas</option>` +
    names.map((n) => `<option value="${esc(n)}">${esc(n)} (${counts.get(n)})</option>`).join('');
  els.layerFilter.value = state.filter.layer;
}

function renderTypeFilter() {
  const present = new Set(state.scene.polygons.map((p) => groupOf(p.type)));
  els.typeFilter.innerHTML = TYPE_GROUPS.filter((g) => present.has(g.key))
    .map((g) => `<label class="chip"><input type="checkbox" value="${g.key}" ${state.filter.groups.has(g.key) ? 'checked' : ''}/> ${g.label}</label>`)
    .join('');
}

function filteredPolygons() {
  const { layer, search, groups } = state.filter;
  const q = search.trim().toLocaleLowerCase('pt-BR');
  return state.scene.polygons.filter((p) => {
    if (layer && p.layer !== layer) return false;
    if (!groups.has(groupOf(p.type))) return false;
    if (q && !(`${p.label} ${p.layer} ${p.block || ''}`.toLocaleLowerCase('pt-BR').includes(q))) return false;
    return viewer.isVisible(p);
  });
}

const MAX_ROWS = 500;

function renderPolygons() {
  const list = filteredPolygons();
  const { key, dir } = state.sort;
  list.sort((a, b) => {
    const va = a[key], vb = b[key];
    if (typeof va === 'string' || typeof vb === 'string') return dir * String(va || '').localeCompare(String(vb || ''), 'pt-BR', { numeric: true });
    return dir * ((va ?? -Infinity) - (vb ?? -Infinity));
  });
  state.visiblePolys = list;

  const total = list.reduce((s, p) => s + p.area, 0);
  const labeled = list.filter((p) => p.label).length;
  els.areaStats.innerHTML = `
    <div class="stat accent"><div class="v">${fmtArea(total)}</div><div class="l">Soma das áreas (${NF0.format(list.length)} polígonos)</div></div>
    <div class="stat"><div class="v">${list.length ? fmtArea(list.reduce((m, p) => Math.max(m, p.area), 0)) : '—'}</div><div class="l">Maior polígono</div></div>
    <div class="stat"><div class="v">${NF0.format(labeled)}</div><div class="l">Com nome de ambiente</div></div>
    <div class="stat"><div class="v">${list.length ? fmtArea(total / list.length) : '—'}</div><div class="l">Área média</div></div>`;

  for (const th of els.polyTable.tHead.rows[0].cells) {
    th.classList.toggle('sorted', th.dataset.sort === key);
    th.classList.toggle('asc', th.dataset.sort === key && dir > 0);
  }
  const rows = list.slice(0, MAX_ROWS).map((p) => `
    <tr data-id="${p.id}" class="${p.id === viewer.selectedId ? 'sel' : ''}">
      <td class="lbl" title="${esc(p.label || typeName(p.type))}">${p.label ? esc(p.label) : `<span class="muted">${esc(typeName(p.type))}</span>`}</td>
      <td class="lay" title="${esc(p.layer)}">${esc(p.layer)}</td>
      <td class="num">${fmtArea(p.area)}</td>
      <td class="num">${fmtLen(p.perimeter)}</td>
    </tr>`);
  els.polyTable.tBodies[0].innerHTML = rows.join('') ||
    '<tr><td colspan="4" class="muted">Nenhum polígono fechado com os filtros atuais.</td></tr>';
  els.polyMore.textContent = list.length > MAX_ROWS ? `Mostrando ${MAX_ROWS} de ${NF0.format(list.length)}. Use os filtros para refinar (a soma considera todos).` : '';

  // Área por camada
  const byLayer = new Map();
  for (const p of list) {
    const o = byLayer.get(p.layer) || { n: 0, a: 0 };
    o.n++; o.a += p.area;
    byLayer.set(p.layer, o);
  }
  els.layerAreaTable.tBodies[0].innerHTML = [...byLayer.entries()].sort((a, b) => b[1].a - a[1].a)
    .map(([n, o]) => `<tr><td class="lay" title="${esc(n)}">${esc(n)}</td><td class="num">${NF0.format(o.n)}</td><td class="num">${fmtArea(o.a)}</td></tr>`)
    .join('') || '<tr><td colspan="3" class="muted">—</td></tr>';
}

function exportCsv() {
  const list = state.visiblePolys || [];
  const u = unitInfo();
  const au = u.m ? 'm²' : 'u²', lu = u.m ? 'm' : 'u';
  const num = (v, d = 4) => (Number.isFinite(v) ? v.toFixed(d).replace('.', ',') : '');
  const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const lines = [[`Ambiente`, `Camada`, `Tipo`, `Bloco`, `Área (${au})`, `Perímetro (${lu})`].map(q).join(';')];
  for (const p of list) {
    lines.push([q(p.label), q(p.layer), q(typeName(p.type)), q(p.block || ''), num(areaValue(p.area)), num(p.perimeter != null ? lenValue(p.perimeter) : NaN)].join(';'));
  }
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (state.scene.info.fileName || 'desenho').replace(/\.(dwg|dxf)$/i, '') + '-areas.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------------- camadas e entidades ---------------- */
function renderLayers() {
  const layers = state.scene.layers;
  els.layerCount.textContent = `(${layers.length})`;
  els.layerList.innerHTML = layers.map((l) => `
    <li><label>
      <input type="checkbox" data-layer="${esc(l.name)}" ${viewer.hidden.has(l.name) ? '' : 'checked'} />
      <span class="sw" style="background:${esc(l.color)}"></span>
      <span class="nm" title="${esc(l.name)}">${esc(l.name)}</span>
      <span class="ct">${NF0.format(l.count)}</span>
    </label></li>`).join('');
}

function renderEntities() {
  const { typeCounts, skipped, errors, truncated } = state.scene.info;
  const rows = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `<tr><td>${esc(typeName(t))} <span class="muted">${esc(t)}</span></td><td class="num">${NF0.format(n)}</td></tr>`);
  els.entityTable.tBodies[0].innerHTML = rows.join('');
  const sk = Object.entries(skipped);
  const parts = [];
  if (sk.length) parts.push('Não desenhadas: ' + sk.map(([t, n]) => `${typeName(t)} (${n})`).join(', ') + '.');
  if (errors) parts.push(`${errors} entidade(s) com erro de leitura foram ignoradas.`);
  if (truncated) parts.push('O desenho é muito grande; parte das entidades não foi carregada.');
  els.skippedNote.textContent = parts.join(' ');
  els.skippedNote.hidden = !parts.length;
}

/* ---------------- UI ---------------- */
function showLoading(msg) {
  els.loadingMsg.textContent = msg;
  els.loading.hidden = false;
}
function hideLoading() {
  els.loading.hidden = true;
}
let toastTimer;
function showToast(msg) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 9000);
}
function hideToast() {
  els.toast.hidden = true;
}

function hoverText(rec) {
  if (!rec) return '';
  const parts = [typeName(rec.type), rec.layer];
  const poly = state.polyById.get(rec.id);
  if (poly && poly.label) parts.unshift(poly.label);
  if (rec.m.area != null) parts.push(fmtArea(rec.m.area));
  else if (rec.m.length != null) parts.push(fmtLen(rec.m.length));
  return parts.join(' · ');
}

function init() {
  viewer = new Viewer(els.canvas, {
    onSelect: (rec) => renderSelection(rec),
    onHover: (rec) => { els.hoverInfo.textContent = hoverText(rec); },
    onCursor: (x, y) => { els.cursorPos.textContent = `X ${fmtNum(x, 3)}   Y ${fmtNum(y, 3)}`; },
  });

  els.fileInput.addEventListener('change', () => {
    openFile(els.fileInput.files[0]);
    els.fileInput.value = '';
  });
  els.dropCard.addEventListener('click', () => els.fileInput.click());

  // Arrastar e soltar em qualquer lugar da janela
  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (++dragDepth === 1) { els.dropOverlay.hidden = false; els.stage.classList.add('dragging'); }
  });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    if (--dragDepth <= 0) { dragDepth = 0; els.dropOverlay.hidden = true; els.stage.classList.remove('dragging'); }
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    els.dropOverlay.hidden = true;
    els.stage.classList.remove('dragging');
    openFile(e.dataTransfer.files[0]);
  });

  $('zoomIn').addEventListener('click', () => viewer.zoomBy(1.5));
  $('zoomOut').addEventListener('click', () => viewer.zoomBy(1 / 1.5));
  $('zoomFit').addEventListener('click', () => viewer.fit());
  $('bgToggle').addEventListener('click', () => {
    const light = !viewer.light;
    viewer.setLight(light);
    els.stage.classList.toggle('light', light);
  });

  window.addEventListener('keydown', (e) => {
    if (!state.scene || e.target.closest('input, select, textarea')) return;
    if (e.key === '+' || e.key === '=') viewer.zoomBy(1.5);
    else if (e.key === '-') viewer.zoomBy(1 / 1.5);
    else if (e.key === 'f' || e.key === 'F') viewer.fit();
    else if (e.key === 'Escape') viewer.select(-1);
  });

  els.unitSelect.addEventListener('change', () => {
    state.unit = Number(els.unitSelect.value);
    const info = state.scene.info;
    updateUnitWarning(info, UNITS[info.insunits] ? info.insunits : 0, estimateUnit(info));
    renderAll();
  });
  els.unitWarn.addEventListener('click', (e) => {
    const b = e.target.closest('[data-unit]');
    if (!b) return;
    els.unitSelect.value = b.dataset.unit;
    els.unitSelect.dispatchEvent(new Event('change'));
  });

  els.layerFilter.addEventListener('change', () => { state.filter.layer = els.layerFilter.value; renderPolygons(); });
  els.polySearch.addEventListener('input', () => { state.filter.search = els.polySearch.value; renderPolygons(); });
  els.typeFilter.addEventListener('change', (e) => {
    const cb = e.target.closest('input[type=checkbox]');
    if (!cb) return;
    if (cb.checked) state.filter.groups.add(cb.value); else state.filter.groups.delete(cb.value);
    renderPolygons();
  });
  els.polyTable.tHead.addEventListener('click', (e) => {
    const th = e.target.closest('th[data-sort]');
    if (!th) return;
    const key = th.dataset.sort;
    state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : key === 'area' || key === 'perimeter' ? -1 : 1 };
    renderPolygons();
  });
  els.polyTable.tBodies[0].addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (tr) viewer.select(Number(tr.dataset.id), { zoom: true });
  });
  els.exportCsv.addEventListener('click', exportCsv);

  els.layerList.addEventListener('change', (e) => {
    const cb = e.target.closest('input[data-layer]');
    if (!cb) return;
    viewer.setLayerVisible(cb.dataset.layer, cb.checked);
    renderPolygons();
  });
  const allLayers = (visible) => {
    viewer.setLayersVisible(state.scene.layers.map((l) => l.name), visible);
    renderLayers();
    renderPolygons();
  };
  $('layersAll').addEventListener('click', () => allLayers(true));
  $('layersNone').addEventListener('click', () => allLayers(false));
}

init();
