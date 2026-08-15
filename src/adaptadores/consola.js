// Adaptador de consola: probás todo el flujo sin WhatsApp.
//   Escribís como clienta. Comandos especiales:
//     /soy <numero>        cambiar de "remitente" (ej: /soy 5492944000001 = dueña)
//     /foto <texto>        simula mandar una foto de comprobante cuyo OCR da <texto>
//     /producto <id>       simula tocar un ítem del catálogo
//     /salir
const readline = require('readline');
const fs = require('fs');
const os = require('os');
const path = require('path');

function crearAdaptador(config, hooks) {
  let remitente = '5492944111111'; // clienta de prueba

  function mostrar(salientes) {
    for (const s of salientes || []) {
      const quien = s.para === config.numero_duena ? 'DUEÑA'
        : s.para === config.numero_soporte ? 'SOPORTE' : s.para;
      const extra = s.imagenRuta ? ' [con imagen]'
        : s.adjunto ? ` [adjunto: ${s.adjunto.nombre}]` : '';
      const espera = s.demora ? ` (espera ${s.demora / 1000}s)` : '';
      console.log(`\n┌─ Bot → ${quien}${extra}${espera}\n${s.texto.split('\n').map((l) => '│ ' + l).join('\n')}\n└─`);
    }
    return salientes || []; // en consola siempre "se envía" todo
  }

  function iniciar() {
    hooks.alConectar();
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log(`\nModo consola. Sos ${remitente}. Comandos: /soy /foto /producto /salir\n`);
    rl.setPrompt(`${remitente}> `);
    rl.prompt();

    rl.on('line', (linea) => {
      const t = linea.trim();
      let msj = null;

      if (t === '/salir') { rl.close(); process.exit(0); }
      else if (t.startsWith('/soy ')) {
        remitente = t.slice(5).trim();
        console.log(`Ahora escribís como ${remitente}`);
      } else if (t.startsWith('/foto')) {
        // Creamos una imagen trucha y pasamos el texto como caption: ocr.js
        // usa el caption cuando no hay tesseract instalado.
        const ruta = path.join(os.tmpdir(), `comprobante_${Date.now()}.png`);
        fs.writeFileSync(ruta, 'fake');
        msj = { de: remitente, texto: t.slice(5).trim(), rutaImagen: ruta, productoId: null };
      } else if (t.startsWith('/producto ')) {
        msj = { de: remitente, texto: '', rutaImagen: null, productoId: t.slice(10).trim() };
      } else if (t) {
        msj = { de: remitente, texto: t, rutaImagen: null, productoId: null };
      }

      if (msj) mostrar(hooks.alRecibir(msj));
      rl.setPrompt(`${remitente}> `);
      rl.prompt();
    });
  }

  return { iniciar, enviar: (salientes) => mostrar(salientes) };
}

module.exports = { crearAdaptador };
