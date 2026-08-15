# Investigación de mercado — bot de turnos por WhatsApp

Relevamiento de agosto 2026: a quién venderle, contra quién competís, a qué precio y con qué argumentos. Las fuentes están al final.

---

## Lo que hay que saber antes de leer el resto

1. **Tu precio mensual está por encima de casi toda la competencia argentina.** Gendu arranca gratis y su plan pago desde $6.900/mes; ReservaSimple Premium está en ~$17.000/mes. Vos cobrás $35.000. No es necesariamente un problema, pero *no podés vender por precio*: tenés que vender por lo que ellos no hacen.
2. **Tu diferencial real no es el bot: es que la clienta no instala nada.** Toda la competencia manda a la clienta a una web o una app. Vos la atendés donde ya está.
3. **El argumento de venta más fuerte es el ausentismo.** El sector maneja 20-30% de no-shows sin recordatorios, y los recordatorios automáticos los bajan entre 30% y 50%. Ese número, traducido a pesos, paga tu servicio varias veces.
4. **El mercado no es solo belleza.** Kinesiología, veterinaria, tatuajes, nutrición, psicología y consultorios chicos tienen el mismo problema, menos competencia y mejor ticket.

---

## 1. El mercado en Bariloche

Bariloche tiene **135.755 habitantes** en el ejido municipal y **164.065** contando el departamento (Censo 2022), y es la ciudad más poblada de Río Negro con una tasa de crecimiento que se duplicó respecto de 2004.

**No hay un dato público de cuántos comercios de belleza hay habilitados.** Los directorios locales (Guía Bariloche, BarilocheWeb, InfoIsInfo) listan peluquerías y centros de estética pero sin totales confiables. Para dimensionarlo bien tenés dos caminos concretos:

- Pedir el padrón de habilitaciones comerciales por rubro en la Municipalidad (tienen gestión digital de habilitaciones).
- Contar a mano en Google Maps por rubro y barrio. Es una tarde de trabajo y te da además la lista de prospectos con teléfono.

Ese conteo vale la pena hacerlo antes de invertir en publicidad: define si tu mercado local son 80 negocios o 400, y eso cambia toda la estrategia.

**Un detalle de Bariloche que juega a favor:** es una ciudad turística con fuerte estacionalidad. En temporada alta los negocios se saturan de consultas y no dan abasto para contestar; en temporada baja necesitan no perder ni un turno. Los dos escenarios te sirven como argumento.

---

## 2. Los rubros: dónde hay plata

Los sistemas de turnos en Argentina se usan en medicina, nutrición, odontología, psicología, kinesiología, estética, peluquerías, barberías, masajes, spa, tatuajes y uñas. Además hay nichos que ya operan con turnos y casi nadie atiende: **veterinarias** (incluso fisioterapia veterinaria), entrenadores personales y estudios contables.

Cómo los ordenaría por prioridad para vos:

| Prioridad | Rubro | Por qué |
|---|---|---|
| **1** | Uñas, barberías, estética | Es tu caso de uso ya construido y probado. Ticket $15-30k, alta frecuencia, señas comunes. Mucha competencia de software pero poca penetración real |
| **2** | Tatuajes y piercing | **Las señas son norma del rubro**, no una excepción. Tu OCR de comprobantes vale oro acá. Ticket alto ($50k-300k), turnos largos, un no-show duele muchísimo |
| **3** | Kinesiología, nutrición, psicología | Turnos recurrentes (tratamientos de varias sesiones), ausentismo alto, profesionales que atienden solos y no pueden cortar la sesión para contestar |
| **4** | Veterinarias chicas | Poco atendido por el software de belleza, turnos programados, dueños que consultan mucho por WhatsApp |
| **5** | Masajes, spa, depilación | Similar a belleza pero ticket algo mayor |

**Mi recomendación:** cerrá tus primeros 3-5 clientes en belleza (donde ya tenés el producto afinado y el caso de uso demostrado), y en paralelo tocá **dos tatuadores**. Si el flujo de señas funciona ahí, tenés un nicho con menos competencia, mejor ticket y más dolor.

---

## 3. La competencia

### Lo que hay en el mercado argentino

| Producto | Precio | Modelo |
|---|---|---|
| **Gendu** | Gratis sin límite; pagos desde **$6.900/mes** | Web, precios fijos en pesos, sin comisiones |
| **ReservaSimple** | Gratis hasta 30 turnos; Premium **~$17.000/mes** | Web + WhatsApp automático |
| **Turnito** | Gratis, pero **5% de comisión** sobre cobros | Comisión que escala con tu facturación |
| **Fresha** | **20% sobre clientes nuevos** | Marketplace |
| **AgendaPro** | Desde **USD 30/mes** (~$30.000+) | Cobra en dólares |
| **Booksy** | Desde **USD 29,99/mes** | Cobra en dólares, sin integración con Mercado Pago |
| **Bots con IA** (Atendi, ConnectIA, Chatsell) | USD 50-130/mes en la versión con API | Chatbot con IA, requiere WhatsApp Business API |
| **Bot a medida** | **$800.000 ARS** un flujo básico; $1,2-2,5M uno de complejidad media | Desarrollo puntual |

### Dónde son débiles

- **Todos mandan a la clienta a una web o app.** Ese es el punto de fuga: el 63% de las reservas online se hacen desde el celular, y cada paso extra (abrir link, cargar datos, crear cuenta) pierde gente. Los clientes más jóvenes prefieren WhatsApp antes que email.
- **Los que cobran en dólares** (AgendaPro, Booksy) le suben el costo al negocio cada vez que se mueve el tipo de cambio. Booksy ni siquiera integra Mercado Pago.
- **Los de comisión** (Turnito 5%, Fresha 20%) castigan al que más factura: cuanto mejor le va al negocio, más paga.
- **Los bots con IA** necesitan la API oficial de WhatsApp Business, que **cobra por conversación** y requiere aprobación de Meta. Costo variable e impredecible.
- **Ninguno resuelve el hardware ni la instalación.** El comerciante tiene que configurar todo solo.

### Dónde sos más caro (y hay que asumirlo)

Contra Gendu ($6.900) sos **5 veces más caro** por mes. Contra ReservaSimple ($17.000), el doble. Si el prospecto compara solo el número mensual, perdés.

**Contra qué sí ganás en precio:** contra un bot a medida ($800.000 mínimo), sos 10 veces más barato en la entrada. Y contra AgendaPro/Booksy estás en el mismo orden de magnitud pero **en pesos, sin riesgo cambiario**.

---

## 4. Tu posicionamiento

Lo que tenés y ellos no:

1. **Cero fricción para la clienta.** No descarga app, no crea cuenta, no aprende nada: escribe por WhatsApp como escribiría a una persona. Es *el* diferencial y hay que ponerlo primero en todo el material.
2. **El equipo va incluido.** Nadie más en el mercado te da el celular. Elimina la objeción "no tengo dónde correrlo" y convierte tu precio en "todo incluido" en vez de "software".
3. **Señas con lectura automática de comprobantes.** La competencia que cobra señas lo hace con pasarela de pago (comisión, credenciales, alta). Vos leés la transferencia sin tocarle la cuenta a nadie.
4. **Soporte local y presencial.** En Bariloche, que alguien vaya al local es un valor real frente a un chat de soporte en otro país.
5. **Sin comisiones y sin dólar.** Precio fijo en pesos, no importa cuánto facture.
6. **Economía circular.** Diferencial de marca genuino y verificable — los reacondicionados se venden entre 20% y 50% por debajo de un equipo nuevo, así que el argumento ambiental además te mejora el margen.

**El pitch en una línea:** *"Tus clientas sacan turno por WhatsApp, como te escriben ahora. Sin apps, sin webs, sin que aprendas nada. Y el celular te lo llevo yo instalado."*

---

## 5. El argumento de venta que cierra: el ausentismo

Este es el número que hay que llevar a cada reunión.

**El dato:** sin sistema de recordatorios, un negocio con agenda tiene entre **20% y 30% de ausentismo**. Los recordatorios automáticos bajan los no-shows entre **30% y 50%**, y la seña previa aumenta fuerte la probabilidad de que la clienta aparezca. La combinación de recordatorio + seña es la fórmula más efectiva que reconoce el sector.

**Traducido a un salón chico de Bariloche** (supuestos conservadores, ajustalos con los datos reales del prospecto):

| | |
|---|---|
| Turnos por mes | 80 (unos 20 por semana) |
| Ticket promedio | $18.000 |
| Facturación potencial | $1.440.000 |
| Ausentismo del 20% | 16 turnos perdidos = **$288.000/mes** |
| Recuperando la mitad con recordatorios + seña | **+$144.000/mes** |
| Costo del bot | $35.000/mes |
| **Resultado** | **~4x lo que cuesta** |

La cuenta a decir en voz alta: **"con que evites dos turnos perdidos al mes, ya lo pagaste"**. A $18.000 el turno, dos son $36.000 — más que la cuota. Todo lo demás (no contestar mensajes a la noche, no perder consultas, tener la agenda ordenada) es ganancia.

**Hacé esta cuenta con los números del prospecto delante suyo.** Preguntale cuánto sale su servicio más pedido y cuántas le fallan por semana. La cuenta la termina haciendo él.

### El otro dato fuerte

WhatsApp tiene **98% de tasa de apertura** de mensajes, contra 21,5% del email marketing. En Argentina hay más de 42 millones de usuarios activos y el país lidera la adopción regional. Y el punto que más duele: **el 80% de las pymes no puede responder fuera del horario comercial y pierde entre 20% y 30% de las oportunidades de venta.**

Traducilo así: *"¿Cuántos mensajes te llegan después de que cerrás? ¿Cuántos de esos contestás al otro día y ya reservaron en otro lado?"*

---

## 6. Riesgos que conviene tener a la vista

| Riesgo | Qué tan grave | Mitigación |
|---|---|---|
| **Objeción de precio** vs. Gendu/ReservaSimple | Alta | No competir por precio. Vender ausentismo recuperado + equipo incluido + cero fricción |
| Uso de WhatsApp Web no oficial (Baileys) | Media-alta | Es el riesgo estructural del producto: Meta puede cambiar el protocolo o bloquear cuentas. El diseño desacoplado permite migrar, pero conviene no prometer SLA y tener el chip a nombre del negocio |
| Escalabilidad del soporte | Media | Cada cliente es un celular físico. Con 20 clientes ya necesitás Tailscale bien puesto y rutinas de mantenimiento (ya está resuelto técnicamente) |
| Competencia de bots con IA | Media | Ellos pagan API oficial por conversación; vos no. Pero pueden bajar precios |
| Recuperar el equipo si se dan de baja | Media | La permanencia mínima de 4 meses ayuda. Conviene contrato firmado con valor del equipo declarado |
| Estacionalidad de Bariloche | Baja | Vender antes de temporada alta, cuando el dolor de no dar abasto es más fresco |

---

## 7. Qué haría ahora, en orden

1. **Contar el mercado real.** Una tarde con Google Maps: peluquerías, uñas, barberías, estética, tatuajes, kinesiología y veterinarias de Bariloche, con nombre y teléfono. Sale la lista de prospectos y el tamaño del mercado de una sola vez.
2. **Armar la calculadora de ausentismo.** Una planilla de dos celdas (precio del servicio, turnos que fallan por semana) que muestre cuánto pierde por mes. Es tu mejor material de venta y no cuesta nada.
3. **Conseguir el primer caso testigo.** Un cliente a precio promocional a cambio de que puedas mostrar números reales al mes siguiente ("desde que lo puso, pasó de X ausencias a Y"). Sin caso testigo, el argumento del ausentismo es teoría.
4. **Probar dos tatuadores.** Es el nicho donde tu funcionalidad de señas es más valiosa y donde menos te compara con Gendu.
5. **Revisar la estructura de precios.** Ver la sección siguiente.

---

## 8. Sobre el precio: para pensarlo

No te voy a decir qué cobrar — es tu negocio y conocés tu costo y tu mercado mejor que yo. Pero tres observaciones del relevamiento:

**El alta de $70.000 tiene lógica** (cubre el equipo reacondicionado, el chip y tu tiempo de instalación) y no tiene competencia directa: nadie más entrega hardware. Ahí no te comparan.

**Los $35.000/mes son donde te van a comparar** con un Gendu de $6.900. La diferencia hay que justificarla con el equipo en comodato (que es costo tuyo real y recurrente si se rompe), el soporte presencial y el ausentismo recuperado. Si notás que la objeción de precio aparece siempre, dos alternativas antes de bajar el precio:

- **Escalonar por tamaño**: un plan más barato para el que atiende solo y factura poco, y el precio actual para el que tiene empleadas. Te amplía el mercado sin regalar el producto a quien puede pagarlo.
- **Bonificar los primeros meses** en vez de bajar el precio de lista. Bajar el precio es difícil de revertir; una promo de lanzamiento no.

**Empresas sin precio publicado está bien.** Es lo que hace toda la competencia seria en ese segmento y te deja cotizar según el caso.

---

## Fuentes

- [Gendu — Mejor software de turnos para peluquerías en Argentina 2026](https://www.gendu.com.ar/blog/informacion/kw/mejor-software-de-turnos-para-peluquerias-en-argentina-2026)
- [Gendu — Cómo reducir ausencias y cancelaciones de turnos](https://www.gendu.com.ar/blog/informacion/kw/como-reducir-ausencias-y-cancelaciones-de-turnos)
- [Turnito — Las mejores apps de turnos para peluqueros en Argentina 2026](https://turnito.app/blog/las-mejores-apps-de-turnos-para-peluqueros-en-argentina/)
- [ReservaSimple — App turnos peluquería Argentina](https://www.reservasimple.com/app-turnos-peluqueria-argentina)
- [Turno App — Alternativa a AgendaPro 2026: precio, funciones y comparativa](https://www.turnoapp.com.ar/blog/alternativa-a-agendapro)
- [AgendaPro Argentina](https://agendapro.com/ar)
- [Runia — Cómo reducir el ausentismo a los turnos: 7 estrategias](https://runia.ar/blog/como-reducir-ausentismo-turnos-2026)
- [GuauAgenda — Recordatorios de turno automáticos](https://www.guauagenda.com/blog/recordatorios-de-turno-automaticos-como-reducir-el-ausentismo-en-tu-peluqueria)
- [SODI — Cuánto cuesta un bot de WhatsApp para empresas 2026](https://www.sodi.com.ar/blog/cuanto-cuesta-bot-whatsapp-empresas)
- [Basework — Cómo elegir un chatbot de WhatsApp para tu PyME](https://www.basework.com.ar/blog/chatbot-whatsapp-argentina)
- [FastStrat — WhatsApp Business PYMES LATAM: guía 2026](https://faststrat.ai/whatsapp-business-pymes-latam-guia-2026/)
- [AuroraInbox — Estadísticas de WhatsApp Business 2026](https://www.aurorainbox.com/en/2026/03/01/whatsapp-business-2025-statistics/)
- [SimplyBook.me — Lo que los clientes quieren de la reserva online](https://simplybook.me/es/blog/what-clients-want-from-online-booking)
- [El Cordillerano — Bariloche pasó de 936 a 135.755 habitantes](https://www.elcordillerano.com.ar/noticias/2025/01/12/205280-en-105-anos-bariloche-paso-de-936-a-135755-habitantes)
- [Municipalidad de Bariloche — Población Censo 2022](https://www.bariloche.gov.ar/gobiernoabierto/poblacion/)
- [Municipalidad de Bariloche — Gestión digital de habilitaciones comerciales](https://www.bariloche.gov.ar/gestion-digital-habilitaciones/)
- [Aturna — Sistema de turnos online Argentina](https://www.aturna.com.ar/)
- [MDZ — Los cinco mejores celulares gama baja para comprar en 2026](https://www.mdzol.com/tecnologia/los-cinco-mejores-celulares-gama-baja-comprar-2026-n1464459)
