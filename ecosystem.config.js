// PM2: en el celu corre con Baileys; para la demo en PC cambiá ADAPTADOR.
module.exports = {
  apps: [{
    name: 'bot-turnos',
    script: 'src/index.js',
    env: { ADAPTADOR: 'baileys' }, // producción en el celu; en PC usá npm run demo/baileys
    max_memory_restart: '300M',        // celu de 2-3 GB: reiniciar si se infla
    restart_delay: 5000,
    out_file: 'logs/bot.out.log',
    error_file: 'logs/bot.err.log',
    time: true,
  }],
};
