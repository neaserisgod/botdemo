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

## 3. Pedidos en gramos en Nodo Sur (otros dos repos: NodoSurPage y Nodo-Sur-Pos)

El bot ya manda lo pesable como `{ gid, nombre, gramos, precioCentavos }` (precio por kilo, `src/nube/sincronizar.js`).
El sitio de hoy lo rechaza: solo acepta `cantidad` entera, que para un pesable la app toma como KILOS. Mientras tanto el
bot manda los kilos enteros como cantidad y un pedido con gramos sueltos (250 g) le llega al local por WhatsApp
(estado `a_mano`). Para que entre a Encargues:

- **Sitio** (`NodoSurPage/functions/_lib/bot.js`, `pedidoDesdeBot`): aceptar `gramos` (entero 1–50000) en un ítem, en
  vez de `cantidad`, y guardarlo.
- **App** (`Nodo-Sur-Pos/lib/domain/bot_whatsapp.dart`): `ItemPedidoBot` con `gramos` opcional, y en
  `apartadosDePedido` usar esos gramos para un pesable en vez de `cantidad * 1000`.
- **Ojo (2026-10-10): la app ya tiene release publicado** (beta 1.0.0+2157). Una app vieja que reciba un ítem sin
  `cantidad` lo va a leer mal: el sitio no puede mandarle gramos a una app que no los entiende (por ejemplo, que la app
  diga su versión al pedir los pedidos, o que el sitio guarde los gramos aparte y siga mandando `cantidad` a las viejas).
  Planearlo antes de tocar.

Cuando el sitio acepte gramos, el bot los usa solo (se vuelve a probar con gramos cada vez que arranca).

## 4. Visto al pasar (2026-10-10), sin tocar

- `catalogo.buscar`: "jabon" encuentra Jamón cocido y "pala" encuentra Paladini (una letra de diferencia y prefijo). Ya
  pasaba antes del corrector. Si molesta en un chat real, que el prefijo pida 4+ letras y la letra de diferencia no
  valga cuando cambia la consonante del medio.
- `src/index.js` (lock y limpieza de archivos viejos) usa `data/` fijo en vez de `DIR_DATOS`.
