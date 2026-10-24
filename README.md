# Inventarios Kuroda

Aplicación web para consultar el inventario actual y las compras (febrero a la fecha), y ver **para quién se compró cada material**.

- Sitio estático (HTML + JS, sin compilación) publicado en Vercel.
- Datos en Supabase (proyecto `inventarios-kuroda`).

## Pestañas

- **Compras · ¿Para quién?** – cada renglón de OC con su destino (Venta / Cliente, Stock, Otro), texto de cabecera, nuestra referencia, referencia, solicitante y comprador. Clic en un renglón para ver todos los campos y la existencia actual.
- **Inventario actual** – inventario con el resumen de compras del material (renglones, cantidad comprada, pendiente por recibir, última compra y para quién). Clic para ver todas sus compras.
- **Historial de cargas** – bitácora de cada actualización.

Todas las tablas tienen filtros superiores, filtro por columna (texto, o `>`, `<`, `=` en columnas numéricas), orden por columna y exportación a CSV.

## Actualizar la información

Botón **Actualizar base de datos** → elegir el Excel (hojas "Inventario" y/o "Reporte de compras", se detectan por encabezados) → escribir la clave de carga → **Subir información**.

- **Compras**: se agregan o actualizan por *Orden de Compra + Número de Renglón*; nunca se duplican. Basta subir el reporte desde la fecha de la OC más reciente que muestra la app.
- **Inventario**: se reemplaza completo con la hoja subida (solo al terminar la carga sin errores).

## Base de datos (Supabase)

| Tabla | Contenido |
|---|---|
| `compras` | Reporte de compras (PK `orden_compra, numero_renglon`) |
| `inventario` | Inventario actual |
| `cargas` | Bitácora de cargas (fecha, archivo, conteos, OC más reciente) |
| `inventario_stage`, `config_privada` | Internas, sin acceso desde la API |

La llave publicable en `config.js` solo permite **leer**. Las funciones `iniciar_carga`, `cargar_lote` y `finalizar_carga` validan la clave de carga (guardada como hash bcrypt en `config_privada`).

Para cambiar la clave de carga (SQL Editor de Supabase):

```sql
update public.config_privada
set valor = extensions.crypt('NUEVA_CLAVE', extensions.gen_salt('bf'))
where llave = 'clave_carga';
```

## Clasificación del destino

Se deduce del *Texto de Cabecera* y *Nuestra Referencia* (función `clasificarDestino` en `app.js`):

- **Venta / Cliente**: menciona venta, VTA, cliente, obra, vendedor, POS n, pedido n, FACTURADO, ENVIARXRUTA, o motivo C11/C12.
- **Stock**: STOCK, ZREORDEN, menudeo o vacío.
- **Otro**: lo demás.
