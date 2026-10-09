# Pendientes del bot (2026-10-09)

Para retomar en otra sesión. Lo hecho está en `main` (PR #4, #5 y #6): diccionario por rubro, pesables, simulador
(`bash bot.sh probar`), el pedido entero en el primer mensaje y "el cliente difícil". `npm test` pasa en hora de
Argentina; en UTC falla `test/simulacion.js` 12 ("servicio + día + hora"), también en `main`: depende de la hora del día.

**Regla del producto (el dueño):** el cliente escribe mal, apurado, enojado, todo junto y manda audios. El bot tiene que
entenderlo igual y, si no puede, pasarlo a una persona. Cada caso nuevo va a `test/frases.js`.

## 1. Un salón con turnos no puede volverse comercio por Nodo Sur (cambio chico en este repo)

La app de Nodo Sur solo conoce rubros de comercio (`kiosco`, `almacen`, `fiambreria`, `otro`, en
`Nodo-Sur-Pos/lib/domain/plantillas_rubro.dart`). Si una peluquería o un salón de uñas vinculado a Nodo Sur guarda la
configuración del bot desde la app (*Más › Bot de WhatsApp*), llega `negocio.rubro` de comercio. Como la capa de Nodo
Sur pisa a `config.json` (ver `src/config.js`, `construir`), **el bot deja de dar turnos y pasa a tomar pedidos.**

Hacer: en `src/config.js` (`construir` o `aplicarPlantilla`), si `config.json` es de un rubro de turnos (`unas`,
`barberia`) y Nodo Sur manda uno de comercio, quedarse con el rubro de `config.json` y avisarlo en el log. Test en
`test/nube.js` (sección 2, configuración desde la app).

A futuro, lo de fondo: sumar los rubros con turnos a `PlantillaRubro` en la app (Nodo-Sur-Pos).

## 2. Corrector contra el vocabulario del negocio + conjugaciones de acá (este repo)

Se probó un diccionario general (Hunspell es + Snowball) y **empeora**: corrige "kapping" → camping, "pucho" → pecho,
"finde" → funde; no conoce el voseo ("tenés", "cancelame"); "turnos" → "tur". No usarlo.

Hacer en `src/core/diccionario/`:
- **Corrector cerrado:** comparar solo contra lo que existe en ese negocio (palabras de `comun.js`, `rubros.js`, nombres
  de servicios y del catálogo), con distancia 2 en palabras largas. Ej.: "kerso cremoso" → Queso cremoso (hoy no).
- **Conjugaciones rioplatenses a mano:** quitar enclíticos y voseo para llegar a la palabra del diccionario:
  "cancelame / cancelalo / cancelás" → cancelar, "reservame / agendámelo" → reservar, "tenés / tienen / tendrán" → tener.

Ya existe: comparación por sonido (`normalizar.js` `sonido`), letras dadas vuelta y palabras pegadas (`nlu.contiene`).
Cuidado con los falsos positivos: probar que "cansado de esperar" no sea cancelar y que lo que no está en el catálogo
siga dando "no encontré".

## 3. Pedidos en gramos en Nodo Sur (otros dos repos: NodoSurPage y Nodo-Sur-Pos)

El bot ya manda lo pesable como `{ gid, nombre, gramos, precioCentavos }` (precio por kilo, `src/nube/sincronizar.js`).
El sitio de hoy lo rechaza: solo acepta `cantidad` entera, que para un pesable la app toma como KILOS. Mientras tanto el
bot manda los kilos enteros como cantidad y un pedido con gramos sueltos (250 g) le llega al local por WhatsApp
(estado `a_mano`). Para que entre a Encargues:

- **Sitio** (`NodoSurPage/functions/_lib/bot.js`, `pedidoDesdeBot`): aceptar `gramos` (entero 1–50000) en un ítem, en
  vez de `cantidad`, y guardarlo.
- **App** (`Nodo-Sur-Pos/lib/domain/bot_whatsapp.dart`): `ItemPedidoBot` con `gramos` opcional, y en
  `apartadosDePedido` usar esos gramos para un pesable en vez de `cantidad * 1000`. La app todavía no tiene release
  publicado: buen momento para cambiar el contrato.

Cuando el sitio acepte gramos, el bot los usa solo (se vuelve a probar con gramos cada vez que arranca).
