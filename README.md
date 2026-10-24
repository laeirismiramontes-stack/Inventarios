# Inventarios Kuroda

Aplicación web para consultar el inventario actual, las compras (febrero a la fecha) y las ventas, y ver **para quién se compró cada material**.

- Sitio estático (HTML + JS, sin compilación) publicado en Vercel.
- Datos en Supabase (proyecto `inventarios-kuroda`), con login por correo y RLS.

## Pestañas

- **Inventario actual** – cada material con el comentario de su **última** orden de compra: si fue para stock o para una venta (vendedor, cliente y factura cuando aparece en las ventas cargadas), la OC, su fecha y lo vendido desde esa compra.
- **Compras · ¿Para quién?** – cada renglón de OC con su destino (Venta / Cliente, Stock, Otro), vendedor citado en la OC, texto de cabecera y ticket/pedido.
- **Ventas** – reporte de facturación (cliente, vendedor, folio).
- **Historial de cargas** – bitácora de cada actualización.

Filtros en todo: filtros superiores (incluye **Mes**: Enero, Febrero, …), filtro por columna (texto, o `>`, `<`, `=` en columnas numéricas), orden por columna y exportación a CSV.

## Acceso

Login con correo y contraseña (Supabase Auth). Solo ven datos los correos dados de alta en `public.usuarios`; `puede_cargar = true` habilita el botón **Actualizar base de datos**.

```sql
insert into public.usuarios (email, nombre, puede_cargar) values ('correo@kuroda.com.mx', 'Nombre', false);
```

## Actualizar la información

Botón **Actualizar base de datos** → elegir el Excel (las hojas se detectan por encabezados) → **Subir información**.

- **Compras**: se agregan o actualizan por *Orden de Compra + Número de Renglón*; nunca se duplican.
- **Inventario**: se reemplaza completo (solo al terminar la carga sin errores).
- **Ventas**: se reemplazan los días que trae el archivo.

## Base de datos (Supabase)

| Objeto | Contenido |
|---|---|
| `compras`, `inventario`, `ventas` | Datos de los reportes |
| `cargas` | Bitácora de cargas |
| `usuarios` | Correos con acceso |
| `vendedores_alias` | Cómo se escribe cada vendedor en el texto de la OC (`angel` → ANGEL FDO. DE LA PAZ) |
| `compras_destino` (vista) | Compras + destino por renglón + vendedor citado |
| `material_comentario` (vista) | Comentario por material basado en su última OC y las ventas posteriores |

### Destino de cada renglón (`f_destino`)

- **Venta / Cliente**: el texto de cabecera menciona venta, VTA, cliente, obra, ticket, factura, pedido n o un ticket 5xxxxxxxx (o motivo C11/C12). Si el texto cita posiciones (`POS.1 A 3 … RESTO STOCK`), solo esos renglones son venta y el resto es stock.
- **Stock**: STOCK, ZREORDEN, menudeo, protección o vacío.
- **Otro**: lo demás.
