// Lectura, validación y subida de los reportes de Excel a Supabase.
// Se usa en el navegador (window.Carga) y en Node para pruebas (module.exports).
(function (global) {
  'use strict';

  const TIPOS = {
    inventario: {
      nombre: 'Inventario',
      detectar: (h) => h.includes('Cantidad Propia') && h.includes('Codigo Material'),
      llave: ['Codigo Material'],
      lote: 2000,
      descripcion: 'Reemplaza el inventario completo.',
    },
    compras: {
      nombre: 'Reporte de compras',
      detectar: (h) => h.includes('Orden de Compra') && h.includes('Número de Renglón'),
      llave: ['Orden de Compra', 'Número de Renglón'],
      fecha: 'Fecha de la Orden',
      lote: 1000,
      descripcion: 'Agrega OC nuevas y actualiza solo los renglones que cambiaron (Orden de Compra + Renglón).',
    },
    ventas: {
      nombre: 'Ventas',
      detectar: (h) => h.includes('Folio de la Factura') && h.includes('Cantidad Facturada UMB'),
      llave: ['Folio de la Factura', 'Fecha de la Factura'],
      fecha: 'Fecha de la Factura',
      agruparPorFecha: true, // cada lote lleva días completos: el servidor compara día por día
      lote: 2000,
      descripcion: 'Por día: los días iguales a lo guardado se saltan, los que cambiaron se reemplazan y los nuevos se agregan.',
    },
  };
  const ORDEN = ['inventario', 'compras', 'ventas'];

  // Fecha de Excel (serial, dd/mm/aaaa o aaaa-mm-dd) a 'aaaa-mm-dd'; null si no se reconoce.
  function fechaISO(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number' && v > 20000 && v < 80000) {
      return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
    }
    const s = String(v).trim();
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/);
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    return null;
  }

  // Lee el libro y regresa las hojas reconocidas con sus filas válidas y avisos de validación.
  function analizarLibro(XLSX, wb) {
    const hojas = [];
    wb.SheetNames.forEach((name) => {
      const aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: null, raw: true, blankrows: false });
      if (!aoa.length) return;
      const columnas = aoa[0].map((h) => String(h ?? '').trim());
      const tipo = ORDEN.find((t) => TIPOS[t].detectar(columnas));
      if (!tipo) return;
      const def = TIPOS[tipo];
      const iLlave = def.llave.map((c) => columnas.indexOf(c));
      const iFecha = def.fecha ? columnas.indexOf(def.fecha) : -1;
      const filas = []; const avisos = []; const errores = [];
      let omitidas = 0; let fechasInvalidas = 0; let min = null; let max = null;
      const dias = new Set(); const vistas = new Set(); let duplicadas = 0;

      for (let i = 1; i < aoa.length; i++) {
        const r = new Array(columnas.length);
        for (let j = 0; j < columnas.length; j++) {
          const v = aoa[i][j];
          r[j] = typeof v === 'string' ? (v.trim() === '' ? null : v.trim()) : (v ?? null);
        }
        if (iLlave.some((j) => r[j] === null)) { omitidas++; continue; }
        if (iFecha >= 0) {
          const f = fechaISO(r[iFecha]);
          if (!f) { fechasInvalidas++; if (def.agruparPorFecha) continue; } else {
            if (!min || f < min) min = f;
            if (!max || f > max) max = f;
            dias.add(f);
            if (def.agruparPorFecha) r._dia = f;
          }
        }
        if (tipo === 'compras') {
          const k = `${r[iLlave[0]]}|${r[iLlave[1]]}`;
          if (vistas.has(k)) duplicadas++; else vistas.add(k);
        }
        filas.push(r);
      }

      if (omitidas) avisos.push(`${omitidas} fila(s) sin ${def.llave.join(' / ')} se omiten (por ejemplo, la fila de totales).`);
      if (fechasInvalidas) {
        (def.agruparPorFecha ? errores : avisos).push(`${fechasInvalidas} fila(s) con "${def.fecha}" no reconocida${def.agruparPorFecha ? ' se omiten' : ''}.`);
      }
      if (duplicadas) avisos.push(`${duplicadas} renglón(es) de OC repetidos en el archivo; se toma uno de cada uno.`);
      if (!filas.length) errores.push('La hoja no tiene filas válidas.');
      hojas.push({ name, tipo, columnas, filas, omitidas: omitidas + (def.agruparPorFecha ? fechasInvalidas : 0),
        desde: min, hasta: max, dias: dias.size, avisos, errores });
    });
    return hojas;
  }

  // Divide una hoja en lotes; para ventas, sin partir ningún día entre dos lotes.
  function lotes(h) {
    const def = TIPOS[h.tipo];
    const out = [];
    if (!def.agruparPorFecha) {
      for (let i = 0; i < h.filas.length; i += def.lote) out.push(h.filas.slice(i, i + def.lote));
      return out;
    }
    const porDia = new Map();
    h.filas.forEach((r) => { const l = porDia.get(r._dia) || []; l.push(r); porDia.set(r._dia, l); });
    let actual = [];
    [...porDia.keys()].sort().forEach((d) => {
      const filasDia = porDia.get(d);
      if (actual.length && actual.length + filasDia.length > def.lote) { out.push(actual); actual = []; }
      actual = actual.concat(filasDia);
    });
    if (actual.length) out.push(actual);
    return out;
  }

  const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
  const NO_REINTENTAR = /permiso|no está en proceso|Tipo desconocido|Ya hay una carga/i;

  async function conReintentos(fn, intentos = 3) {
    for (let i = 1; ; i++) {
      try { return await fn(); } catch (e) {
        if (i >= intentos || NO_REINTENTAR.test(e.message)) throw e;
        await esperar(1500 * i);
      }
    }
  }

  // Sube las hojas elegidas. rpc(nombre, cuerpo) => Promise<json>. Los lotes son idempotentes, así que reintentar es seguro.
  async function subir({ rpc, archivo, hojas, clave, concurrencia = 3, alAvanzar = () => {} }) {
    const extra = clave ? { p_clave: clave } : {};
    const elegidas = hojas.slice().sort((a, b) => ORDEN.indexOf(a.tipo) - ORDEN.indexOf(b.tipo));
    const total = elegidas.reduce((a, h) => a + h.filas.length, 0);
    const resumen = { compras: 0, compras_nuevas: 0, compras_actualizadas: 0, compras_sin_cambio: 0, inventario: 0,
      ventas: 0, ventas_dias_nuevos: 0, ventas_dias_reemplazados: 0, ventas_dias_sin_cambio: 0,
      omitidas: elegidas.reduce((a, h) => a + h.omitidas, 0) };
    const inicio = Date.now();
    let hechas = 0;

    const id = await rpc('iniciar_carga', { p_archivo: archivo, ...extra });
    try {
      for (const h of elegidas) {
        const ls = lotes(h);
        let siguiente = 0;
        const trabajador = async () => {
          while (siguiente < ls.length) {
            const n = siguiente++;
            const filas = ls[n]; // JSON.stringify ignora la propiedad _dia de los arreglos
            const res = await conReintentos(() => rpc('cargar_lote', {
              p_carga_id: id, p_tipo: h.tipo, p_columnas: h.columnas, p_filas: filas, p_lote: n, ...extra,
            }));
            if (h.tipo === 'compras') {
              resumen.compras += res.procesados; resumen.compras_nuevas += res.nuevas;
              resumen.compras_actualizadas += res.actualizadas; resumen.compras_sin_cambio += res.sin_cambio;
            } else if (h.tipo === 'ventas') {
              resumen.ventas += res.procesados; resumen.ventas_dias_nuevos += res.dias_nuevos;
              resumen.ventas_dias_reemplazados += res.dias_reemplazados; resumen.ventas_dias_sin_cambio += res.dias_sin_cambio;
            } else {
              resumen.inventario += res.insertados;
            }
            resumen.omitidas += res.omitidas || 0;
            hechas += filas.length;
            const seg = (Date.now() - inicio) / 1000;
            const velocidad = hechas / Math.max(seg, 0.001);
            alAvanzar({ hoja: h.name, hechas, total, velocidad, restanteSeg: (total - hechas) / velocidad });
          }
        };
        await Promise.all(Array.from({ length: Math.min(concurrencia, ls.length) }, trabajador));
      }
      const carga = await conReintentos(() => rpc('finalizar_carga', { p_carga_id: id, p_resumen: resumen, ...extra }));
      return { carga, resumen, segundos: (Date.now() - inicio) / 1000 };
    } catch (e) {
      try { await rpc('cancelar_carga', { p_carga_id: id, p_error: e.message, ...extra }); } catch (_) { /* se marca fallida en 15 min */ }
      throw e;
    }
  }

  const api = { TIPOS, ORDEN, fechaISO, analizarLibro, lotes, subir };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else global.Carga = api;
}(typeof window !== 'undefined' ? window : globalThis));
