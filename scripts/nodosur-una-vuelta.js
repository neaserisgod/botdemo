#!/usr/bin/env node
// Baja una vez la configuración y el catálogo de Nodo Sur, sin arrancar WhatsApp (lo usa el instalador después de vincular,
// para saber si el negocio ya configuró el bot desde la app). Sale con 0 si hay configuración de Nodo Sur, 2 si todavía no.
const configuracion = require('../src/config');
const cuenta = require('../src/nube/cuenta');
const { crearCliente } = require('../src/nube/cliente');
const { crearSincronizador } = require('../src/nube/sincronizar');

const c = cuenta.leer();
if (!c) { console.error('Este bot no está vinculado a Nodo Sur.'); process.exit(1); }
const config = configuracion.construir().config;
const sinc = crearSincronizador({
  config, cliente: crearCliente({ sitio: c.sitio, token: c.token }),
  recargarConfig: () => configuracion.recargar(config),
  enviar: async () => [],
  log: { log: () => {}, error: (m) => console.error(m) },
});

(async () => {
  try { await sinc.traerConfig(); } catch (e) {
    console.error(e.sinPlan ? 'El negocio no tiene un plan con bot en Nodo Sur.' : `No pude bajar la configuración: ${e.message}`);
  }
  try { if (config.forma === 'productos') await sinc.traerCatalogo(); } catch { /* se baja al arrancar */ }
  const nube = configuracion.configNube();
  if (nube) {
    console.log(`Configuración del negocio bajada de Nodo Sur (versión ${nube.version}).`);
    process.exit(0);
  }
  console.log('Todavía no hay configuración del bot en Nodo Sur.');
  process.exit(2);
})();
