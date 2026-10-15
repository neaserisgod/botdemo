# Prospectar — buscar posibles clientes

Arma una planilla de negocios (uñas, barberías, peluquerías, estéticas) de una ciudad, ordenada por prioridad, para
**escribirles a mano** con las reglas de `NodoSurPage/marketing/mensajes-directos.md`. No entra a Instagram ni manda
mensajes: eso pone en riesgo `@nodosur.brc`.

Corre en la PC, no en el celular del bot (es Python y no es parte del bot).

## Cómo lo hace

1. **Google Places API** (la oficial de Google): busca "uñas en Cipolletti", "barbería en Cipolletti", etc. Trae
   nombre, teléfono, web, reseñas y si sigue abierto.
2. **[Scrapling](https://github.com/D4Vinci/Scrapling)**: entra a la web de cada uno (y a su Linktree, si tiene) y
   saca su Instagram, su WhatsApp, si dice "turnos por WhatsApp/DM", si pide seña, si es home studio y si ya usa otra
   app de turnos (Booksy, AgendaPro, Fresha, etc.). Si la "web" que tiene en Google es su Instagram, toma la cuenta
   sin entrar.
3. **Prioridad**, con las señales de `docs/PROSPECTOS.md`:
   - suma: turnos por WhatsApp/DM (+3), pide seña (+2), solo con turno, home studio, tiene WhatsApp, tiene Instagram y
     pocas reseñas, o sea que es chico (+1 cada una);
   - resta: más de 500 reseñas, porque suele ser una cadena (−1);
   - **baja** si ya usa otra app de turnos y **descartar** si está cerrado.
   - Queda **alta** con 4 puntos o más y **media** con 2 o 3.
4. Saltea las cuentas que ya están en `docs/PROSPECTOS.md` y los repetidos.

## Instalar (una vez)

```bash
cd prospectar
pip install -r requirements.txt
```

**Clave de Google** (gratis dentro del cupo mensual; Google pide una tarjeta igual):

1. console.cloud.google.com → proyecto nuevo → activar **Places API (New)**.
2. Credenciales → Crear clave de API → restringirla a "Places API (New)".
3. Facturación → poner un **presupuesto con alerta** (por ejemplo USD 1) para que nunca cobre sin avisar.

Teléfono, web y reseñas son campos del nivel *Enterprise*, que tiene el cupo gratis más chico. Cada página de 20
resultados es un pedido. Una ciudad con todos los rubros son 7 pedidos (21 con `--paginas 3`), muy por debajo del cupo.
Revisar el cupo vigente en la consola antes de correrlo en muchas ciudades.

## Usar

```bash
export GOOGLE_PLACES_KEY=...
python3 prospectar.py --ciudad Cipolletti --ciudad "General Roca" --rubro unas --rubro estetica
python3 prospectar.py --ciudad Neuquén --paginas 3 --salida neuquen.csv   # todos los rubros, hasta 60 por búsqueda
```

Sin clave, analiza una lista de webs o Linktrees (una por línea) que hayas juntado a mano:

```bash
python3 prospectar.py --urls webs.txt
```

Sale `prospectos.csv` (separado por `;`, se abre bien en Excel y en Google Sheets) con: Prioridad, Cuenta, Nombre,
Rubro, Ciudad, Señales, WhatsApp, Teléfono, Web, Reseñas, Dirección y Maps. Las columnas de seguimiento (Msj 1,
Respondió, Probó, Pagó) se agregan a mano, como en la planilla diaria de `mensajes-directos.md`.

**Antes de escribirle a alguien, abrí su cuenta**: la planilla da la prioridad y el mensaje lo personalizás vos. Los
negocios sin web solo tienen las señales de Google. Esos van a "media" o "baja" aunque sean buenos prospectos: hay
que mirarlos a mano.

## Pruebas

```bash
python3 -m unittest test_prospectar      # sin red: Google y las webs están simulados
```
