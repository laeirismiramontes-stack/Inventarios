'use strict';

const { SUPABASE_URL, SUPABASE_KEY } = window.APP_CONFIG;
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const $ = (s) => document.querySelector(s);
const LOTE = 500;
let token = null;

// ---------- API ----------
async function api(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token || SUPABASE_KEY}`, ...(opts.headers || {}) },
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
const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const mesDe = (d) => (d ? `${MESES[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}` : null);
const ordenMes = (m) => { const [n, y] = m.split(' '); return Number(y) * 100 + MESES.indexOf(n); };

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

// El destino de cada renglón ("Venta / Cliente", "Stock", "Otro") se calcula en la base
// (vista compras_destino, función f_destino) a partir del Texto de Cabecera de la OC.
function badgeDestino(d) {
  if (!d) return '';
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
    return norm(fmt(c, v)).includes(norm(f)) || norm(v).includes(norm(f));
  }

  apply() {
    const act = this.cols.filter((c) => this.colF[c.k]);
    const rows = act.length
      ? this.base.filter((r) => act.every((c) => this.match(c, r[c.k], this.colF[c.k])))
      : this.base.slice();
    if (this.sort) {
      const { k, dir } = this.sort;
      const col = this.cols.find((c) => c.k === k);
      const num = NUMERIC.has(col.type);
      const key = col.sortKey || ((v) => v);
      rows.sort((a, b) => {
        const x = a[k]; const y = b[k];
        if (x == null || x === '') return 1;
        if (y == null || y === '') return -1;
        const kx = key(x); const ky = key(y);
        return (num || typeof kx === 'number' ? kx - ky : String(kx).localeCompare(String(ky), 'es', { numeric: true })) * dir;
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
        const cls = [NUMERIC.has(c.type) ? 'n' : '', c.cls || ''].filter(Boolean).join(' ');
        return `<td${cls ? ` class="${cls}"` : ''}${title}>${html}</td>`;
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
      return NUMERIC.has(c.type) ? (v ?? '') : q(fmt(c, v));
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

const COL_MES = (k) => ({ k, t: 'Mes', sortKey: ordenMes });

const COLS_COMPRAS = [
  { k: 'fecha_orden', t: 'Fecha OC', type: 'date' },
  COL_MES('_mes'),
  { k: 'orden_compra', t: 'Orden de compra' },
  { k: 'numero_renglon', t: 'Ren.', type: 'int' },
  { k: 'destino', t: 'Destino', render: (r) => badgeDestino(r.destino) },
  { k: 'vendedor_oc', t: 'Vendedor (OC)' },
  { k: 'texto_cabecera', t: 'Para quién (texto cabecera)' },
  { k: 'documento_venta', t: 'Ticket / pedido venta' },
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
  'orden_compra', 'numero_renglon', 'fecha_orden', 'texto_cabecera', 'nuestra_referencia', 'referencia', 'solicitante_oc',
  'nombre_usuario', 'motivo_pedido', 'descripcion_motivo_pedido', 'nombre_proveedor', 'codigo_material', 'descripcion_material',
  'cantidad_pedida', 'cantidad_entrada', 'cantidad_pendiente', 'unidad_medida_pedido', 'costo_pedido', 'costo_pendiente',
  'fecha_estimada_llegada', 'fecha_ultima_entrada', 'destino', 'documento_venta', 'vendedor_oc',
].join(',');

const COLS_INV = [
  { k: 'centro', t: 'Centro' },
  { k: 'almacen', t: 'Almacén' },
  { k: 'codigo_material', t: 'Código material' },
  { k: 'descripcion_material', t: 'Descripción' },
  { k: 'cantidad_propia', t: 'Cantidad', type: 'num' },
  { k: 'unidad_medida_base', t: 'UM' },
  { k: '_destino', t: 'Destino última compra', render: (r) => badgeDestino(r._destino) },
  { k: '_comentario', t: 'Comentario', cls: 'comentario' },
  { k: '_ultFecha', t: 'Última compra', type: 'date' },
  COL_MES('_ultMes'),
  { k: '_ultOC', t: 'Última OC' },
  { k: '_cliente', t: 'Cliente (factura)' },
  { k: '_vendedor', t: 'Vendedor' },
  { k: '_vendido', t: 'Vendido desde última OC', type: 'num' },
  { k: '_nCompras', t: 'Renglones comprados', type: 'int' },
  { k: '_pedido', t: 'Cant. comprada', type: 'num' },
  { k: '_pendiente', t: 'Pendiente recibir', type: 'num' },
  { k: 'importe_inventario_propio', t: 'Importe inventario', type: 'money' },
  { k: 'costo_reposicion_unitario', t: 'Costo reposición', type: 'money' },
  { k: 'costo_promedio_unitario', t: 'Costo promedio', type: 'money' },
  { k: 'clave_proveedor_material', t: 'Clave proveedor' },
  { k: 'numero_proveedor', t: 'Núm. proveedor' },
  { k: 'nombre_proveedor', t: 'Proveedor' },
  { k: 'grupo_materiales', t: 'Gpo.' },
  { k: 'descrip_gpo_materiales', t: 'Grupo materiales' },
  { k: 'grupo_articulos_externo', t: 'Grupo art. externo' },
  { k: 'indicador_abc_actual', t: 'ABC' },
  { k: 'indicador_abc_frecuencia', t: 'ABC+Frec.' },
];
const LABELS_INV = Object.fromEntries(COLS_INV.filter((c) => !c.k.startsWith('_')).map((c) => [c.k, c.t]));

const COLS_VENTAS = [
  { k: 'fecha_factura', t: 'Fecha factura', type: 'date' },
  COL_MES('_mes'),
  { k: 'folio_factura', t: 'Folio' },
  { k: 'codigo_material', t: 'Material' },
  { k: 'descripcion_material', t: 'Descripción' },
  { k: 'cantidad_facturada', t: 'Cantidad', type: 'num' },
  { k: 'nombre_cliente', t: 'Cliente' },
  { k: 'nombre_vendedor', t: 'Vendedor' },
  { k: 'numero_vendedor', t: 'Núm. vendedor' },
  { k: 'canal_distribucion', t: 'Canal' },
  { k: 'indicador_abc_frecuencia', t: 'ABC+Frec.' },
  { k: 'existencia_centro', t: 'Existencia centro', type: 'num' },
  { k: 'importe_venta', t: 'Importe venta', type: 'money' },
  { k: 'costo_ventas', t: 'Costo de ventas', type: 'money' },
];

const COLS_CARGAS = [
  { k: 'id', t: 'Carga #', type: 'int' },
  { k: 'fecha', t: 'Fecha de carga', type: 'datetime' },
  { k: 'archivo', t: 'Archivo' },
  { k: 'estado', t: 'Estado' },
  { k: 'registros_inventario', t: 'Renglones inventario', type: 'int' },
  { k: 'registros_compras', t: 'Compras procesadas', type: 'int' },
  { k: 'compras_nuevas', t: 'Compras nuevas', type: 'int' },
  { k: 'compras_actualizadas', t: 'Compras actualizadas', type: 'int' },
  { k: 'registros_ventas', t: 'Renglones ventas', type: 'int' },
  { k: 'fecha_max_orden', t: 'OC más reciente en base', type: 'date' },
];

// ---------- Estado ----------
const S = { compras: [], inv: [], ventas: [], cargas: [], invPorMaterial: new Map(), comprasPorMaterial: new Map(), ventasPorMaterial: new Map() };

const tInv = new Tabla({
  el: '#tblInv', pager: '#pagInv', info: '#infoInv', cols: COLS_INV, nombre: 'inventario',
  onRow: (r) => detalleMaterial(r), onFiltered: (rows) => kpisInv(rows),
});
const tCompras = new Tabla({
  el: '#tblCompras', pager: '#pagCompras', info: '#infoCompras', cols: COLS_COMPRAS, nombre: 'compras',
  onRow: (r) => detalleCompra(r), onFiltered: (rows) => kpisCompras(rows),
});
const tVentas = new Tabla({
  el: '#tblVentas', pager: '#pagVentas', info: '#infoVentas', cols: COLS_VENTAS, nombre: 'ventas',
  onRow: (r) => { const i = S.inv.find((x) => x.codigo_material === r.codigo_material); if (i) detalleMaterial(i); },
  onFiltered: (rows) => kpisVentas(rows),
});
const tCargas = new Tabla({ el: '#tblCargas', cols: COLS_CARGAS, pageSize: 1000, nombre: 'cargas' });

function kpi(l, v) { return `<div class="kpi"><div class="l">${l}</div><div class="v">${v}</div></div>`; }
function sum(rows, k) { return rows.reduce((a, r) => a + (Number(r[k]) || 0), 0); }

function kpisCompras(rows) {
  const ocs = new Set(rows.map((r) => r.orden_compra)).size;
  const venta = rows.filter((r) => r.destino === 'Venta / Cliente').length;
  $('#kpisCompras').innerHTML = kpi('Renglones', nf0.format(rows.length)) + kpi('Órdenes de compra', nf0.format(ocs))
    + kpi('Importe pedido', mf.format(sum(rows, 'costo_pedido'))) + kpi('Importe pendiente de recibir', mf.format(sum(rows, 'costo_pendiente')))
    + kpi('Renglones para venta / cliente', nf0.format(venta));
}
function kpisInv(rows) {
  $('#kpisInv').innerHTML = kpi('Renglones de inventario', nf0.format(rows.length))
    + kpi('Importe de inventario', mf.format(sum(rows, 'importe_inventario_propio')))
    + kpi('Última compra para stock', nf0.format(rows.filter((r) => r._destino === 'Stock').length))
    + kpi('Última compra para venta / cliente', nf0.format(rows.filter((r) => r._destino === 'Venta / Cliente').length))
    + kpi('Sin compras feb–hoy', nf0.format(rows.filter((r) => !r._nCompras).length));
}
function kpisVentas(rows) {
  $('#kpisVentas').innerHTML = kpi('Renglones', nf0.format(rows.length))
    + kpi('Facturas', nf0.format(new Set(rows.map((r) => r.folio_factura)).size))
    + kpi('Importe de venta', mf.format(sum(rows, 'importe_venta')))
    + kpi('Costo de ventas', mf.format(sum(rows, 'costo_ventas')))
    + kpi('Clientes', nf0.format(new Set(rows.map((r) => r.nombre_cliente)).size));
}

// ---------- Filtros superiores ----------
function opciones(sel, valores, { todos = 'Todos', orden } = {}) {
  const actual = sel.value;
  const uniq = [...new Set(valores.filter((v) => v !== null && v !== undefined && v !== ''))]
    .sort(orden || ((a, b) => String(a).localeCompare(String(b), 'es')));
  sel.innerHTML = `<option value="">${todos}</option>` + uniq.map((v) => `<option ${v === actual ? 'selected' : ''}>${esc(v)}</option>`).join('');
}
const opcionesMes = (sel, valores) => opciones(sel, valores, { orden: (a, b) => ordenMes(a) - ordenMes(b) });
function opcionesFijas(sel, lista) { sel.innerHTML = lista.map(([v, t]) => `<option value="${v}">${t}</option>`).join(''); }

opcionesFijas($('#fcEstado'), [['', 'Todos'], ['pend', 'Con pendiente por recibir'], ['comp', 'Recibido completo']]);
opcionesFijas($('#fiCompras'), [['', 'Todos'], ['si', 'Con compras'], ['no', 'Sin compras'], ['pend', 'Con pendiente por recibir']]);
opcionesFijas($('#fiExistencia'), [['', 'Todas'], ['con', 'Con existencia (> 0)'], ['sin', 'Sin existencia (≤ 0)']]);

const palabras = (sel) => norm($(sel).value.trim()).split(/\s+/).filter(Boolean);
function enRango(d, desde, hasta) {
  if (desde && (!d || d < desde)) return false;
  if (hasta && (!d || d > hasta)) return false;
  return true;
}

function filtrarCompras() {
  const words = palabras('#fcBuscar');
  const f = {
    _mes: $('#fcMes').value, destino: $('#fcDestino').value, vendedor_oc: $('#fcVendedor').value,
    nombre_usuario: $('#fcUsuario').value, descripcion_motivo_pedido: $('#fcMotivo').value,
    nombre_proveedor: $('#fcProveedor').value, referencia: $('#fcReferencia').value,
  };
  const estado = $('#fcEstado').value; const desde = $('#fcDesde').value; const hasta = $('#fcHasta').value;
  tCompras.setRows(S.compras.filter((r) => {
    if (!enRango(r.fecha_orden, desde, hasta)) return false;
    for (const k in f) if (f[k] && r[k] !== f[k]) return false;
    if (estado === 'pend' && !(r.cantidad_pendiente > 0)) return false;
    if (estado === 'comp' && r.cantidad_pendiente > 0) return false;
    return words.every((w) => r._s.includes(w));
  }));
}
function filtrarInv() {
  const words = palabras('#fiBuscar');
  const f = {
    _destino: $('#fiDestino').value, _ultMes: $('#fiMes').value, descrip_gpo_materiales: $('#fiGrupo').value,
    nombre_proveedor: $('#fiProveedor').value, indicador_abc_actual: $('#fiAbc').value,
  };
  const c = $('#fiCompras').value; const e = $('#fiExistencia').value;
  tInv.setRows(S.inv.filter((r) => {
    for (const k in f) if (f[k] && r[k] !== f[k]) return false;
    if (c === 'si' && !r._nCompras) return false;
    if (c === 'no' && r._nCompras) return false;
    if (c === 'pend' && !(r._pendiente > 0)) return false;
    if (e === 'con' && !(r.cantidad_propia > 0)) return false;
    if (e === 'sin' && r.cantidad_propia > 0) return false;
    return words.every((w) => r._s.includes(w));
  }));
}
function filtrarVentas() {
  const words = palabras('#fvBuscar');
  const f = { _mes: $('#fvMes').value, nombre_vendedor: $('#fvVendedor').value, canal_distribucion: $('#fvCanal').value };
  const desde = $('#fvDesde').value; const hasta = $('#fvHasta').value;
  tVentas.setRows(S.ventas.filter((r) => {
    if (!enRango(r.fecha_factura, desde, hasta)) return false;
    for (const k in f) if (f[k] && r[k] !== f[k]) return false;
    return words.every((w) => r._s.includes(w));
  }));
}

function debounce(fn, ms = 200) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function conectarFiltros(panel, buscar, fn, tabla) {
  $(buscar).addEventListener('input', debounce(fn));
  document.querySelectorAll(`${panel} .filtros select, ${panel} .filtros input[type=date]`).forEach((s) => s.addEventListener('change', fn));
  $(`${panel} .filtros .btn`).onclick = () => {
    document.querySelectorAll(`${panel} .filtros input, ${panel} .filtros select`).forEach((i) => { i.value = ''; });
    tabla.limpiarFiltrosColumna(); fn();
  };
}
conectarFiltros('#tab-compras', '#fcBuscar', filtrarCompras, tCompras);
conectarFiltros('#tab-inventario', '#fiBuscar', filtrarInv, tInv);
conectarFiltros('#tab-ventas', '#fvBuscar', filtrarVentas, tVentas);
$('#expCompras').onclick = () => tCompras.exportarCSV();
$('#expInv').onclick = () => tInv.exportarCSV();
$('#expVentas').onclick = () => tVentas.exportarCSV();

// ---------- Pestañas ----------
document.querySelectorAll('.tab').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${b.dataset.tab}`));
  };
});

// ---------- Carga de datos ----------
const agrupar = (rows, k) => rows.reduce((m, r) => { const l = m.get(r[k]) || []; l.push(r); m.set(r[k], l); return m; }, new Map());

async function cargarTodo() {
  $('#cargaInfo').textContent = 'Leyendo información de la base de datos…';
  try {
    const [compras, inv, ventas, comentarios, cargas] = await Promise.all([
      fetchAll('compras_destino', SELECT_COMPRAS, 'fecha_orden.desc,orden_compra.desc,numero_renglon.asc'),
      fetchAll('inventario', '*', 'id.asc'),
      fetchAll('ventas', '*', 'fecha_factura.desc,folio_factura.desc,id.asc'),
      fetchAll('material_comentario', '*', 'codigo_material.asc'),
      fetchAll('cargas', '*', 'id.desc'),
    ]);

    S.invPorMaterial = agrupar(inv, 'codigo_material');
    S.comprasPorMaterial = agrupar(compras, 'codigo_material');
    S.ventasPorMaterial = agrupar(ventas, 'codigo_material');
    const comPorMaterial = new Map(comentarios.map((c) => [c.codigo_material, c]));

    compras.forEach((r) => {
      r._mes = mesDe(r.fecha_orden);
      const filas = S.invPorMaterial.get(r.codigo_material);
      r._existencia = filas ? sum(filas, 'cantidad_propia') : null;
      r._s = norm([r.orden_compra, r.texto_cabecera, r.nuestra_referencia, r.referencia, r.solicitante_oc, r.nombre_usuario,
        r.descripcion_motivo_pedido, r.nombre_proveedor, r.codigo_material, r.descripcion_material, r.destino, r.documento_venta,
        r.vendedor_oc].join(' | '));
    });
    ventas.forEach((r) => {
      r._mes = mesDe(r.fecha_factura);
      r._s = norm([r.folio_factura, r.codigo_material, r.descripcion_material, r.nombre_cliente, r.nombre_vendedor].join(' | '));
    });
    inv.forEach((r) => {
      const list = S.comprasPorMaterial.get(r.codigo_material) || [];
      const c = comPorMaterial.get(r.codigo_material);
      r._nCompras = list.length;
      r._pedido = list.length ? sum(list, 'cantidad_pedida') : null;
      r._pendiente = list.length ? sum(list, 'cantidad_pendiente') : null;
      r._destino = c ? c.destino : null;
      r._comentario = c ? c.comentario : `${r.codigo_material}: sin compras de febrero a la fecha`;
      r._ultFecha = c ? c.fecha_orden : null;
      r._ultMes = mesDe(r._ultFecha);
      r._ultOC = c ? c.orden_compra : null;
      r._cliente = c ? c.nombre_cliente : null;
      r._vendedor = c ? (c.vendedor_factura || c.vendedor_oc) : null;
      r._vendido = c ? c.vendido_desde_ultima_oc : null;
      r._s = norm([r.codigo_material, r.descripcion_material, r.clave_proveedor_material, r.nombre_proveedor, r.numero_proveedor,
        r.descrip_gpo_materiales, r.grupo_articulos_externo, r._comentario].join(' | '));
    });

    Object.assign(S, { compras, inv, ventas, cargas });

    opcionesMes($('#fcMes'), compras.map((r) => r._mes));
    opciones($('#fcDestino'), compras.map((r) => r.destino));
    opciones($('#fcVendedor'), compras.map((r) => r.vendedor_oc));
    opciones($('#fcUsuario'), compras.map((r) => r.nombre_usuario));
    opciones($('#fcMotivo'), compras.map((r) => r.descripcion_motivo_pedido));
    opciones($('#fcProveedor'), compras.map((r) => r.nombre_proveedor));
    opciones($('#fcReferencia'), compras.map((r) => r.referencia));
    opciones($('#fiDestino'), inv.map((r) => r._destino));
    opcionesMes($('#fiMes'), inv.map((r) => r._ultMes));
    opciones($('#fiGrupo'), inv.map((r) => r.descrip_gpo_materiales));
    opciones($('#fiProveedor'), inv.map((r) => r.nombre_proveedor));
    opciones($('#fiAbc'), inv.map((r) => r.indicador_abc_actual));
    opcionesMes($('#fvMes'), ventas.map((r) => r._mes));
    opciones($('#fvVendedor'), ventas.map((r) => r.nombre_vendedor));
    opciones($('#fvCanal'), ventas.map((r) => r.canal_distribucion));

    filtrarInv();
    filtrarCompras();
    filtrarVentas();
    tCargas.setRows(cargas);
    pintarUltimaCarga();
  } catch (err) {
    $('#cargaInfo').innerHTML = `<b>Error al leer datos:</b> ${esc(err.message)}`;
  }
}

function ultimaCarga() { return S.cargas.find((c) => c.estado === 'completada'); }
function pintarUltimaCarga() {
  const c = ultimaCarga();
  const ventasRango = S.ventas.length ? `${fDate(S.ventas[S.ventas.length - 1].fecha_factura)} al ${fDate(S.ventas[0].fecha_factura)}` : 'sin ventas';
  $('#cargaInfo').innerHTML = c
    ? `<b>Última carga:</b> ${esc(fDateTime(c.fecha))} · ${esc(c.archivo || '')}<br>`
      + `<b>OC más reciente:</b> ${esc(fDate(c.fecha_max_orden))} · <b>Ventas:</b> ${esc(ventasRango)} · ${nf0.format(S.inv.length)} renglones de inventario`
    : 'Aún no hay cargas registradas.';
}

// ---------- Detalles ----------
function abrir(id) { $(id).hidden = false; }
function cerrar(m) { m.hidden = true; }
document.querySelectorAll('.modal').forEach((m) => {
  m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-close]')) cerrar(m); });
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.querySelectorAll('.modal').forEach((m) => { if (m.id !== 'modalCarga' || !subiendo) cerrar(m); });
});

function gridCampos(obj, labels, tipos = {}) {
  return `<div class="det-grid">${Object.keys(labels).map((k) => `<div><div class="l">${esc(labels[k])}</div><div class="v">${esc(fmt({ type: tipos[k] }, obj[k])) || '—'}</div></div>`).join('')}</div>`;
}
function miniTabla(cols, rows) {
  if (!rows.length) return '<p class="hint">Sin registros.</p>';
  return `<div class="mini-wrap"><table><thead><tr>${cols.map((c) => `<th${NUMERIC.has(c.type) ? ' class="n"' : ''}>${esc(c.t)}</th>`).join('')}</tr></thead><tbody>${
    rows.map((r) => `<tr>${cols.map((c) => `<td${NUMERIC.has(c.type) ? ' class="n"' : ''}>${c.render ? c.render(r) : esc(fmt(c, r[c.k]))}</td>`).join('')}</tr>`).join('')
  }</tbody></table></div>`;
}
const pick = (cols, keys) => cols.filter((c) => keys.includes(c.k));

async function detalleCompra(r) {
  $('#detTitulo').textContent = `OC ${r.orden_compra} · renglón ${r.numero_renglon}`;
  $('#detCuerpo').innerHTML = 'Cargando…';
  abrir('#modalDetalle');
  try {
    const res = await api(`compras?orden_compra=eq.${encodeURIComponent(r.orden_compra)}&numero_renglon=eq.${r.numero_renglon}&select=*`);
    const [full] = await res.json();
    const inv = S.invPorMaterial.get(r.codigo_material) || [];
    $('#detCuerpo').innerHTML = `<p>${badgeDestino(r.destino)} <b>${esc(r.codigo_material)}</b> · ${esc(r.descripcion_material)}</p>`
      + `<p class="hint"><b>Para quién:</b> ${esc(r.texto_cabecera || 'Sin texto de cabecera')}${r.vendedor_oc ? ` · <b>Vendedor:</b> ${esc(r.vendedor_oc)}` : ''}${r.documento_venta ? ` · <b>Ticket / pedido:</b> ${esc(r.documento_venta)}` : ''}</p>`
      + gridCampos(full || r, LABELS_COMPRA, TIPOS_COMPRA)
      + '<h3 class="det-sub">Inventario actual de este material</h3>'
      + miniTabla(pick(COLS_INV, ['centro', 'almacen', 'nombre_proveedor', 'cantidad_propia', 'unidad_medida_base', 'importe_inventario_propio', '_comentario']), inv);
  } catch (err) {
    $('#detCuerpo').innerHTML = `<p class="msg err">${esc(err.message)}</p>`;
  }
}

function detalleMaterial(r) {
  $('#detTitulo').textContent = `Material ${r.codigo_material}`;
  const compras = S.comprasPorMaterial.get(r.codigo_material) || [];
  const ventas = S.ventasPorMaterial.get(r.codigo_material) || [];
  $('#detCuerpo').innerHTML = `<p><b>${esc(r.descripcion_material)}</b></p>`
    + `<p class="hint">${badgeDestino(r._destino)} ${esc(r._comentario)}</p>`
    + gridCampos(r, LABELS_INV, { cantidad_propia: 'num', importe_inventario_propio: 'money', costo_reposicion_unitario: 'money', costo_promedio_unitario: 'money' })
    + `<h3 class="det-sub">Compras de este material y para quién se compraron (${compras.length})</h3>`
    + miniTabla(pick(COLS_COMPRAS, ['fecha_orden', 'orden_compra', 'numero_renglon', 'destino', 'vendedor_oc', 'texto_cabecera', 'nombre_usuario',
      'descripcion_motivo_pedido', 'cantidad_pedida', 'cantidad_entrada', 'cantidad_pendiente', 'costo_pedido']), compras)
    + `<h3 class="det-sub">Ventas de este material (${ventas.length})</h3>`
    + miniTabla(pick(COLS_VENTAS, ['fecha_factura', 'folio_factura', 'cantidad_facturada', 'nombre_cliente', 'nombre_vendedor', 'importe_venta']), ventas);
  abrir('#modalDetalle');
}

// ---------- Actualización de la base de datos ----------
let libro = null; let subiendo = false;
const DETECTAR = {
  compras: (h) => h.includes('Orden de Compra') && h.includes('Número de Renglón'),
  inventario: (h) => h.includes('Cantidad Propia') && h.includes('Codigo Material'),
  ventas: (h) => h.includes('Folio de la Factura') && h.includes('Cantidad Facturada UMB'),
};
const DESCRIPCION_TIPO = {
  inventario: 'Inventario: reemplaza el inventario completo.',
  compras: 'Compras: agrega OC nuevas y actualiza las existentes (Orden de Compra + Renglón).',
  ventas: 'Ventas: reemplaza las ventas de los días que trae el archivo.',
};
const ORDEN_TIPO = { inventario: 0, compras: 1, ventas: 2 };

$('#btnActualizar').onclick = () => {
  const c = ultimaCarga();
  $('#hintCarga').innerHTML = c
    ? `Última carga: <b>${esc(fDateTime(c.fecha))}</b>. La OC más reciente en la base es del <b>${esc(fDate(c.fecha_max_orden))}</b>: basta con subir el reporte de compras desde esa fecha, la hoja de inventario actual y las ventas de los días nuevos.`
    : 'Sube el Excel con las hojas de inventario, reporte de compras y/o ventas.';
  $('#msgCarga').textContent = ''; $('#msgCarga').className = 'msg';
  $('#progreso').hidden = true;
  abrir('#modalCarga');
};
$('#btnRecargar').onclick = cargarTodo;

$('#archivo').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  libro = null; $('#hojas').innerHTML = ''; $('#btnSubir').disabled = true; $('#msgCarga').textContent = '';
  if (!file) return;
  $('#msgCarga').className = 'msg'; $('#msgCarga').textContent = 'Leyendo archivo…';
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
    if (!hojas.length) throw new Error('No se encontró una hoja de inventario, reporte de compras o ventas con los encabezados esperados.');
    libro = { nombre: file.name, hojas };
    $('#hojas').innerHTML = hojas.map((h, i) => `<label><input type="checkbox" data-i="${i}" checked>
      <span><b>${esc(h.name)}</b> · ${nf0.format(h.filas.length)} filas<small>${DESCRIPCION_TIPO[h.tipo]}</small></span></label>`).join('');
    $('#msgCarga').textContent = '';
    $('#btnSubir').disabled = false;
  } catch (err) {
    $('#msgCarga').className = 'msg err'; $('#msgCarga').textContent = err.message;
  }
});

$('#btnSubir').onclick = async () => {
  const msg = $('#msgCarga');
  const elegidas = [...$('#hojas').querySelectorAll('input:checked')].map((i) => libro.hojas[Number(i.dataset.i)])
    .sort((a, b) => ORDEN_TIPO[a.tipo] - ORDEN_TIPO[b.tipo]);
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
    const id = await rpc('iniciar_carga', { p_archivo: libro.nombre });
    for (const h of elegidas) {
      for (let i = 0; i < h.filas.length; i += LOTE) {
        const lote = h.filas.slice(i, i + LOTE);
        await rpc('cargar_lote', { p_carga_id: id, p_tipo: h.tipo, p_filas: lote });
        hechos += lote.length;
        avance(`Subiendo ${h.name}`);
      }
    }
    avance('Finalizando');
    const c = await rpc('finalizar_carga', { p_carga_id: id });
    const partes = [];
    if (c.registros_compras) partes.push(`${nf0.format(c.compras_nuevas)} compras nuevas y ${nf0.format(c.compras_actualizadas)} actualizadas`);
    if (c.registros_inventario) partes.push(`inventario reemplazado con ${nf0.format(c.registros_inventario)} renglones`);
    if (c.registros_ventas) partes.push(`${nf0.format(c.registros_ventas)} renglones de ventas`);
    msg.className = 'msg ok';
    msg.textContent = `Carga #${c.id} completada: ${partes.join(', ')}.`;
    await cargarTodo();
  } catch (err) {
    msg.className = 'msg err'; msg.textContent = `No se completó la carga: ${err.message}`;
  } finally {
    subiendo = false; $('#btnSubir').disabled = false;
  }
};

// ---------- Sesión ----------
let modoLogin = 'entrar'; // entrar | crear | recuperar | nueva
function setModo(m) {
  modoLogin = m;
  $('#lgMsg').textContent = ''; $('#lgMsg').className = 'msg';
  $('#lgPassWrap').hidden = m === 'recuperar';
  $('#lgEmail').closest('label').hidden = m === 'nueva';
  $('#lgEntrar').textContent = { entrar: 'Entrar', crear: 'Crear cuenta', recuperar: 'Enviar enlace para cambiar contraseña', nueva: 'Guardar nueva contraseña' }[m];
  $('#lgCrear').textContent = m === 'entrar' ? 'Crear cuenta' : 'Ya tengo cuenta';
}
$('#lgCrear').onclick = () => setModo(modoLogin === 'entrar' ? 'crear' : 'entrar');
$('#lgOlvide').onclick = () => setModo('recuperar');

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#lgEmail').value.trim(); const password = $('#lgPass').value;
  const msg = $('#lgMsg'); msg.className = 'msg'; msg.textContent = 'Procesando…';
  let error = null;
  if (modoLogin === 'entrar') ({ error } = await sb.auth.signInWithPassword({ email, password }));
  else if (modoLogin === 'crear') {
    let data;
    ({ data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin } }));
    if (!error && !data.session) { msg.className = 'msg ok'; msg.textContent = 'Te enviamos un correo para confirmar tu cuenta. Confírmala y vuelve a entrar.'; setTimeout(() => setModo('entrar'), 50); return; }
  } else if (modoLogin === 'recuperar') {
    ({ error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin }));
    if (!error) { msg.className = 'msg ok'; msg.textContent = 'Revisa tu correo para cambiar la contraseña.'; return; }
  } else if (modoLogin === 'nueva') {
    ({ error } = await sb.auth.updateUser({ password }));
    if (!error) { msg.className = 'msg ok'; msg.textContent = 'Contraseña actualizada.'; }
  }
  if (error) { msg.className = 'msg err'; msg.textContent = traducirError(error.message); }
});
function traducirError(m) {
  if (/invalid login/i.test(m)) return 'Correo o contraseña incorrectos.';
  if (/not confirmed/i.test(m)) return 'Primero confirma tu cuenta desde el correo que te enviamos.';
  if (/already registered/i.test(m)) return 'Ese correo ya tiene cuenta; usa "Entrar" o "Olvidé mi contraseña".';
  if (/rate limit/i.test(m)) return 'Demasiados intentos, espera unos minutos.';
  return m;
}
$('#btnSalir').onclick = () => sb.auth.signOut();

let sesionActiva = null;
async function alCambiarSesion(event, session) {
  if (event === 'PASSWORD_RECOVERY') { $('#login').hidden = false; setModo('nueva'); return; }
  token = session ? session.access_token : null;
  const email = session && session.user.email;
  if (!session) { sesionActiva = null; $('#login').hidden = false; setModo('entrar'); return; }
  if (modoLogin === 'nueva') {
    if (event !== 'USER_UPDATED') return;
    setModo('entrar');
  }
  $('#login').hidden = true;
  if (sesionActiva === email) return; // solo refresco de token
  sesionActiva = email;
  $('#usuarioEmail').textContent = email;
  const res = await api(`usuarios?select=puede_cargar&email=eq.${encodeURIComponent(email)}`);
  const [u] = await res.json();
  if (!u) {
    $('#cargaInfo').innerHTML = `<b>${esc(email)}</b> no está dado de alta. Pide acceso al administrador.`;
    $('#btnActualizar').hidden = true;
    return;
  }
  $('#btnActualizar').hidden = !u.puede_cargar;
  cargarTodo();
}
sb.auth.onAuthStateChange((event, session) => { setTimeout(() => alCambiarSesion(event, session), 0); });
