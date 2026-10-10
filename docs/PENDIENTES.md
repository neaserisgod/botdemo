# Pendientes del bot (2026-10-10)

Para retomar en otra sesión. Lo hecho está en `main` (PR #4 a #7) y en la rama `claude/nice-hypatia-w94whl`. `npm test`
pasa en cualquier día y zona horaria (el caso de "mañana" fallaba los sábados: el domingo está cerrado).

**Regla del producto (el dueño):** el cliente escribe mal, apurado, enojado, todo junto y manda audios. El bot tiene que
entenderlo igual y, si no puede, pasarlo a una persona. Cada caso nuevo va a `test/frases.js`.

## 1. Un salón con turnos no puede volverse comercio por Nodo Sur — hecho (2026-10-09)

`rubroEntreCapas` (`src/config.js`). Tests en `test/nube.js` (sección 2).

## 2. Corrector contra el vocabulario del negocio + conjugaciones de acá — hecho (2026-10-10)

- `src/core/diccionario/verbos.js`: "anulámelo", "posponelo", "suspendémelo", "confirmamelo", "agendámelo" (pronombre
  pegado), voseo y los irregulares ("tienen", "tendrán", "consiguen"). Se usa en `nlu.contiene` contra las claves que son
  verbos y en `catalogo.palabrasClave` para sacar los verbos de pedir ("¿consiguen fernet?", "¿traerán yerba?").
- `src/core/diccionario/corrector.js`: solo cuando no se encontró nada, contra las palabras de ese catálogo o esos
  servicios. "desorante" → desodorante, "lece" → leche, "semipermante" → semipermanente.
- "kerso cremoso" ya andaba antes (por sonido + una letra); el pendiente estaba desactualizado.
- Cuidados probados en `test/frases.js`: "cansado de esperar" no es cancelar, "hay pañales?" sigue en "no encontré",
  "dame"/"onda" no se corrigen a servicios (por eso en servicios corrige desde 7 letras).
- Lo que todavía no: "jelmans" → Hellmann's (empieza distinto, y la "ll" suena como "y").

## 3. Pedidos en gramos en Nodo Sur — hecho (2026-10-10), falta publicar

Los tres repos, rama `claude/nice-hypatia-w94whl`:

- **Sitio** (`NodoSurPage`, `pedidoDesdeBot`): acepta `gramos` (1 a 50000, precio por kilo) en vez de `cantidad`. Solo si
  todas las apps de la sucursal que leyeron pedidos en 30 días avisaron que los entienden (`?gramos=1`, tabla
  `bot_lectores`) y al menos una lo hizo. Si no, 400 `gramos_no_soportado`.
- **App** (`Nodo-Sur-Pos`, `bot_whatsapp.dart`): `ItemPedidoBot.gramos`, `apartadosDePedido` aparta esos gramos, el total
  orientativo por `subtotalPesable` y la pantalla dice "250 g de Jamón cocido". Pide los pedidos con `?gramos=1`.
- **Bot**: si el sitio rechaza los gramos, sigue como antes (kilos enteros como cantidad, o el pedido entero por WhatsApp,
  estado `a_mano`) y vuelve a probar a la hora, sin reiniciar.

Orden para publicar: el sitio y el bot se pueden publicar ya (sin apps nuevas, todo sigue por WhatsApp). Los gramos
empiezan a entrar a Encargues en cada sucursal apenas sus apps leen los pedidos con la versión nueva.

## 4. Visto al pasar (2026-10-10), sin tocar

- `catalogo.buscar`: "jabon" encuentra Jamón cocido y "pala" encuentra Paladini (una letra de diferencia y prefijo). Ya
  pasaba antes del corrector. Si molesta en un chat real, que el prefijo pida 4+ letras y la letra de diferencia no
  valga cuando cambia la consonante del medio.
- `src/index.js` (lock y limpieza de archivos viejos) usa `data/` fijo en vez de `DIR_DATOS`.
