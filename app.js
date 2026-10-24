'use strict';

const { SUPABASE_URL, SUPABASE_KEY } = window.APP_CONFIG;
const $ = (s) => document.querySelector(s);
const LOTE = 500;

// ---------- API ----------
async function api(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: SUPABASE_KEY, ...(opts.headers || {}) },
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).message || msg; } catch (_) { /* sin cuerpo */ }
    throw new Error(msg || `Error ${res.status}`);
  }
  return res;
}

async function fetchAll(table, select, order) {
  const PAGE = 1000;
  const q = `${table}?select=${encodeURIComponent(select)}&order=${order}`;
  const first = await api(q, { headers: { Range: `0-${PAGE - 1}`, Prefer: 'count=exact' } });
  const rows = await first.json();
  const total = Number((first.headers.get('content-range') || '').split('/')[1]) || rows.length;
  const pages = [];
  for (let from = PAGE; from < total; from += PAGE) {
    pages.push(api(q, { headers: { Range: `${from}-${from + PAGE - 1}` } }).then((r) => r.json()));
  }
  (await Promise.all(pages)).forEach((p) => rows.push(...p));
  return rows;
}

async function rpc(fn, body) {
  const res = await api(`rpc/${fn}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ---------- Formato ----------
const nf0 = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 0 });
const nf3 = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 3 });
const mf = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2 });
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fDate = (d) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : '');
const fDateTime = (t) => (t ? new Date(t).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' }) : '');

function fmt(col, v) {
  if (v === null || v === undefined || v === '') return '';
  switch (col.type) {
    case 'date': return fDate(v);
    case 'datetime': return fDateTime(v);
    case 'money': return mf.format(v);
    case 'int': return nf0.format(v);
    case 'num': return nf3.format(v);
    default: return String(v);
  }
}
const NUMERIC = new Set(['money', 'int', 'num']);

// ---------- Destino ("¿para quién?") ----------
// Se deduce del Texto de Cabecera de la OC. Textos como "POS.1 A 3 VENTA ANGEL TICKET 501… RESTO STOCK"
// indican que solo esas posiciones (renglones) son para la venta y el resto es para stock.
const RE_VENTA = /\b(venta|vta|ventas|cliente|obra|promesa|vendedor|ticket|fact|factura)\b|\bpedido\s*\d/;
const RE_STOCK = /(stock|reorden|resurt|menudeo|proteccion)/;

function posicionesMencionadas(t) {
  const set = new Set();
  const re = /\bpos(?:icion(?:es)?)?\.?\s*(\d{1,3})((?:\s*(?:a|al|-|y|,)\s*\d{1,3}\b)*)/g;
  let m;
  while ((m = re.exec(t))) {
    let prev = Number(m[1]);
    set.add(prev);
    const tokRe = /\s*(a|al|-|y|,)\s*(\d{1,3})/g;
    let tk;
    while ((tk = tokRe.exec(m[2]))) {
      const n = Number(tk[2]);
      if (tk[1] === 'a' || tk[1] === 'al' || tk[1] === '-') { for (let i = prev; i <= n && i - prev < 500; i++) set.add(i); } else set.add(n);
      prev = n;
    }
  }
  return set;
}

function clasificarDestino(r) {
  const t = norm(r.texto_cabecera || '');
  const ref = norm(r.nuestra_referencia || '');
  const venta = RE_VENTA.test(t) || /\b5\d{8,9}\b/.test(`${t} ${ref}`)
    || r.motivo_pedido === 'C11' || r.motivo_pedido === 'C12';
  if (venta) {
    const pos = posicionesMencionadas(t);
    if (pos.size && !pos.has(Number(r.numero_renglon))) return RE_STOCK.test(t) ? 'Stock' : 'Otro';
    return 'Venta / Cliente';
  }
  if ((!t.trim() && (!ref || RE_STOCK.test(ref))) || RE_STOCK.test(t)) return 'Stock';
  return 'Otro';
}
// Números de ticket / pedido de venta citados en el texto (p. ej. 501117036, 5000985311)
const documentosVenta = (r) => [...new Set((r.texto_cabecera || '').match(/\b5\d{8,9}\b/g) || [])].join(', ');
function badgeDestino(d) {
  const cls = d === 'Venta / Cliente' ? 'b-venta' : d === 'Stock' ? 'b-stock' : 'b-otro';
  return `<span class="badge ${cls}">${esc(d)}</span>`;
}

// ---------- Tabla genérica con orden, filtros por columna y paginación ----------
class Tabla {
  constructor({ el, pager, info, cols, onRow, onFiltered, pageSize = 100, nombre }) {
    Object.assign(this, { el: $(el), pager: pager && $(pager), info: info && $(info), cols, onRow, onFiltered, pageSize, nombre });
    this.base = []; this.rows = []; this.colF = {}; this.sort = null; this.page = 0;
    this.buildHead();
  }

  buildHead() {
    const thead = document.createElement('thead');
    const r1 = document.createElement('tr');
    const r2 = document.createElement('tr'); r2.className = 'col-filtros';
    this.cols.forEach((c) => {
      const th = document.createElement('th');
      th.innerHTML = `${esc(c.t)}<span class="sort"></span>`;
      if (NUMERIC.has(c.type)) th.className = 'n';
      th.addEventListener('click', () => {
        this.sort = this.sort && this.sort.k === c.k ? { k: c.k, dir: -this.sort.dir } : { k: c.k, dir: 1 };
        this.apply();
      });
      r1.appendChild(th);
      const tf = document.createElement('th');
      const inp = document.createElement('input');
      inp.type = 'search';
      inp.placeholder = NUMERIC.has(c.type) ? '>0, <10…' : 'Filtrar';
      let t;
      inp.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(() => { this.colF[c.k] = inp.value.trim(); this.page = 0; this.apply(); }, 200);
      });
      tf.appendChild(inp);
      r2.appendChild(tf);
    });
    thead.append(r1, r2);
    this.tbody = document.createElement('tbody');
    this.el.replaceChildren(thead, this.tbody);
    this.headCells = [...r1.children];
    this.filterInputs = [...r2.querySelectorAll('input')];
    this.tbody.addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-i]');
      if (tr && this.onRow) this.onRow(this.rows[Number(tr.dataset.i)]);
    });
  }

  limpiarFiltrosColumna() {
    this.colF = {};
    this.filterInputs.forEach((i) => { i.value = ''; });
  }

  setRows(rows) { this.base = rows; this.page = 0; this.apply(); }

  match(c, v, f) {
    if (NUMERIC.has(c.type)) {
      const m = f.match(/^(>=|<=|>|<|=)\s*(-?[\d.,]+)$/);
      if (m) {
        if (v === null || v === undefined) return false;
        const x = parseFloat(m[2].replace(/,/g, '')); const n = Number(v);
        return { '>': n > x, '<': n < x, '>=': n >= x, '<=': n <= x, '=': n === x }[m[1]];
      }
    }
    const shown = c.text ? c.text(v) : fmt(c, v);
    return norm(shown).includes(norm(f)) || norm(v).includes(norm(f));
  }

  apply() {
    const act = this.cols.filter((c) => this.colF[c.k]);
    let rows = act.length
      ? this.base.filter((r) => act.every((c) => this.match(c, r[c.k], this.colF[c.k])))
      : this.base.slice();
    if (this.sort) {
      const { k, dir } = this.sort;
      const col = this.cols.find((c) => c.k === k);
      const num = NUMERIC.has(col.type);
      rows.sort((a, b) => {
        const x = a[k]; const y = b[k];
        if (x == null || x === '') return 1;
        if (y == null || y === '') return -1;
        return (num ? x - y : String(x).localeCompare(String(y), 'es', { numeric: true })) * dir;
      });
    }
    this.rows = rows;
    this.headCells.forEach((th, i) => {
      th.querySelector('.sort').textContent = this.sort && this.sort.k === this.cols[i].k ? (this.sort.dir > 0 ? '▲' : '▼') : '';
    });
    if (this.onFiltered) this.onFiltered(rows);
    this.render();
  }

  render() {
    const pages = Math.max(1, Math.ceil(this.rows.length / this.pageSize));
    if (this.page >= pages) this.page = pages - 1;
    const start = this.page * this.pageSize;
    const slice = this.rows.slice(start, start + this.pageSize);
    this.tbody.innerHTML = slice.length
      ? slice.map((r, i) => `<tr data-i="${start + i}">${this.cols.map((c) => {
        const html = c.render ? c.render(r) : esc(fmt(c, r[c.k]));
        const title = c.render ? '' : ` title="${esc(fmt(c, r[c.k]))}"`;
        return `<td${NUMERIC.has(c.type) ? ' class="n"' : ''}${title}>${html}</td>`;
      }).join('')}</tr>`).join('')
      : `<tr><td class="vacio" colspan="${this.cols.length}">Sin resultados con los filtros actuales</td></tr>`;

    if (this.info) this.info.textContent = `${nf0.format(this.rows.length)} de ${nf0.format(this.base.length)} registros`;
    if (!this.pager) return;
    this.pager.innerHTML = `
      <span>Filas por página</span>
      <select>${[50, 100, 250, 500].map((n) => `<option ${n === this.pageSize ? 'selected' : ''}>${n}</option>`).join('')}</select>
      <span>${this.rows.length ? nf0.format(start + 1) : 0}–${nf0.format(Math.min(start + this.pageSize, this.rows.length))} de ${nf0.format(this.rows.length)}</span>
      <button data-p="0" ${this.page === 0 ? 'disabled' : ''}>«</button>
      <button data-p="${this.page - 1}" ${this.page === 0 ? 'disabled' : ''}>‹</button>
      <span>Página ${this.page + 1} de ${pages}</span>
      <button data-p="${this.page + 1}" ${this.page >= pages - 1 ? 'disabled' : ''}>›</button>
      <button data-p="${pages - 1}" ${this.page >= pages - 1 ? 'disabled' : ''}>»</button>`;
    this.pager.querySelector('select').onchange = (e) => { this.pageSize = Number(e.target.value); this.page = 0; this.render(); };
    this.pager.querySelectorAll('button').forEach((b) => { b.onclick = () => { this.page = Number(b.dataset.p); this.render(); }; });
  }

  exportarCSV() {
    const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    const lines = [this.cols.map((c) => q(c.t)).join(',')];
    this.rows.forEach((r) => lines.push(this.cols.map((c) => {
      const v = r[c.k];
      return NUMERIC.has(c.type) ? (v ?? '') : q(c.text ? c.text(v) : fmt(c, v));
    }).join(',')));
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${this.nombre}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
}

// ---------- Definición de columnas ----------
const LABELS_COMPRA = {
  orden_compra: 'Orden de Compra', numero_renglon: 'Número de Renglón', fecha_orden: 'Fecha de la Orden', periodo: 'Periodo',
  dias_antiguedad: 'Días Antigüedad', fecha_estimada_llegada: 'Fecha Estimada de Llegada', nombre_usuario: 'Comprador (Usuario)',
  numero_proveedor: 'Número de Proveedor', nombre_proveedor: 'Nombre del Proveedor', estatus_posicion: 'Estatus de la Posición',
  motivo_pedido: 'Motivo de Pedido', descripcion_motivo_pedido: 'Descripción Motivo', centro_solicitante: 'Centro Solicitante',
  nombre_centro_solicitante: 'Nombre del Centro', almacen: 'Almacén', solicitante_oc: 'Solicitante de la OC',
  indicador_abc_destino: 'Indicador ABC Destino', indicador_abc_frecuencia: 'ABC + Frecuencia de Venta',
  codigo_material: 'Código de Material', numero_material_proveedor: 'Material del Proveedor', descripcion_material: 'Descripción del Material',
  cantidad_pedida: 'Cantidad Pedida', unidad_medida_pedido: 'UM Pedido', cantidad_entrada: 'Cantidad Entrada', cantidad_pendiente: 'Cantidad Pendiente',
  costo_unitario_pedido: 'Costo Unitario Pedido', moneda: 'Moneda', costo_neto: 'Costo Neto?', indicador_impuestos: 'Indicador de Impuestos',
  costo_pedido: 'Costo Pedido', grupo_articulos_externo: 'Grupo de Artículos Externo', costo_entrada: 'Costo Entrada', costo_pendiente: 'Costo Pendiente',
  fecha_ultima_entrada: 'Fecha de la Última Entrada', dias_transcurridos: 'Días Transcurridos', multiplo: 'Múltiplo',
  existencia_centro_solicitante: 'Existencia Centro Solicitante', unidad_medida_base: 'UM Base', solicitud_pedido: 'Solicitud de Pedido',
  renglon_sp: 'Renglón SP', texto_cabecera: 'Texto de Cabecera', nuestra_referencia: 'Nuestra Referencia', referencia: 'Referencia',
  actualizado_en: 'Actualizado en la base',
};
const TIPOS_COMPRA = {
  fecha_orden: 'date', fecha_estimada_llegada: 'date', fecha_ultima_entrada: 'date', actualizado_en: 'datetime',
  numero_renglon: 'int', dias_antiguedad: 'int', dias_transcurridos: 'int',
  cantidad_pedida: 'num', cantidad_entrada: 'num', cantidad_pendiente: 'num', multiplo: 'num', existencia_centro_solicitante: 'num',
  costo_unitario_pedido: 'money', costo_pedido: 'money', costo_entrada: 'money', costo_pendiente: 'money',
};

const COLS_COMPRAS = [
  { k: 'fecha_orden', t: 'Fecha OC', type: 'date' },
  { k: 'orden_compra', t: 'Orden de compra' },
  { k: 'numero_renglon', t: 'Ren.', type: 'int' },
  { k: '_destino', t: 'Destino', render: (r) => badgeDestino(r._destino) },
  { k: 'texto_cabecera', t: 'Para quién (texto cabecera)' },
  { k: '_documento', t: 'Ticket / pedido venta' },
  { k: 'nuestra_referencia', t: 'Nuestra ref.' },
  { k: 'referencia', t: 'Referencia' },
  { k: 'solicitante_oc', t: 'Solicitante' },
  { k: 'nombre_usuario', t: 'Comprador' },
  { k: 'descripcion_motivo_pedido', t: 'Motivo' },
  { k: 'nombre_proveedor', t: 'Proveedor' },
  { k: 'codigo_material', t: 'Material' },
  { k: 'descripcion_material', t: 'Descripción' },
  { k: 'cantidad_pedida', t: 'Pedida', type: 'num' },
  { k: 'cantidad_entrada', t: 'Recibida', type: 'num' },
  { k: 'cantidad_pendiente', t: 'Pendiente', type: 'num' },
  { k: 'unidad_medida_pedido', t: 'UM' },
  { k: 'costo_pedido', t: 'Costo pedido', type: 'money' },
  { k: 'costo_pendiente', t: 'Costo pendiente', type: 'money' },
  { k: 'fecha_estimada_llegada', t: 'Llegada estimada', type: 'date' },
  { k: 'fecha_ultima_entrada', t: 'Últ. entrada', type: 'date' },
  { k: '_existencia', t: 'Existencia hoy', type: 'num' },
];
const SELECT_COMPRAS = [
  'orden_compra', 'numero_renglon', 'fecha_orden', 'periodo', 'texto_cabecera', 'nuestra_referencia', 'referencia', 'solicitante_oc',
  'nombre_usuario', 'motivo_pedido', 'descripcion_motivo_pedido', 'nombre_proveedor', 'codigo_material', 'descripcion_material',
  'cantidad_pedida', 'cantidad_entrada', 'cantidad_pendiente', 'unidad_medida_pedido', 'costo_pedido', 'costo_pendiente',
  'fecha_estimada_llegada', 'fecha_ultima_entrada', 'estatus_posicion',
].join(',');

const COLS_INV = [
  { k: 'centro', t: 'Centro' },
  { k: 'almacen', t: 'Almacén' },
  { k: 'codigo_material', t: 'Código material' },
  { k: 'descripcion_material', t: 'Descripción' },
  { k: 'clave_proveedor_material', t: 'Clave proveedor' },
  { k: 'numero_proveedor', t: 'Núm. proveedor' },
  { k: 'nombre_proveedor', t: 'Proveedor' },
  { k: 'grupo_materiales', t: 'Gpo.' },
  { k: 'descrip_gpo_materiales', t: 'Grupo materiales' },
  { k: 'grupo_articulos_externo', t: 'Grupo art. externo' },
  { k: 'indicador_abc_actual', t: 'ABC' },
  { k: 'indicador_abc_frecuencia', t: 'ABC+Frec.' },
  { k: 'cantidad_propia', t: 'Cantidad', type: 'num' },
  { k: 'unidad_medida_base', t: 'UM' },
  { k: 'importe_inventario_propio', t: 'Importe inventario', type: 'money' },
  { k: 'costo_reposicion_unitario', t: 'Costo reposición', type: 'money' },
  { k: 'costo_promedio_unitario', t: 'Costo promedio', type: 'money' },
  { k: '_nCompras', t: 'Renglones comprados', type: 'int' },
  { k: '_pedido', t: 'Cant. comprada', type: 'num' },
  { k: '_pendiente', t: 'Pendiente recibir', type: 'num' },
  { k: '_ultFecha', t: 'Última compra', type: 'date' },
  { k: '_ultDestino', t: 'Último destino', render: (r) => (r._ultDestino ? badgeDestino(r._ultDestino) : '') },
  { k: '_ultPara', t: 'Última compra para' },
];
const LABELS_INV = Object.fromEntries(COLS_INV.filter((c) => !c.k.startsWith('_')).map((c) => [c.k, c.t]));

const COLS_CARGAS = [
  { k: 'id', t: 'Carga #', type: 'int' },
  { k: 'fecha', t: 'Fecha de carga', type: 'datetime' },
  { k: 'archivo', t: 'Archivo' },
  { k: 'estado', t: 'Estado' },
  { k: 'registros_inventario', t: 'Renglones inventario', type: 'int' },
  { k: 'registros_compras', t: 'Compras procesadas', type: 'int' },
  { k: 'compras_nuevas', t: 'Compras nuevas', type: 'int' },
  { k: 'compras_actualizadas', t: 'Compras actualizadas', type: 'int' },
  { k: 'fecha_max_orden', t: 'OC más reciente en base', type: 'date' },
];

// ---------- Estado ----------
const S = { compras: [], inv: [], cargas: [], invPorMaterial: new Map(), comprasPorMaterial: new Map() };

const tCompras = new Tabla({
  el: '#tblCompras', pager: '#pagCompras', info: '#infoCompras', cols: COLS_COMPRAS, nombre: 'compras',
  onRow: (r) => detalleCompra(r), onFiltered: (rows) => kpisCompras(rows),
});
const tInv = new Tabla({
  el: '#tblInv', pager: '#pagInv', info: '#infoInv', cols: COLS_INV, nombre: 'inventario',
  onRow: (r) => detalleMaterial(r), onFiltered: (rows) => kpisInv(rows),
});
const tCargas = new Tabla({ el: '#tblCargas', cols: COLS_CARGAS, pageSize: 1000, nombre: 'cargas' });

function kpi(l, v) { return `<div class="kpi"><div class="l">${l}</div><div class="v">${v}</div></div>`; }
function sum(rows, k) { return rows.reduce((a, r) => a + (Number(r[k]) || 0), 0); }

function kpisCompras(rows) {
  const ocs = new Set(rows.map((r) => r.orden_compra)).size;
  const venta = rows.filter((r) => r._destino === 'Venta / Cliente').length;
  $('#kpisCompras').innerHTML = kpi('Renglones', nf0.format(rows.length)) + kpi('Órdenes de compra', nf0.format(ocs))
    + kpi('Importe pedido', mf.format(sum(rows, 'costo_pedido'))) + kpi('Importe pendiente de recibir', mf.format(sum(rows, 'costo_pendiente')))
    + kpi('Renglones para venta / cliente', nf0.format(venta));
}
function kpisInv(rows) {
  $('#kpisInv').innerHTML = kpi('Renglones de inventario', nf0.format(rows.length))
    + kpi('Materiales distintos', nf0.format(new Set(rows.map((r) => r.codigo_material)).size))
    + kpi('Importe de inventario', mf.format(sum(rows, 'importe_inventario_propio')))
    + kpi('Con compras feb–hoy', nf0.format(rows.filter((r) => r._nCompras > 0).length))
    + kpi('Pendiente por recibir', nf0.format(rows.filter((r) => r._pendiente > 0).length));
}

// ---------- Filtros superiores ----------
function opciones(sel, valores, todos = 'Todos') {
  const actual = sel.value;
  const uniq = [...new Set(valores.filter((v) => v !== null && v !== undefined && v !== ''))].sort((a, b) => String(a).localeCompare(String(b), 'es'));
  sel.innerHTML = `<option value="">${todos}</option>` + uniq.map((v) => `<option ${v === actual ? 'selected' : ''}>${esc(v)}</option>`).join('');
}
function opcionesFijas(sel, lista) { sel.innerHTML = lista.map(([v, t]) => `<option value="${v}">${t}</option>`).join(''); }

opcionesFijas($('#fcEstado'), [['', 'Todos'], ['pend', 'Con pendiente por recibir'], ['comp', 'Recibido completo']]);
opcionesFijas($('#fiCompras'), [['', 'Todos'], ['si', 'Con compras'], ['no', 'Sin compras'], ['pend', 'Con pendiente por recibir']]);
opcionesFijas($('#fiExistencia'), [['', 'Todas'], ['con', 'Con existencia (> 0)'], ['sin', 'Sin existencia (≤ 0)']]);

function filtrarCompras() {
  const q = norm($('#fcBuscar').value.trim());
  const desde = $('#fcDesde').value; const hasta = $('#fcHasta').value;
  const f = {
    _destino: $('#fcDestino').value, nombre_usuario: $('#fcUsuario').value, descripcion_motivo_pedido: $('#fcMotivo').value,
    nombre_proveedor: $('#fcProveedor').value, referencia: $('#fcReferencia').value,
  };
  const estado = $('#fcEstado').value;
  const words = q.split(/\s+/).filter(Boolean);
  tCompras.setRows(S.compras.filter((r) => {
    if (desde && (!r.fecha_orden || r.fecha_orden < desde)) return false;
    if (hasta && (!r.fecha_orden || r.fecha_orden > hasta)) return false;
    for (const k in f) if (f[k] && r[k] !== f[k]) return false;
    if (estado === 'pend' && !(r.cantidad_pendiente > 0)) return false;
    if (estado === 'comp' && r.cantidad_pendiente > 0) return false;
    return words.every((w) => r._s.includes(w));
  }));
}
function filtrarInv() {
  const words = norm($('#fiBuscar').value.trim()).split(/\s+/).filter(Boolean);
  const g = $('#fiGrupo').value; const p = $('#fiProveedor').value; const a = $('#fiAbc').value;
  const c = $('#fiCompras').value; const e = $('#fiExistencia').value;
  tInv.setRows(S.inv.filter((r) => {
    if (g && r.descrip_gpo_materiales !== g) return false;
    if (p && r.nombre_proveedor !== p) return false;
    if (a && r.indicador_abc_actual !== a) return false;
    if (c === 'si' && !r._nCompras) return false;
    if (c === 'no' && r._nCompras) return false;
    if (c === 'pend' && !(r._pendiente > 0)) return false;
    if (e === 'con' && !(r.cantidad_propia > 0)) return false;
    if (e === 'sin' && r.cantidad_propia > 0) return false;
    return words.every((w) => r._s.includes(w));
  }));
}

function debounce(fn, ms = 200) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
['#fcBuscar'].forEach((s) => $(s).addEventListener('input', debounce(filtrarCompras)));
['#fcDesde', '#fcHasta', '#fcDestino', '#fcUsuario', '#fcMotivo', '#fcProveedor', '#fcReferencia', '#fcEstado']
  .forEach((s) => $(s).addEventListener('change', filtrarCompras));
$('#fiBuscar').addEventListener('input', debounce(filtrarInv));
['#fiGrupo', '#fiProveedor', '#fiAbc', '#fiCompras', '#fiExistencia'].forEach((s) => $(s).addEventListener('change', filtrarInv));
$('#fcLimpiar').onclick = () => {
  document.querySelectorAll('#tab-compras .filtros input, #tab-compras .filtros select').forEach((i) => { i.value = ''; });
  tCompras.limpiarFiltrosColumna(); filtrarCompras();
};
$('#fiLimpiar').onclick = () => {
  document.querySelectorAll('#tab-inventario .filtros input, #tab-inventario .filtros select').forEach((i) => { i.value = ''; });
  tInv.limpiarFiltrosColumna(); filtrarInv();
};
$('#expCompras').onclick = () => tCompras.exportarCSV();
$('#expInv').onclick = () => tInv.exportarCSV();

// ---------- Pestañas ----------
document.querySelectorAll('.tab').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${b.dataset.tab}`));
  };
});

// ---------- Carga de datos ----------
async function cargarTodo() {
  $('#cargaInfo').textContent = 'Leyendo información de la base de datos…';
  try {
    const [compras, inv, cargas] = await Promise.all([
      fetchAll('compras', SELECT_COMPRAS, 'fecha_orden.desc,orden_compra.desc,numero_renglon.asc'),
      fetchAll('inventario', '*', 'id.asc'),
      fetchAll('cargas', '*', 'id.desc'),
    ]);

    S.invPorMaterial = new Map();
    inv.forEach((r) => {
      const m = S.invPorMaterial.get(r.codigo_material) || { cantidad: 0, filas: [] };
      m.cantidad += Number(r.cantidad_propia) || 0; m.filas.push(r);
      S.invPorMaterial.set(r.codigo_material, m);
    });

    S.comprasPorMaterial = new Map();
    compras.forEach((r) => {
      r._destino = clasificarDestino(r);
      r._documento = documentosVenta(r);
      r._existencia = S.invPorMaterial.has(r.codigo_material) ? S.invPorMaterial.get(r.codigo_material).cantidad : null;
      r._s = norm([r.orden_compra, r.texto_cabecera, r.nuestra_referencia, r.referencia, r.solicitante_oc, r.nombre_usuario,
        r.descripcion_motivo_pedido, r.nombre_proveedor, r.codigo_material, r.descripcion_material, r._destino, r._documento].join(' | '));
      const list = S.comprasPorMaterial.get(r.codigo_material) || [];
      list.push(r); S.comprasPorMaterial.set(r.codigo_material, list);
    });

    inv.forEach((r) => {
      const list = S.comprasPorMaterial.get(r.codigo_material) || [];
      r._nCompras = list.length;
      r._pedido = list.length ? sum(list, 'cantidad_pedida') : null;
      r._pendiente = list.length ? sum(list, 'cantidad_pendiente') : null;
      r._ultFecha = list[0]?.fecha_orden || null; // compras ya vienen ordenadas por fecha desc
      r._ultDestino = list[0]?._destino || null;
      r._ultPara = list[0] ? [list[0].texto_cabecera, list[0].nuestra_referencia].filter(Boolean).join(' · ') : null;
      r._s = norm([r.codigo_material, r.descripcion_material, r.clave_proveedor_material, r.nombre_proveedor, r.numero_proveedor,
        r.descrip_gpo_materiales, r.grupo_articulos_externo, r._ultPara].join(' | '));
    });

    Object.assign(S, { compras, inv, cargas });

    opciones($('#fcDestino'), compras.map((r) => r._destino));
    opciones($('#fcUsuario'), compras.map((r) => r.nombre_usuario));
    opciones($('#fcMotivo'), compras.map((r) => r.descripcion_motivo_pedido));
    opciones($('#fcProveedor'), compras.map((r) => r.nombre_proveedor));
    opciones($('#fcReferencia'), compras.map((r) => r.referencia));
    opciones($('#fiGrupo'), inv.map((r) => r.descrip_gpo_materiales));
    opciones($('#fiProveedor'), inv.map((r) => r.nombre_proveedor));
    opciones($('#fiAbc'), inv.map((r) => r.indicador_abc_actual));

    filtrarCompras();
    filtrarInv();
    tCargas.setRows(cargas);
    pintarUltimaCarga();
  } catch (err) {
    $('#cargaInfo').innerHTML = `<b>Error al leer datos:</b> ${esc(err.message)}`;
  }
}

function ultimaCarga() { return S.cargas.find((c) => c.estado === 'completada'); }
function pintarUltimaCarga() {
  const c = ultimaCarga();
  $('#cargaInfo').innerHTML = c
    ? `<b>Última carga:</b> ${esc(fDateTime(c.fecha))} · ${esc(c.archivo || '')}<br>`
      + `<b>OC más reciente en base:</b> ${esc(fDate(c.fecha_max_orden))} · ${nf0.format(S.compras.length)} compras · ${nf0.format(S.inv.length)} renglones de inventario`
    : 'Aún no hay cargas registradas.';
}

// ---------- Detalles ----------
function abrir(id) { $(id).hidden = false; }
function cerrar(m) { m.hidden = true; }
document.querySelectorAll('.modal').forEach((m) => {
  m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-close]')) cerrar(m); });
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.querySelectorAll('.modal').forEach((m) => { if (m.id !== 'modalCarga' || !subiendo) cerrar(m); }); });

function gridCampos(obj, labels, tipos = {}) {
  return `<div class="det-grid">${Object.keys(labels).map((k) => `<div><div class="l">${esc(labels[k])}</div><div class="v">${esc(fmt({ type: tipos[k] }, obj[k])) || '—'}</div></div>`).join('')}</div>`;
}
function miniTabla(cols, rows) {
  if (!rows.length) return '<p class="hint">Sin registros.</p>';
  return `<div class="mini-wrap"><table><thead><tr>${cols.map((c) => `<th${NUMERIC.has(c.type) ? ' class="n"' : ''}>${esc(c.t)}</th>`).join('')}</tr></thead><tbody>${
    rows.map((r) => `<tr>${cols.map((c) => `<td${NUMERIC.has(c.type) ? ' class="n"' : ''}>${c.render ? c.render(r) : esc(fmt(c, r[c.k]))}</td>`).join('')}</tr>`).join('')
  }</tbody></table></div>`;
}

async function detalleCompra(r) {
  $('#detTitulo').textContent = `OC ${r.orden_compra} · renglón ${r.numero_renglon}`;
  $('#detCuerpo').innerHTML = 'Cargando…';
  abrir('#modalDetalle');
  try {
    const res = await api(`compras?orden_compra=eq.${encodeURIComponent(r.orden_compra)}&numero_renglon=eq.${r.numero_renglon}&select=*`);
    const [full] = await res.json();
    const inv = S.invPorMaterial.get(r.codigo_material);
    $('#detCuerpo').innerHTML = `<p>${badgeDestino(r._destino)} <b>${esc(r.codigo_material)}</b> · ${esc(r.descripcion_material)}</p>`
      + `<p class="hint"><b>Para quién:</b> ${esc(r.texto_cabecera || 'Sin texto de cabecera')}${r._documento ? ` · <b>Ticket / pedido:</b> ${esc(r._documento)}` : ''}${r.nuestra_referencia ? ` · <b>Nuestra ref.:</b> ${esc(r.nuestra_referencia)}` : ''}</p>`
      + gridCampos(full || r, LABELS_COMPRA, TIPOS_COMPRA)
      + '<h3 class="det-sub">Inventario actual de este material</h3>'
      + miniTabla(COLS_INV.slice(0, 17).filter((c) => ['centro', 'almacen', 'nombre_proveedor', 'cantidad_propia', 'unidad_medida_base', 'importe_inventario_propio', 'costo_promedio_unitario'].includes(c.k)), inv ? inv.filas : []);
  } catch (err) {
    $('#detCuerpo').innerHTML = `<p class="msg err">${esc(err.message)}</p>`;
  }
}

const COLS_MINI_COMPRAS = [
  { k: 'fecha_orden', t: 'Fecha OC', type: 'date' }, { k: 'orden_compra', t: 'OC' }, { k: 'numero_renglon', t: 'Ren.', type: 'int' },
  { k: '_destino', t: 'Destino', render: (r) => badgeDestino(r._destino) }, { k: 'texto_cabecera', t: 'Para quién' },
  { k: 'nuestra_referencia', t: 'Nuestra ref.' }, { k: 'referencia', t: 'Referencia' }, { k: 'nombre_usuario', t: 'Comprador' },
  { k: 'descripcion_motivo_pedido', t: 'Motivo' }, { k: 'cantidad_pedida', t: 'Pedida', type: 'num' },
  { k: 'cantidad_entrada', t: 'Recibida', type: 'num' }, { k: 'cantidad_pendiente', t: 'Pendiente', type: 'num' },
  { k: 'costo_pedido', t: 'Costo', type: 'money' },
];
function detalleMaterial(r) {
  $('#detTitulo').textContent = `Material ${r.codigo_material}`;
  const compras = S.comprasPorMaterial.get(r.codigo_material) || [];
  $('#detCuerpo').innerHTML = `<p><b>${esc(r.descripcion_material)}</b></p>`
    + gridCampos(r, LABELS_INV, { cantidad_propia: 'num', importe_inventario_propio: 'money', costo_reposicion_unitario: 'money', costo_promedio_unitario: 'money' })
    + `<h3 class="det-sub">Compras de este material y para quién se compraron (${compras.length})</h3>`
    + miniTabla(COLS_MINI_COMPRAS, compras);
  abrir('#modalDetalle');
}

// ---------- Actualización de la base de datos ----------
let libro = null; let subiendo = false;
const DETECTAR = {
  compras: (h) => h.includes('Orden de Compra') && h.includes('Número de Renglón'),
  inventario: (h) => h.includes('Cantidad Propia') && h.includes('Codigo Material'),
};

$('#btnActualizar').onclick = () => {
  const c = ultimaCarga();
  $('#hintCarga').innerHTML = c
    ? `Última carga: <b>${esc(fDateTime(c.fecha))}</b>. La OC más reciente en la base es del <b>${esc(fDate(c.fecha_max_orden))}</b>: basta con subir el reporte de compras desde esa fecha (las OC que ya existan se actualizan, no se duplican) y la hoja de inventario actual completa.`
    : 'Sube el Excel con las hojas "Inventario" y "Reporte de compras".';
  $('#msgCarga').textContent = ''; $('#msgCarga').className = 'msg';
  $('#progreso').hidden = true;
  abrir('#modalCarga');
};
$('#btnRecargar').onclick = cargarTodo;

$('#archivo').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  libro = null; $('#hojas').innerHTML = ''; $('#btnSubir').disabled = true; $('#msgCarga').textContent = '';
  if (!file) return;
  $('#msgCarga').textContent = 'Leyendo archivo…';
  try {
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const hojas = [];
    wb.SheetNames.forEach((name) => {
      const filas = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: '', raw: true })
        .map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.trim(), typeof v === 'string' ? v.trim() : v])));
      const headers = Object.keys(filas[0] || {});
      const tipo = Object.keys(DETECTAR).find((t) => DETECTAR[t](headers));
      if (tipo) hojas.push({ name, tipo, filas });
    });
    if (!hojas.length) throw new Error('No se encontró una hoja de "Inventario" ni de "Reporte de compras" con los encabezados esperados.');
    libro = { nombre: file.name, hojas };
    $('#hojas').innerHTML = hojas.map((h, i) => `<label><input type="checkbox" data-i="${i}" checked>
      <span><b>${esc(h.name)}</b> · ${nf0.format(h.filas.length)} filas
      <small>${h.tipo === 'inventario' ? 'Reemplaza el inventario completo.' : 'Agrega OC nuevas y actualiza las existentes (Orden de Compra + Renglón).'}</small></span></label>`).join('');
    $('#msgCarga').textContent = '';
    $('#btnSubir').disabled = false;
  } catch (err) {
    $('#msgCarga').className = 'msg err'; $('#msgCarga').textContent = err.message;
  }
});

$('#btnSubir').onclick = async () => {
  const clave = $('#clave').value;
  const msg = $('#msgCarga');
  if (!clave) { msg.className = 'msg err'; msg.textContent = 'Escribe la clave de carga.'; return; }
  const elegidas = [...$('#hojas').querySelectorAll('input:checked')].map((i) => libro.hojas[Number(i.dataset.i)])
    .sort((a, b) => (a.tipo === 'inventario' ? 0 : 1) - (b.tipo === 'inventario' ? 0 : 1));
  if (!elegidas.length) { msg.className = 'msg err'; msg.textContent = 'Selecciona al menos una hoja.'; return; }

  subiendo = true; $('#btnSubir').disabled = true; msg.className = 'msg'; msg.textContent = '';
  $('#progreso').hidden = false;
  const total = elegidas.reduce((a, h) => a + h.filas.length, 0);
  let hechos = 0;
  const avance = (t) => {
    const p = total ? Math.round((hechos / total) * 100) : 100;
    $('#barra').style.width = `${p}%`; $('#progTxt').textContent = `${t} · ${p}%`;
  };
  try {
    avance('Iniciando');
    const id = await rpc('iniciar_carga', { p_clave: clave, p_archivo: libro.nombre });
    for (const h of elegidas) {
      for (let i = 0; i < h.filas.length; i += LOTE) {
        const lote = h.filas.slice(i, i + LOTE);
        await rpc('cargar_lote', { p_clave: clave, p_carga_id: id, p_tipo: h.tipo, p_filas: lote });
        hechos += lote.length;
        avance(`Subiendo ${h.name}`);
      }
    }
    avance('Finalizando');
    const c = await rpc('finalizar_carga', { p_clave: clave, p_carga_id: id });
    msg.className = 'msg ok';
    msg.innerHTML = `Carga #${c.id} completada: ${nf0.format(c.compras_nuevas)} compras nuevas, ${nf0.format(c.compras_actualizadas)} actualizadas`
      + (c.registros_inventario ? `, inventario reemplazado con ${nf0.format(c.registros_inventario)} renglones.` : '.');
    await cargarTodo();
  } catch (err) {
    msg.className = 'msg err'; msg.textContent = `No se completó la carga: ${err.message}`;
  } finally {
    subiendo = false; $('#btnSubir').disabled = false;
  }
};

cargarTodo();
