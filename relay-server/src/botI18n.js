/**
 * botI18n — Translation strings for Telegram bot messages.
 *
 * Structure: BOT_STRINGS[locale][key] = string
 * Supported locales: en (default), es (Spanish)
 *
 * Usage:
 *   const { bt } = require('./botI18n');
 *   bt('welcome', 'es', { brandName: 'Tally' })
 */

const BOT_STRINGS = {
  en: {
    // Registration / onboarding
    'welcome':
      '👋 Welcome to *{{brandName}}*!{{poweredBy}}\n\nIf you\'re a church Technical Director, register with:\n`/register YOUR_CODE`\n\nYour church admin will give you the code.',
    'welcome.registered':
      '✅ Welcome to *{{brandName}}*{{poweredBy}}, *{{name}}*!\n\nYou\'re now registered as TD for *{{church}}*.\nType `help` to see what you can do.',
    'register.invalid_code':
      '❌ Invalid registration code. Check with your church administrator.',
    'register.not_found':
      '❌ Church not found for this registration code.',
    'register.guest.success':
      '✅ Welcome, *{{name}}*!\n\nYou have *guest access* for *{{church}}*.\n\n{{message}}\n\nType `help` to see available commands.',

    // Authentication
    'auth.not_registered':
      "You're not registered with Tally. Contact your church administrator for a registration code, then use `/register YOUR_CODE`.",

    // Status
    'status.header': '📊 *{{church}} — System Status*',
    'status.connected': '✅ Connected',
    'status.disconnected': '❌ Disconnected',
    'status.stream.live': '🔴 Live',
    'status.stream.offline': '⚫ Offline',
    'status.recording.active': '⏺ Recording',
    'status.recording.idle': '⏹ Idle',
    'status.no_devices': 'No devices connected.',

    // Alerts
    'alert.critical': '🚨 *CRITICAL ALERT* — {{church}}\n\n{{message}}',
    'alert.warning': '⚠️ *Warning* — {{church}}\n\n{{message}}',
    'alert.info': 'ℹ️ {{church}}: {{message}}',
    'alert.auto_recovered': '✅ *Auto-recovered* — {{church}}\n\n{{message}}',
    'alert.escalated': '🔺 *Escalated to primary TD* — {{church}}\n\nNo response after 90 seconds.',

    // Autopilot
    'autopilot.paused':
      '⏸ *Autopilot paused for {{church}}*\n\n50 rules fired this session — autopilot paused to prevent runaway automation.\n\nResume from the portal or type `/autopilot resume`.',

    // Pre-service
    'preservice.pass':
      '✅ *Pre-Service Check — All Clear*\n\n{{church}} · {{time}}\n\nAll {{count}} systems are ready. You\'re good to go! 🎯',
    'preservice.fail':
      '⚠️ *Pre-Service Check — {{issues}} Issue{{plural}}*\n\n{{church}} · {{time}}\n\n{{details}}\n\nType `/fix preservice` for troubleshooting steps.',

    // Macros
    'macro.running': '▶️ Running macro *{{name}}*…',
    'macro.done': '✅ Macro *{{name}}* completed.',
    'macro.not_found': '❌ Macro "{{name}}" not found. Type `/macros` to see available shortcuts.',
    'macro.list.header': '⚡ *Your macros:*\n',
    'macro.list.empty': 'No macros configured. Create shortcuts in your church portal.',

    // General
    'error.generic': '❌ Something went wrong. Please try again.',
    'error.no_church': '❌ No church data found. Contact your administrator.',
    'error.permission': '❌ You don\'t have permission to do that.',
    'cmd.unknown':
      '❓ I didn\'t understand that command.\n\nType `/help` to see what\'s available, or describe what you need in plain English.',
  },

  es: {
    // Registration / onboarding
    'welcome':
      '👋 ¡Bienvenido a *{{brandName}}*!{{poweredBy}}\n\nSi eres Director Técnico de una iglesia, regístrate con:\n`/register TU_CÓDIGO`\n\nTu administrador de iglesia te dará el código.',
    'welcome.registered':
      '✅ ¡Bienvenido a *{{brandName}}*{{poweredBy}}, *{{name}}*!\n\nYa estás registrado como DT para *{{church}}*.\nEscribe `help` para ver qué puedes hacer.',
    'register.invalid_code':
      '❌ Código de registro inválido. Consulta con tu administrador de iglesia.',
    'register.not_found':
      '❌ No se encontró la iglesia para este código de registro.',
    'register.guest.success':
      '✅ ¡Bienvenido, *{{name}}*!\n\nTienes *acceso de invitado* para *{{church}}*.\n\n{{message}}\n\nEscribe `help` para ver los comandos disponibles.',

    // Authentication
    'auth.not_registered':
      'No estás registrado en Tally. Contacta a tu administrador de iglesia para obtener un código de registro, luego usa `/register TU_CÓDIGO`.',

    // Status
    'status.header': '📊 *{{church}} — Estado del Sistema*',
    'status.connected': '✅ Conectado',
    'status.disconnected': '❌ Desconectado',
    'status.stream.live': '🔴 En Vivo',
    'status.stream.offline': '⚫ Sin transmisión',
    'status.recording.active': '⏺ Grabando',
    'status.recording.idle': '⏹ Inactivo',
    'status.no_devices': 'No hay dispositivos conectados.',

    // Alerts
    'alert.critical': '🚨 *ALERTA CRÍTICA* — {{church}}\n\n{{message}}',
    'alert.warning': '⚠️ *Advertencia* — {{church}}\n\n{{message}}',
    'alert.info': 'ℹ️ {{church}}: {{message}}',
    'alert.auto_recovered': '✅ *Recuperado automáticamente* — {{church}}\n\n{{message}}',
    'alert.escalated': '🔺 *Escalado al DT principal* — {{church}}\n\nSin respuesta después de 90 segundos.',

    // Autopilot
    'autopilot.paused':
      '⏸ *Piloto automático pausado para {{church}}*\n\n50 reglas se ejecutaron en esta sesión — el piloto automático se pausó para prevenir automatizaciones descontroladas.\n\nReanuda desde el portal o escribe `/autopilot resume`.',

    // Pre-service
    'preservice.pass':
      '✅ *Verificación Pre-Servicio — Todo en Orden*\n\n{{church}} · {{time}}\n\nLos {{count}} sistemas están listos. ¡Estás listo para comenzar! 🎯',
    'preservice.fail':
      '⚠️ *Verificación Pre-Servicio — {{issues}} Problema{{plural}}*\n\n{{church}} · {{time}}\n\n{{details}}\n\nEscribe `/fix preservice` para pasos de solución.',

    // Macros
    'macro.running': '▶️ Ejecutando macro *{{name}}*…',
    'macro.done': '✅ Macro *{{name}}* completado.',
    'macro.not_found': '❌ Macro "{{name}}" no encontrado. Escribe `/macros` para ver los atajos disponibles.',
    'macro.list.header': '⚡ *Tus macros:*\n',
    'macro.list.empty': 'No hay macros configurados. Crea atajos en tu portal de iglesia.',

    // General
    'error.generic': '❌ Algo salió mal. Por favor intenta de nuevo.',
    'error.no_church': '❌ No se encontraron datos de la iglesia. Contacta a tu administrador.',
    'error.permission': '❌ No tienes permiso para hacer eso.',
    'cmd.unknown':
      '❓ No entendí ese comando.\n\nEscribe `/help` para ver qué está disponible, o describe lo que necesitas en español.',
  },
};

/**
 * Get a translated bot string with variable interpolation.
 * @param {string} key
 * @param {'en'|'es'} locale
 * @param {Record<string, string>} [vars] — replacements for {{varName}} placeholders
 * @returns {string}
 */
function bt(key, locale = 'en', vars = {}) {
  const str =
    (BOT_STRINGS[locale] && BOT_STRINGS[locale][key]) ||
    (BOT_STRINGS.en && BOT_STRINGS.en[key]) ||
    key;

  return str.replace(/\{\{(\w+)\}\}/g, (_, k) =>
    vars[k] !== undefined ? String(vars[k]) : `{{${k}}}`
  );
}

/**
 * Detect locale from a church row. Falls back to 'en'.
 * @param {object|null} church - DB row with optional `locale` column
 * @returns {'en'|'es'}
 */
function churchLocale(church) {
  if (!church) return 'en';
  const loc = church.locale || 'en';
  return BOT_STRINGS[loc] ? loc : 'en';
}

module.exports = { bt, churchLocale, BOT_STRINGS };
