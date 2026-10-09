#!/usr/bin/env node
// Vincula este bot a Nodo Sur (lo corre `bash bot.sh vincular-nodosur` y el instalador). Abre el navegador del celular para
// entrar con la cuenta de Google del negocio; después la configuración, el catálogo y los pedidos andan solos.
const { vincular } = require('../src/nube/vincular');

vincular()
  .then((r) => {
    console.log(`✅ Vinculado a Nodo Sur como ${r.email}.`);
    console.log('   El bot baja la configuración del negocio al arrancar (o con: bash bot.sh reiniciar).');
    process.exit(0);
  })
  .catch((e) => {
    console.error(`❌ No se pudo vincular: ${e.message}`);
    process.exit(1);
  });
