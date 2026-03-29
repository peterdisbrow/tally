// CHURCH_ID is injected via data-church-id on <body> to avoid inline scripts (CSP)
const CHURCH_ID = document.body.dataset.churchId || '';
    let profileData = {};
    let notifData = {};
    let supportTriage = null;
    const SCHEDULE_DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const SCHEDULE_DAY_LABELS = {
      sunday: 'Sunday',
      monday: 'Monday',
      tuesday: 'Tuesday',
      wednesday: 'Wednesday',
      thursday: 'Thursday',
      friday: 'Friday',
      saturday: 'Saturday',
    };

    // ── Portal i18n ──────────────────────────────────────────────────────────────
    // Detect browser language and serve EN/ES translations for all user-visible text.
    // Mirrors the botI18n.js pattern used by the Telegram bot.
    const PORTAL_STRINGS = {
      en: {
        // Navigation
        'nav.overview': 'Overview',
        'nav.profile': 'Profile',
        'nav.rooms': 'Rooms',
        'nav.team': 'Team',
        'nav.alerts': 'Alerts',
        'nav.engineer': 'Tally Engineer',
        'nav.automation': 'Automation',
        'nav.analytics': 'Analytics',
        'nav.billing': 'Billing',
        'nav.support': 'Help & Support',
        // Common buttons
        'btn.save': 'Save Changes',
        'btn.cancel': 'Cancel',
        'btn.delete': 'Delete',
        'btn.enable': 'Enable',
        'btn.disable': 'Disable',
        'btn.add': 'Add',
        'btn.signout': 'Sign out',
        'btn.edit': 'Edit',
        'btn.close': 'Close',
        'btn.send': 'Send',
        'btn.clear': 'Clear',
        // Status words
        'status.loading': 'Loading\u2026',
        'status.connected': 'Connected',
        'status.disconnected': 'Disconnected',
        'status.enabled': 'Enabled',
        'status.disabled': 'Disabled',
        'status.active': 'Active',
        'status.paused': 'Paused',
        'status.online': 'Online',
        'status.offline': 'Offline',
        'status.live': 'Live',
        // Page titles
        'page.overview': 'Overview',
        'page.profile': 'Church Profile',
        'page.rooms': 'Rooms & Equipment',
        'page.team': 'Team',
        'page.schedule': 'Service Schedule',
        'page.alerts': 'Alerts',
        'page.billing': 'Billing & Subscription',
        'page.support': 'Help & Support',
        'page.analytics': 'Analytics',
        'page.engineer': 'Train Your Tally Engineer',
        'page.automation': 'Automation',
        'page.equipment': 'Equipment',
        'team.sub': 'Manage tech directors and guest access',
        'alerts.sub': 'Notification preferences and alert history',
        'automation.sub': 'Macros, rules, and automated workflows',
        'analytics.sub': 'Sessions, stream health, and performance data',
        'equipment.sub': 'Configure your production equipment',
        // Overview
        'overview.sub': 'Church monitoring portal',
        'overview.getting_started': 'Getting Started',
        'overview.setup_progress': 'Complete these steps to finish setup',
        'overview.dismiss': 'Dismiss',
        'overview.resume_setup': '\ud83d\udccb Resume Setup Guide',
        'overview.connection': 'Connection',
        'overview.sessions_30d': 'Sessions (30d)',
        'overview.stat_tds': 'Tech Directors',
        'overview.preservice.title': '\ud83d\udd27 Pre-Service Check',
        'overview.preservice.fix_all': 'Fix All Safe Issues',
        'overview.preservice.run_now': 'Run Check Now',
        'overview.quickinfo.rooms': 'Rooms',
        'overview.equip.title': 'Equipment Status',
        'overview.equip.refresh': '\u21bb Refresh',
        'overview.stream.title': 'Live Stream',
        'overview.stream.bitrate': 'Bitrate (kbps)',
        'overview.stream.fps': 'FPS',
        'overview.stream.health': 'Health',
        'overview.stream.uptime': 'Uptime',
        'overview.atem.title': '\ud83c\udfa7 ATEM Switcher',
        'overview.atem.program': 'Program',
        'overview.atem.preview': 'Preview',
        'overview.audio.title': '\ud83d\udd0a Audio Health',
        'overview.audio.mute': 'Mute',
        'overview.audio.silence': 'Silence',
        'overview.audio.monitoring': 'Monitoring',
        'overview.rundown.title': '\ud83d\udccb Service Rundown',
        'overview.activity.title': '\u26a1 Activity Feed',
        'overview.engineer.title': 'Tally Engineer',
        'overview.schedule.title': 'Service Schedule',
        'overview.quickinfo.title': 'Quick Info',
        'overview.quickinfo.church_id': 'Church ID',
        'overview.quickinfo.registered': 'Registered',
        'overview.quickinfo.plan': 'Plan',
        'rooms.page_sub': 'Manage rooms, equipment configuration, and service schedule',
        'rooms.title': 'Rooms',
        'rooms.desc': 'Rooms are physical spaces (Main Sanctuary, Youth Room, etc). Assign each Tally desktop to a room from the app\'s Equipment tab.',
        // Shared table headers
        'table.status': 'Status',
        'table.devices': 'Devices',
        'table.health': 'Health',
        'table.last_seen': 'Last Seen',
        'table.system': 'System',
        'table.version': 'Version',
        'table.detail': 'Detail',
        'table.name': 'Name',
        'table.role': 'Role',
        'table.email': 'Email',
        'table.phone': 'Phone',
        'table.date': 'Date',
        'table.duration': 'Duration',
        'table.peak_viewers': 'Peak Viewers',
        'table.token': 'Token',
        'table.label': 'Label',
        'table.created': 'Created',
        'table.expires': 'Expires',
        'table.severity': 'Severity',
        'table.code': 'Registration Code',
        'table.action': 'Action',
        // AutoPilot
        'autopilot.subtitle': 'Automation rules that fire during your service windows',
        'autopilot.no_rules': 'No rules yet. Click \u201c+ New Rule\u201d to create your first automation.',
        'autopilot.paused_banner': '\u23f8 AutoPilot is paused \u2014 all rules are suspended.',
        'autopilot.upgrade_gate_title': 'AutoPilot requires Pro or higher',
        'autopilot.upgrade_gate_body': 'Set up automation rules that run during your service windows \u2014 auto-start recording, switch cameras on slide change, and more.',
        'autopilot.new_rule': '+ New Rule',
        'autopilot.pause': 'Pause AutoPilot',
        'autopilot.resume': 'Resume AutoPilot',
        'autopilot.test': 'Test',
        'autopilot.test.title': 'Test Rule \u2014 Dry Run',
        'autopilot.test.would_fire': '\u2714 Would fire',
        'autopilot.test.would_not_fire': '\u2718 Would NOT fire',
        'autopilot.test.actions_header': 'Actions that would execute:',
        'autopilot.upgrade_to_pro': 'Upgrade to Pro \u2192',
        // Upgrade modal
        'upgrade.rule_limit_title': 'Rule Limit Reached',
        'upgrade.rule_limit_default': 'Upgrade to add more rules.',
        'upgrade.maybe_later': 'Maybe Later',
        'upgrade.cta': 'Upgrade Plan \u2192',
        // Profile page
        'profile.sub': 'Update your contact information',
        'profile.contact': 'Contact Information',
        'profile.change_password': 'Change Password',
        'profile.church_name': 'Church Name',
        'profile.contact_email': 'Contact Email',
        'profile.phone': 'Phone Number',
        'profile.location': 'City / State',
        'profile.notes': 'Notes for Support Team',
        'profile.leadership_emails': 'Leadership Email Recipients',
        'profile.leadership_email_desc': 'Service recaps and weekly reports will be emailed to these addresses automatically.',
        'profile.bot_language': 'Bot Language (Telegram)',
        'profile.bot_language_desc': 'Tally bot messages will be sent in this language.',
        'profile.save': 'Save Changes',
        'profile.current_password': 'Current Password',
        'profile.new_password': 'New Password',
        'profile.confirm_password': 'Confirm Password',
        'profile.update_password': 'Update Password',
        // Tech Directors
        'tds.page_sub': 'People who receive alerts and have TD access',
        'tds.invite_link': '\ud83d\udd17 Copy Invite Link',
        'tds.add_btn': '+ Add TD',
        'tds.modal.title': 'Add Tech Director',
        'tds.modal.add': 'Add TD',
        // Schedule
        'schedule.page_sub': 'Define your recurring service windows for smart alerts',
        'schedule.card.title': 'Weekly Service Windows',
        'schedule.desc': 'Add each recurring service window below. Alerts and automation use these time windows.',
        'schedule.empty': 'No service windows yet. Add your first one.',
        'schedule.add_btn': '+ Add Service Window',
        'schedule.tip': 'Tip: set separate windows for Saturday rehearsal and Sunday service.',
        'schedule.save_btn': 'Save Schedule',
        // Notifications
        'notif.page_sub': 'Control how and when you receive alerts',
        'notif.prefs.title': 'Alert Preferences',
        'notif.email.label': 'Email alerts',
        'notif.email.desc': 'Receive offline + error alerts via email',
        'notif.telegram.label': 'Telegram alerts',
        'notif.telegram.desc': 'Receive alerts in Telegram (chat ID required)',
        'notif.sync.label': 'A/V sync alerts',
        'notif.sync.desc': 'Notify when audio/video drift exceeds threshold',
        'notif.digest.label': 'Weekly digest',
        'notif.digest.desc': 'Summary email every Monday morning',
        'notif.recovery.title': 'Auto-Recovery',
        'notif.recovery.label': 'Automatic issue recovery',
        'notif.recovery.desc': 'Tally Engineer will automatically attempt to fix common issues (stream drops, recording failures, encoder reconnects) before alerting your TD. Recovery actions are always logged in session reports.',
        'notif.save': 'Save Preferences',
        'notif.failover.title': 'Stream Failover Protection',
        'notif.failover.enable.label': 'Enable stream failover',
        'notif.failover.enable.desc': 'Auto-switch to a safe source on confirmed signal loss',
        'notif.failover.save': 'Save Failover Settings',
        'notif.failover.drill.title': '\ud83d\udea8 Failover Drill',
        'notif.failover.drill.run': '\u25b6 Run Failover Drill',
        'notif.telegram_card.title': 'Telegram Integration',
        'notif.telegram_chat_id': 'Your Telegram Chat ID',
        // Engineer
        'engineer.page_sub': 'Help Tally Engineer understand your setup so it can diagnose problems faster and give better recommendations.',
        'engineer.training.title': 'Training Status',
        'engineer.setup.title': 'Setup Profile',
        'engineer.stream_platform': 'Stream Platform',
        'engineer.expected_viewers': 'Expected Viewers',
        'engineer.operator_level': 'Operator Experience',
        'engineer.backup_encoder': 'Backup Encoder',
        'engineer.backup_switcher': 'Backup Switcher',
        'engineer.special_notes': 'Special Notes',
        'engineer.save': 'Save Profile',
        'engineer.chat.title': '\ud83d\udcac Chat with Tally Engineer',
        'engineer.chat.placeholder': 'Ask Tally Engineer a question...',
        // Guest Access
        'guests.page_sub': 'Temporary tokens for visiting TDs, contractors, or trainers',
        'guests.generate': '+ Generate Token',
        // Macros
        'macros.page_sub': 'Custom command shortcuts for your tech directors',
        'macros.add_btn': '+ New Macro',
        'macros.modal.title': 'New Macro',
        'macros.modal.save': 'Save Macro',
        // Sessions
        'sessions.page_sub': 'History of recent live service sessions',
        'sessions.reports.title': '\ud83d\udcca Service Reports',
        'sessions.reports.auto': 'Auto-generated after each service',
        // Analytics
        'analytics.page_sub': 'Stream health, viewer trends, and equipment performance',
        'analytics.last_30': 'Last 30 days',
        'analytics.last_90': 'Last 90 days',
        'analytics.last_180': 'Last 6 months',
        'analytics.last_365': 'Last year',
        'analytics.export': 'Export CSV',
        'analytics.kpi.uptime': 'Stream Uptime',
        'analytics.kpi.sessions': 'Total Sessions',
        'analytics.kpi.avg_viewers': 'Avg Peak Viewers',
        'analytics.kpi.recovery': 'Auto-Recovery Rate',
        'analytics.health.title': 'Stream Health & Reliability',
        'analytics.viewers.title': 'Viewer Trends',
        'analytics.platform.title': 'Audience by Platform',
        'analytics.platform.sub': 'Concurrent viewer counts from YouTube, Facebook, and Vimeo',
        'analytics.platform.yt': 'YouTube Peak',
        'analytics.platform.fb': 'Facebook Peak',
        'analytics.platform.vim': 'Vimeo Peak',
        'analytics.platform.avg': 'Avg Total Viewers',
        'analytics.session_stats.title': 'Session Duration & Frequency',
        'analytics.equipment.title': 'Equipment Performance',
        // Alerts
        'alerts.page_sub': 'Recent alerts from your services',
        // Migration
        'migrate.page_sub': "Switching from another system? We'll guide you through.",
        'migrate.question': 'What are you switching from?',
        // Billing
        'billing.sub': 'Manage your plan, payment method, and invoices',
        'billing.loading': 'Loading billing info...',
        'billing.cancel_btn': 'Cancel Subscription',
        'billing.cancel.modal.title': 'We\u2019d hate to see you go.',
        'billing.cancel.modal.body': 'Before you cancel, we\u2019d like to offer you 50% off for the next 3 months. No strings attached.',
        'billing.cancel.accept': 'Accept 50% Off',
        'billing.cancel.decline': 'No thanks, cancel my account',
        'billing.cancel.active_until': 'Your plan will remain active until',
        'billing.cancel.retention.accepted': 'Discount applied! 50% off for the next 3 months. Thank you for staying.',
        'billing.cancel.scheduled': 'Cancellation scheduled',
        // Support
        'support.page_sub': 'Run diagnostics, open tickets, and track platform status',
        'support.sla.title': 'Support SLA',
        'support.diag.title': 'Run Guided Diagnostics',
        'support.diag.issue': 'Issue category',
        'support.diag.severity': 'Severity',
        'support.diag.summary': 'Summary',
        'support.diag.triage': 'Run Triage',
        'support.diag.ticket': 'Open Ticket',
        'support.diag.refresh': 'Refresh Tickets',
        'support.platform.title': 'Platform Status',
        'support.platform.link': 'Open full status page \u2192',
        'support.tickets.title': 'Support Tickets',
        // Modals & dialogs
        'modal.help.got_it': 'Got it',
        'modal.td.title': 'Add Tech Director',
        'modal.td.add': 'Add TD',
        'modal.dialog.cancel': 'Cancel',
        'modal.dialog.ok': 'OK',
        'modal.review.title': 'Share Your Experience',
        // Days of week (for schedule editor)
        'day.sunday': 'Sunday',
        'day.monday': 'Monday',
        'day.tuesday': 'Tuesday',
        'day.wednesday': 'Wednesday',
        'day.thursday': 'Thursday',
        'day.friday': 'Friday',
        'day.saturday': 'Saturday',
        // Language toggle
        'lang.toggle': 'Espa\u00f1ol',
        // Email type display names (admin dashboard)
        'email.type.early-win-back': 'Early Win-Back',
        'email.type.activation-escalation': 'Activation Escalation',
        'email.type.pre-service-friday': 'Pre-Service Friday',
        'email.type.trial-to-paid-onboarding': 'Trial-to-Paid Onboarding',
        'email.type.monthly-roi-summary': 'Monthly ROI Summary',
        'email.type.annual-renewal-reminder': 'Annual Renewal Reminder',
        'email.type.telegram-setup-nudge': 'Telegram Setup Nudge',
        'email.type.nps-survey': 'NPS Survey',
        'email.type.first-year-anniversary': 'First Year Anniversary',
        'email.type.referral-invite': 'Referral Invite',
        'email.type.inactivity-alert': 'Inactivity Alert',
        'email.type.feature-announcement': 'Feature Announcement',
        'email.type.grace-period-ending-early': 'Grace Period Early Warning',
        // Email trigger descriptions
        'email.trigger.early-win-back': 'Auto \u2014 7\u201314 days after cancellation',
        'email.trigger.activation-escalation': 'Auto \u2014 Day 10, app never connected',
        'email.trigger.pre-service-friday': 'Auto \u2014 48h before first scheduled service',
        'email.trigger.trial-to-paid-onboarding': 'Auto \u2014 24h after first payment',
        'email.trigger.monthly-roi-summary': 'Monthly \u2014 portal owner ROI narrative',
        'email.trigger.annual-renewal-reminder': 'Auto \u2014 30 days before annual renewal',
        'email.trigger.telegram-setup-nudge': 'Auto \u2014 Day 5, no Telegram configured',
        'email.trigger.nps-survey': 'Auto \u2014 Day 60 for active customers',
        'email.trigger.first-year-anniversary': 'Auto \u2014 365 days since signup',
        'email.trigger.referral-invite': 'Auto \u2014 Day 90, 4+ sessions',
        'email.trigger.inactivity-alert': 'Auto \u2014 4+ weeks no sessions',
        'email.trigger.feature-announcement': 'Manual \u2014 admin triggered per release',
        'email.trigger.grace-period-ending-early': 'Auto \u2014 5 days before grace expiry',
        // Billing banner text fragments
        'billing.banner.trial_pre': 'Your trial ends in',
        'billing.banner.day': 'day',
        'billing.banner.days': 'days',
        'billing.banner.trial_link': 'Subscribe now',
        'billing.banner.trial_post': 'to keep your service running.',
        'billing.banner.past_due_msg': 'Payment failed.',
        'billing.banner.past_due_link': 'Update your card',
        'billing.banner.past_due_post': 'to avoid service interruption.',
        'billing.banner.canceled_msg': 'Your subscription has ended.',
        'billing.banner.reactivate_link': 'Reactivate',
        'billing.banner.canceled_post': 'to continue monitoring your services.',
        'billing.banner.inactive_msg': 'Your subscription is not yet active.',
        'billing.banner.checkout_link': 'Complete checkout',
        'billing.banner.inactive_post': 'to start monitoring.',
        // Upgrade banner
        'upgrade.connect.headline': 'Unlock all 17 integrations',
        'upgrade.connect.body': 'Your Connect plan supports ATEM, OBS, and vMix. Upgrade to Plus for ProPresenter control, live video preview, on-call TD rotation, and 14 more device integrations.',
        'upgrade.plus.headline': 'Automate your Sundays',
        'upgrade.plus.body': 'Upgrade to Pro for AI Autopilot (auto-start streaming and recording when your service window opens), Planning Center sync, and monthly leadership reports.',
        'upgrade.btn': 'Upgrade to {{tier}} \u2014 {{price}}/mo \u2192',
        // Referral card
        'referral.title': 'Give a month, get a month',
        'referral.body': 'Share your link with another church. When they create a new account and subscribe, you both get a free month.',
        'referral.fine_print': 'Up to 5 free months. New accounts only.',
        'referral.stat.referred': 'Referred',
        'referral.stat.signed_up': 'Signed up',
        'referral.stat.credits': 'Credits earned',
        'referral.copy_btn': 'Copy Link',
        'referral.copied': 'Referral link copied!',
        // Onboarding steps
        'onboarding.step.device.label': 'Connect your first device',
        'onboarding.step.device.detail': 'Download the Tally app and connect your ATEM, OBS, or ProPresenter',
        'onboarding.step.device.btn': '\u2b07 Download App',
        'onboarding.step.telegram.label': 'Set up Telegram notifications',
        'onboarding.step.telegram.detail': 'Send /register {{code}} to @TallyConnectBot on Telegram to receive alerts',
        'onboarding.step.telegram.copy': 'Copy Code',
        'onboarding.step.telegram.open': 'Open Telegram',
        'onboarding.step.failover.label': 'Run a test failover',
        'onboarding.step.failover.detail': 'Trigger a test to confirm Tally detects signal loss and sends an alert',
        'onboarding.step.failover.btn': 'Run Test',
        'onboarding.step.team.label': 'Invite your team',
        'onboarding.step.team.detail': 'Share the registration code so your AV volunteers can join on Telegram',
        'onboarding.step.team.btn': 'Share Code',
        'onboarding.complete': 'All set!',
        'onboarding.complete.sub': 'Your Tally system is fully configured',
        'onboarding.progress': '{{done}} of {{total}} steps complete',
      },
      es: {
        // Navigation
        'nav.overview': 'Resumen',
        'nav.profile': 'Perfil',
        'nav.rooms': 'Salas',
        'nav.team': 'Equipo',
        'nav.alerts': 'Alertas',
        'nav.engineer': 'Tally Engineer',
        'nav.automation': 'Automatizaci\u00f3n',
        'nav.analytics': 'Anal\u00edticas',
        'nav.billing': 'Facturaci\u00f3n',
        'nav.support': 'Ayuda y Soporte',
        // Common buttons
        'btn.save': 'Guardar Cambios',
        'btn.cancel': 'Cancelar',
        'btn.delete': 'Eliminar',
        'btn.enable': 'Activar',
        'btn.disable': 'Desactivar',
        'btn.add': 'Agregar',
        'btn.signout': 'Cerrar sesi\u00f3n',
        'btn.edit': 'Editar',
        'btn.close': 'Cerrar',
        'btn.send': 'Enviar',
        'btn.clear': 'Borrar',
        // Status words
        'status.loading': 'Cargando\u2026',
        'status.connected': 'Conectado',
        'status.disconnected': 'Desconectado',
        'status.enabled': 'Activado',
        'status.disabled': 'Desactivado',
        'status.active': 'Activo',
        'status.paused': 'Pausado',
        'status.online': 'En l\u00ednea',
        'status.offline': 'Sin conexi\u00f3n',
        'status.live': 'En Vivo',
        // Page titles
        'page.overview': 'Resumen',
        'page.profile': 'Perfil de la Iglesia',
        'page.rooms': 'Salas y Equipos',
        'page.overview': 'Resumen',
        'page.profile': 'Perfil de la Iglesia',
        'page.team': 'Equipo',
        'page.schedule': 'Horario de Servicios',
        'page.alerts': 'Alertas',
        'page.billing': 'Facturaci\u00f3n y Suscripci\u00f3n',
        'page.support': 'Ayuda y Soporte',
        'page.analytics': 'Anal\u00edticas',
        'page.engineer': 'Entrena tu Tally Engineer',
        'page.automation': 'Automatizaci\u00f3n',
        'page.equipment': 'Equipos',
        'team.sub': 'Gestiona directores t\u00e9cnicos y acceso de invitados',
        'alerts.sub': 'Preferencias de notificaci\u00f3n e historial de alertas',
        'automation.sub': 'Macros, reglas y flujos automatizados',
        'analytics.sub': 'Sesiones, salud del stream y datos de rendimiento',
        'equipment.sub': 'Configura tu equipo de producci\u00f3n',
        // Overview
        'overview.sub': 'Portal de monitoreo de la iglesia',
        'overview.getting_started': 'Primeros Pasos',
        'overview.setup_progress': 'Completa estos pasos para finalizar la configuraci\u00f3n',
        'overview.dismiss': 'Descartar',
        'overview.resume_setup': '\ud83d\udccb Retomar Gu\u00eda de Configuraci\u00f3n',
        'overview.connection': 'Conexi\u00f3n',
        'overview.sessions_30d': 'Sesiones (30d)',
        'overview.stat_tds': 'Directores T\u00e9cnicos',
        'overview.preservice.title': '\ud83d\udd27 Chequeo Pre-Servicio',
        'overview.preservice.fix_all': 'Corregir lo que sea seguro',
        'overview.preservice.run_now': 'Checar ahora',
        'overview.quickinfo.rooms': 'Salas',
        'overview.equip.title': 'Estado del Equipo',
        'overview.equip.refresh': '\u21bb Actualizar',
        'overview.stream.title': 'Transmisi\u00f3n en Vivo',
        'overview.stream.bitrate': 'Bitrate (kbps)',
        'overview.stream.fps': 'FPS',
        'overview.stream.health': 'Estado',
        'overview.stream.uptime': 'Tiempo Activo',
        'overview.atem.title': '\ud83c\udfa7 Mezclador ATEM',
        'overview.atem.program': 'Programa',
        'overview.atem.preview': 'Vista Previa',
        'overview.audio.title': '\ud83d\udd0a Estado de Audio',
        'overview.audio.mute': 'Silencio',
        'overview.audio.silence': 'Sin Sonido',
        'overview.audio.monitoring': 'Monitoreo',
        'overview.rundown.title': '\ud83d\udccb Gu\u00ed\u00f3n del Servicio',
        'overview.activity.title': '\u26a1 Actividad Reciente',
        'overview.engineer.title': 'Tally Engineer',
        'overview.schedule.title': 'Horario de Servicio',
        'overview.quickinfo.title': 'Informaci\u00f3n R\u00e1pida',
        'overview.quickinfo.church_id': 'ID de Iglesia',
        'overview.quickinfo.registered': 'Registrado',
        'overview.quickinfo.plan': 'Plan',
        'rooms.page_sub': 'Administra salas, equipos y horario de servicio',
        'rooms.title': 'Salas',
        'rooms.desc': 'Las salas son espacios f\u00edsicos (Santuario Principal, Sal\u00f3n Juvenil, etc). Asigna cada escritorio Tally a una sala desde la pesta\u00f1a de Equipos.',
        // Shared table headers
        'table.status': 'Estado',
        'table.devices': 'Dispositivos',
        'table.health': 'Estado',
        'table.last_seen': '\u00daltima Vez',
        'table.system': 'Sistema',
        'table.version': 'Versi\u00f3n',
        'table.detail': 'Detalle',
        'table.name': 'Nombre',
        'table.role': 'Rol',
        'table.email': 'Correo',
        'table.phone': 'Tel\u00e9fono',
        'table.date': 'Fecha',
        'table.duration': 'Duraci\u00f3n',
        'table.peak_viewers': 'Pico de Espectadores',
        'table.token': 'Token',
        'table.label': 'Etiqueta',
        'table.created': 'Creado',
        'table.expires': 'Vence',
        'table.severity': 'Gravedad',
        'table.code': 'C\u00f3digo de Registro',
        'table.action': 'Acci\u00f3n',
        // AutoPilot
        'autopilot.subtitle': 'Reglas de automatizaci\u00f3n que se activan durante tus servicios',
        'autopilot.no_rules': 'Sin reglas a\u00fan. Haz clic en \u201c+ Nueva Regla\u201d para crear tu primera automatizaci\u00f3n.',
        'autopilot.paused_banner': '\u23f8 AutoPilot est\u00e1 pausado \u2014 todas las reglas est\u00e1n suspendidas.',
        'autopilot.upgrade_gate_title': 'AutoPilot requiere el plan Pro o superior',
        'autopilot.upgrade_gate_body': 'Configura reglas de automatizaci\u00f3n para tus servicios \u2014 inicio autom\u00e1tico de grabaci\u00f3n, cambio de c\u00e1maras en diapositivas, y m\u00e1s.',
        'autopilot.new_rule': '+ Nueva Regla',
        'autopilot.pause': 'Pausar AutoPilot',
        'autopilot.resume': 'Reanudar AutoPilot',
        'autopilot.test': 'Probar',
        'autopilot.test.title': 'Probar Regla \u2014 Simulaci\u00f3n',
        'autopilot.test.would_fire': '\u2714 Se activar\u00eda',
        'autopilot.test.would_not_fire': '\u2718 NO se activar\u00eda',
        'autopilot.test.actions_header': 'Acciones que se ejecutar\u00edan:',
        'autopilot.upgrade_to_pro': 'Actualizar a Pro \u2192',
        // Upgrade modal
        'upgrade.rule_limit_title': 'L\u00edmite de reglas alcanzado',
        'upgrade.rule_limit_default': 'Actualiza tu plan para agregar m\u00e1s reglas.',
        'upgrade.maybe_later': 'Tal vez luego',
        'upgrade.cta': 'Actualizar Plan \u2192',
        // Profile page
        'profile.sub': 'Actualiza tu informaci\u00f3n de contacto',
        'profile.contact': 'Informaci\u00f3n de Contacto',
        'profile.change_password': 'Cambiar Contrase\u00f1a',
        'profile.church_name': 'Nombre de la Iglesia',
        'profile.contact_email': 'Correo de Contacto',
        'profile.phone': 'N\u00famero de Tel\u00e9fono',
        'profile.location': 'Ciudad / Estado',
        'profile.notes': 'Notas para el Equipo de Soporte',
        'profile.leadership_emails': 'Correos de Liderazgo',
        'profile.leadership_email_desc': 'Los res\u00famenes de servicio y reportes semanales se enviar\u00e1n autom\u00e1ticamente a estas direcciones.',
        'profile.bot_language': 'Idioma del Bot (Telegram)',
        'profile.bot_language_desc': 'Los mensajes del bot Tally se enviar\u00e1n en este idioma.',
        'profile.save': 'Guardar Cambios',
        'profile.current_password': 'Contrase\u00f1a Actual',
        'profile.new_password': 'Nueva Contrase\u00f1a',
        'profile.confirm_password': 'Confirmar Contrase\u00f1a',
        'profile.update_password': 'Actualizar Contrase\u00f1a',
        // Tech Directors
        'tds.page_sub': 'Personas que reciben alertas y tienen acceso de DT',
        'tds.invite_link': '\ud83d\udd17 Copiar Enlace de Invitaci\u00f3n',
        'tds.add_btn': '+ Agregar DT',
        'tds.modal.title': 'Agregar Director T\u00e9cnico',
        'tds.modal.add': 'Agregar DT',
        // Schedule
        'schedule.page_sub': 'Define los horarios de tus servicios recurrentes para que las alertas funcionen bien',
        'schedule.card.title': 'Horarios de Servicio Semanales',
        'schedule.desc': 'Agrega cada horario de servicio recurrente. Las alertas y la automatizaci\u00f3n se basan en estos bloques.',
        'schedule.empty': 'Todav\u00eda no hay servicios configurados. Agrega el primero.',
        'schedule.add_btn': '+ Agregar Servicio',
        'schedule.tip': 'Tip: agrega bloques separados para el ensayo del s\u00e1bado y el servicio del domingo.',
        'schedule.save_btn': 'Guardar Horario',
        // Notifications
        'notif.page_sub': 'Controla c\u00f3mo y cu\u00e1ndo recibes alertas',
        'notif.prefs.title': 'Preferencias de Alertas',
        'notif.email.label': 'Alertas por correo',
        'notif.email.desc': 'Recibe alertas de desconexi\u00f3n y error por correo electr\u00f3nico',
        'notif.telegram.label': 'Alertas de Telegram',
        'notif.telegram.desc': 'Recibe alertas en Telegram (requiere ID de chat)',
        'notif.sync.label': 'Alertas de sincron\u00eda A/V',
        'notif.sync.desc': 'Te avisa cuando el desfase de audio/video se salga del rango normal',
        'notif.digest.label': 'Resumen semanal',
        'notif.digest.desc': 'Correo de resumen todos los lunes por la ma\u00f1ana',
        'notif.recovery.title': 'Recuperaci\u00f3n Autom\u00e1tica',
        'notif.recovery.label': 'Recuperaci\u00f3n autom\u00e1tica de problemas',
        'notif.recovery.desc': 'Tally Engineer intentar\u00e1 corregir autom\u00e1ticamente problemas comunes (ca\u00eddas de stream, fallas de grabaci\u00f3n) antes de alertar a tu DT. Las acciones siempre se registran.',
        'notif.save': 'Guardar Preferencias',
        'notif.failover.title': 'Respaldo Autom\u00e1tico de Transmisi\u00f3n',
        'notif.failover.enable.label': 'Activar respaldo de transmisi\u00f3n',
        'notif.failover.enable.desc': 'Cambiar autom\u00e1ticamente a una fuente segura cuando se detecte p\u00e9rdida de se\u00f1al',
        'notif.failover.save': 'Guardar Configuraci\u00f3n',
        'notif.failover.drill.title': '\ud83d\udea8 Prueba de Respaldo',
        'notif.failover.drill.run': '\u25b6 Ejecutar Prueba',
        'notif.telegram_card.title': 'Integraci\u00f3n con Telegram',
        'notif.telegram_chat_id': 'Tu ID de Chat de Telegram',
        // Engineer
        'engineer.page_sub': 'Ayuda al Tally Engineer a entender tu configuraci\u00f3n para diagnosticar problemas m\u00e1s r\u00e1pido.',
        'engineer.training.title': 'Estado del Entrenamiento',
        'engineer.setup.title': 'Perfil de Configuraci\u00f3n',
        'engineer.stream_platform': 'Plataforma de Transmisi\u00f3n',
        'engineer.expected_viewers': 'Audiencia estimada',
        'engineer.operator_level': 'Nivel del t\u00e9cnico',
        'engineer.backup_encoder': 'Encoder de Respaldo',
        'engineer.backup_switcher': 'Switcher de Respaldo',
        'engineer.special_notes': 'Notas Especiales',
        'engineer.save': 'Guardar Perfil',
        'engineer.chat.title': '\ud83d\udcac Chatear con Tally Engineer',
        'engineer.chat.placeholder': 'Preg\u00fantale algo al Tally Engineer...',
        // Guest Access
        'guests.page_sub': 'Tokens temporales para DTs visitantes, contratistas o entrenadores',
        'guests.generate': '+ Generar Token',
        // Macros
        'macros.page_sub': 'Atajos de comandos personalizados para tus directores t\u00e9cnicos',
        'macros.add_btn': '+ Nueva Macro',
        'macros.modal.title': 'Nueva Macro',
        'macros.modal.save': 'Guardar Macro',
        // Sessions
        'sessions.page_sub': 'Historial de sesiones de servicio recientes',
        'sessions.reports.title': '\ud83d\udcca Reportes de Servicio',
        'sessions.reports.auto': 'Se genera solo despu\u00e9s de cada servicio',
        // Analytics
        'analytics.page_sub': 'Estado del stream, tendencias de audiencia y rendimiento del equipo',
        'analytics.last_30': '\u00daltimos 30 d\u00edas',
        'analytics.last_90': '\u00daltimos 90 d\u00edas',
        'analytics.last_180': '\u00daltimos 6 meses',
        'analytics.last_365': '\u00daltimo a\u00f1o',
        'analytics.export': 'Exportar CSV',
        'analytics.kpi.uptime': 'Tiempo Activo',
        'analytics.kpi.sessions': 'Sesiones Totales',
        'analytics.kpi.avg_viewers': 'Pico Promedio de Espectadores',
        'analytics.kpi.recovery': 'Tasa de Recuperaci\u00f3n',
        'analytics.health.title': 'Estabilidad y Confiabilidad del Stream',
        'analytics.viewers.title': 'Tendencias de Espectadores',
        'analytics.platform.title': 'Audiencia por Plataforma',
        'analytics.platform.sub': 'Espectadores concurrentes de YouTube, Facebook y Vimeo',
        'analytics.platform.yt': 'Pico en YouTube',
        'analytics.platform.fb': 'Pico en Facebook',
        'analytics.platform.vim': 'Pico en Vimeo',
        'analytics.platform.avg': 'Promedio Total de Espectadores',
        'analytics.session_stats.title': 'Duraci\u00f3n y Frecuencia de Sesiones',
        'analytics.equipment.title': 'Rendimiento del Equipo',
        // Alerts
        'alerts.page_sub': 'Alertas recientes de tus servicios',
        // Migration
        'migrate.page_sub': '\u00bfCambiando de otro sistema? Te guiaremos.',
        'migrate.question': '\u00bfDe qu\u00e9 est\u00e1s cambiando?',
        // Billing
        'billing.sub': 'Administra tu plan, m\u00e9todo de pago y facturas',
        'billing.loading': 'Cargando informaci\u00f3n de facturaci\u00f3n...',
        'billing.cancel_btn': 'Cancelar Suscripci\u00f3n',
        'billing.cancel.modal.title': '\u00a1No te vayas todav\u00eda!',
        'billing.cancel.modal.body': 'Antes de cancelar, queremos ofrecerte un 50% de descuento por los pr\u00f3ximos 3 meses. Sin compromisos ni letra chica.',
        'billing.cancel.accept': 'Acepto el 50% de descuento',
        'billing.cancel.decline': 'No gracias, quiero cancelar',
        'billing.cancel.active_until': 'Tu plan se mantiene activo hasta el',
        'billing.cancel.retention.accepted': '\u00a1Descuento aplicado! 50% de descuento por los pr\u00f3ximos 3 meses. Gracias por quedarte con nosotros.',
        'billing.cancel.scheduled': 'Cancelaci\u00f3n programada',
        // Support
        'support.page_sub': 'Ejecuta diagn\u00f3sticos, abre tickets y revisa el estado de la plataforma',
        'support.sla.title': 'SLA de Soporte',
        'support.diag.title': 'Ejecutar Diagn\u00f3sticos Guiados',
        'support.diag.issue': 'Categor\u00eda del problema',
        'support.diag.severity': 'Gravedad',
        'support.diag.summary': 'Resumen',
        'support.diag.triage': 'Ejecutar Triage',
        'support.diag.ticket': 'Abrir Ticket',
        'support.diag.refresh': 'Actualizar Tickets',
        'support.platform.title': 'Estado de la Plataforma',
        'support.platform.link': 'Ver p\u00e1gina de estado completa \u2192',
        'support.tickets.title': 'Tickets de Soporte',
        // Modals & dialogs
        'modal.help.got_it': 'Entendido',
        'modal.td.title': 'Agregar Director T\u00e9cnico',
        'modal.td.add': 'Agregar DT',
        'modal.dialog.cancel': 'Cancelar',
        'modal.dialog.ok': 'Aceptar',
        'modal.review.title': 'Comparte tu Experiencia',
        // Days of week (for schedule editor)
        'day.sunday': 'Domingo',
        'day.monday': 'Lunes',
        'day.tuesday': 'Martes',
        'day.wednesday': 'Mi\u00e9rcoles',
        'day.thursday': 'Jueves',
        'day.friday': 'Viernes',
        'day.saturday': 'S\u00e1bado',
        // Language toggle
        'lang.toggle': 'English',
        // Email type display names (admin dashboard) — Spanish
        'email.type.early-win-back': 'Recuperaci\u00f3n Temprana',
        'email.type.activation-escalation': 'Escalada de Activaci\u00f3n',
        'email.type.pre-service-friday': 'Viernes Pre-Servicio',
        'email.type.trial-to-paid-onboarding': 'Incorporaci\u00f3n Prueba a Pago',
        'email.type.monthly-roi-summary': 'Resumen ROI Mensual',
        'email.type.annual-renewal-reminder': 'Recordatorio de Renovaci\u00f3n Anual',
        'email.type.telegram-setup-nudge': 'Recordatorio Configuraci\u00f3n Telegram',
        'email.type.nps-survey': 'Encuesta NPS',
        'email.type.first-year-anniversary': 'Aniversario Primer A\u00f1o',
        'email.type.referral-invite': 'Invitaci\u00f3n de Referido',
        'email.type.inactivity-alert': 'Alerta de Inactividad',
        'email.type.feature-announcement': 'Anuncio de Nueva Funci\u00f3n',
        'email.type.grace-period-ending-early': 'Aviso Temprano Per\u00edodo de Gracia',
        // Email trigger descriptions — Spanish
        'email.trigger.early-win-back': 'Auto \u2014 7\u201314 d\u00edas tras cancelaci\u00f3n',
        'email.trigger.activation-escalation': 'Auto \u2014 D\u00eda 10, app nunca conectada',
        'email.trigger.pre-service-friday': 'Auto \u2014 48h antes del primer servicio programado',
        'email.trigger.trial-to-paid-onboarding': 'Auto \u2014 24h despu\u00e9s del primer pago',
        'email.trigger.monthly-roi-summary': 'Mensual \u2014 narrativa ROI para el portal',
        'email.trigger.annual-renewal-reminder': 'Auto \u2014 30 d\u00edas antes de renovaci\u00f3n anual',
        'email.trigger.telegram-setup-nudge': 'Auto \u2014 D\u00eda 5, sin Telegram configurado',
        'email.trigger.nps-survey': 'Auto \u2014 D\u00eda 60 para clientes activos',
        'email.trigger.first-year-anniversary': 'Auto \u2014 365 d\u00edas desde el registro',
        'email.trigger.referral-invite': 'Auto \u2014 D\u00eda 90, 4+ sesiones',
        'email.trigger.inactivity-alert': 'Auto \u2014 4+ semanas sin sesiones',
        'email.trigger.feature-announcement': 'Manual \u2014 activado por el administrador',
        'email.trigger.grace-period-ending-early': 'Auto \u2014 5 d\u00edas antes de que venza el per\u00edodo de gracia',
        // Billing banner text fragments
        'billing.banner.trial_pre': 'Tu prueba termina en',
        'billing.banner.day': 'd\u00eda',
        'billing.banner.days': 'd\u00edas',
        'billing.banner.trial_link': 'Suscr\u00edbete ahora',
        'billing.banner.trial_post': 'para no interrumpir tu servicio.',
        'billing.banner.past_due_msg': 'El pago fall\u00f3.',
        'billing.banner.past_due_link': 'Actualiza tu tarjeta',
        'billing.banner.past_due_post': 'para evitar una interrupci\u00f3n del servicio.',
        'billing.banner.canceled_msg': 'Tu suscripci\u00f3n ha finalizado.',
        'billing.banner.reactivate_link': 'React\u00edvala',
        'billing.banner.canceled_post': 'para seguir monitoreando tus servicios.',
        'billing.banner.inactive_msg': 'Tu suscripci\u00f3n a\u00fan no est\u00e1 activa.',
        'billing.banner.checkout_link': 'Completa el pago',
        'billing.banner.inactive_post': 'para comenzar el monitoreo.',
        // Upgrade banner
        'upgrade.connect.headline': 'Desbloquea las 17 integraciones',
        'upgrade.connect.body': 'Tu plan Connect incluye ATEM, OBS y vMix. Actualiza a Plus para control de ProPresenter, vista previa de video en vivo, rotaci\u00f3n de DT de guardia, y 14 integraciones m\u00e1s.',
        'upgrade.plus.headline': 'Automatiza tus domingos',
        'upgrade.plus.body': 'Actualiza a Pro para AI AutoPilot (inicio autom\u00e1tico de transmisi\u00f3n y grabaci\u00f3n al comenzar tu servicio), sincronizaci\u00f3n con Planning Center e informes mensuales de liderazgo.',
        'upgrade.btn': 'Actualizar a {{tier}} \u2014 {{price}}/mes \u2192',
        // Referral card
        'referral.title': 'Da un mes, gana un mes',
        'referral.body': 'Comparte tu enlace con otra iglesia. Cuando abran una cuenta nueva y se suscriban, ambos reciben un mes gratis.',
        'referral.fine_print': 'Hasta 5 meses gratis. Solo cuentas nuevas.',
        'referral.stat.referred': 'Referidos',
        'referral.stat.signed_up': 'Se registraron',
        'referral.stat.credits': 'Cr\u00e9ditos ganados',
        'referral.copy_btn': 'Copiar enlace',
        'referral.copied': '\u00a1Enlace copiado!',
        // Onboarding steps
        'onboarding.step.device.label': 'Conecta tu primer dispositivo',
        'onboarding.step.device.detail': 'Descarga la app de Tally y conecta tu ATEM, OBS o ProPresenter',
        'onboarding.step.device.btn': '\u2b07 Descargar App',
        'onboarding.step.telegram.label': 'Configura las notificaciones de Telegram',
        'onboarding.step.telegram.detail': 'Env\u00eda /register {{code}} a @TallyConnectBot en Telegram para recibir alertas',
        'onboarding.step.telegram.copy': 'Copiar C\u00f3digo',
        'onboarding.step.telegram.open': 'Abrir Telegram',
        'onboarding.step.failover.label': 'Prueba el cambio autom\u00e1tico de se\u00f1al',
        'onboarding.step.failover.detail': 'Activa una prueba para confirmar que Tally detecta la p\u00e9rdida de se\u00f1al y env\u00eda una alerta',
        'onboarding.step.failover.btn': 'Ejecutar Prueba',
        'onboarding.step.team.label': 'Invita a tu equipo',
        'onboarding.step.team.detail': 'Comparte el c\u00f3digo de registro para que tus voluntarios de AV se unan en Telegram',
        'onboarding.step.team.btn': 'Compartir C\u00f3digo',
        'onboarding.complete': '\u00a1Todo listo!',
        'onboarding.complete.sub': 'Tu sistema Tally est\u00e1 completamente configurado',
        'onboarding.progress': '{{done}} de {{total}} pasos completados',
      },
    };

    /**
     * Detect the portal locale from localStorage override or navigator.language.
     * Falls back to 'en'.
     */
    function portalLocale() {
      const stored = localStorage.getItem('tally_portal_locale');
      if (stored && PORTAL_STRINGS[stored]) return stored;
      const lang = (navigator.language || 'en').split('-')[0].toLowerCase();
      return PORTAL_STRINGS[lang] ? lang : 'en';
    }

    /** Toggle between EN and ES, persist to localStorage, re-translate the page. */
    // ── Volunteer Mode ──────────────────────────────────────────────────────────
    function toggleVolunteerMode() {
      var isVolunteer = document.body.classList.toggle('volunteer-mode');
      localStorage.setItem('portal_volunteer_mode', isVolunteer ? '1' : '');
      updateVolunteerToggleUI(isVolunteer);
      // If currently on a hidden page, switch to overview
      if (isVolunteer) {
        var activePage = document.querySelector('.page.active');
        if (activePage && activePage.style.display === 'none') {
          var overviewBtn = document.querySelector('.nav-item[data-page="overview"]');
          if (overviewBtn) showPage('overview', overviewBtn);
        }
      }
    }
    function updateVolunteerToggleUI(isVolunteer) {
      var sw = document.getElementById('lite-toggle-switch');
      var knob = document.getElementById('lite-toggle-knob');
      if (sw && knob) {
        sw.style.background = isVolunteer ? '#22c55e' : '#1e293b';
        knob.style.left = isVolunteer ? '18px' : '2px';
        knob.style.background = isVolunteer ? '#fff' : '#475569';
      }
    }
    // Restore lite mode on load
    if (localStorage.getItem('portal_volunteer_mode') === '1') {
      document.body.classList.add('volunteer-mode');
      updateVolunteerToggleUI(true);
    }
    // Expose globally for inline onclick in banner
    window.toggleVolunteerMode = toggleVolunteerMode;

    // ── Theme Toggle ────────────────────────────────────────────────────────
    function toggleTheme() {
      var isLight = document.body.classList.toggle('light-theme');
      localStorage.setItem('portal_theme', isLight ? 'light' : 'dark');
      updateThemeToggleUI(isLight);
    }
    function updateThemeToggleUI(isLight) {
      var sw = document.getElementById('theme-toggle-switch');
      var knob = document.getElementById('theme-toggle-knob');
      var label = document.getElementById('theme-label');
      if (sw && knob) {
        sw.style.background = isLight ? '#22c55e' : '#1e293b';
        knob.style.left = isLight ? '18px' : '2px';
        knob.style.background = isLight ? '#fff' : '#475569';
      }
      if (label) label.innerHTML = isLight ? '&#9788; Light' : '&#9790; Dark';
    }
    // Restore theme on load
    if (localStorage.getItem('portal_theme') === 'light') {
      document.body.classList.add('light-theme');
      updateThemeToggleUI(true);
    }

    function toggleLanguage() {
      const current = portalLocale();
      const next = current === 'es' ? 'en' : 'es';
      localStorage.setItem('tally_portal_locale', next);
      translatePage();
      // Update the toggle button label
      var btn = document.getElementById('btn-lang-toggle');
      if (btn) btn.textContent = pt('lang.toggle');
    }

    /**
     * Get a portal translated string with optional {{var}} interpolation.
     * Mirrors the bt() API from botI18n.js.
     */
    function pt(key, vars = {}) {
      const locale = portalLocale();
      const str =
        (PORTAL_STRINGS[locale] && PORTAL_STRINGS[locale][key]) ||
        (PORTAL_STRINGS.en && PORTAL_STRINGS.en[key]) ||
        key;
      return str.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] !== undefined ? String(vars[k]) : `{{${k}}}`);
    }

    /**
     * Walk the DOM and apply translations from data-i18n / data-i18n-html /
     * data-i18n-placeholder attributes. Called once on page init.
     */
    function translatePage() {
      document.querySelectorAll('[data-i18n]').forEach(function(el) {
        const key = el.getAttribute('data-i18n');
        if (key) el.textContent = pt(key);
      });
      document.querySelectorAll('[data-i18n-html]').forEach(function(el) {
        const key = el.getAttribute('data-i18n-html');
        if (key) el.innerHTML = pt(key);
      });
      document.querySelectorAll('[data-i18n-placeholder]').forEach(function(el) {
        const key = el.getAttribute('data-i18n-placeholder');
        if (key) el.placeholder = pt(key);
      });
      // Sync SCHEDULE_DAY_LABELS so schedule rows render in the current locale
      SCHEDULE_DAY_LABELS.sunday    = pt('day.sunday');
      SCHEDULE_DAY_LABELS.monday    = pt('day.monday');
      SCHEDULE_DAY_LABELS.tuesday   = pt('day.tuesday');
      SCHEDULE_DAY_LABELS.wednesday = pt('day.wednesday');
      SCHEDULE_DAY_LABELS.thursday  = pt('day.thursday');
      SCHEDULE_DAY_LABELS.friday    = pt('day.friday');
      SCHEDULE_DAY_LABELS.saturday  = pt('day.saturday');
    }

    // ── mobile nav ──────────────────────────────────────────────────────────────
    function toggleMobileNav() {
      var sidebar = document.getElementById('sidebar-nav');
      var overlay = document.getElementById('sidebar-overlay');
      var open = sidebar.classList.toggle('open');
      overlay.classList.toggle('open', open);
    }

    // ── navigation ──────────────────────────────────────────────────────────────
    function showPage(id, el) {
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      document.getElementById('page-' + id).classList.add('active');
      el.classList.add('active');
      // Close mobile nav on page switch
      var sidebar = document.getElementById('sidebar-nav');
      var overlay = document.getElementById('sidebar-overlay');
      if (sidebar) sidebar.classList.remove('open');
      if (overlay) overlay.classList.remove('open');
      if (id === 'overview') { loadOverview(); startOverviewPoll(); } else { stopOverviewPoll(); }
      if (id === 'profile') loadNotifications();
      if (id === 'rooms') { loadRooms(); }
      if (id === 'team') loadTds();
      if (id === 'alerts') { loadAlerts(); loadFailoverSettings(); }
      if (id === 'automation') loadMacros();
      if (id === 'analytics') loadAnalytics();
      if (id === 'billing') { loadBilling(); loadReferralsPage(); }
      if (id === 'support') { loadSupportInfo(); initMigrationWizard(); }
      if (id === 'engineer') startEngineerChatPoll(); else stopEngineerChatPoll();
    }

    // ── Tab switching ────────────────────────────────────────────────────────────
    var _tabLoaded = {};
    function switchTab(tabId) {
      var tabEl = document.getElementById(tabId);
      if (!tabEl) return;
      var page = tabEl.closest('.page');
      if (!page) return;
      // Toggle active tab content
      page.querySelectorAll('.tab-content').forEach(function(tc) { tc.classList.remove('active'); });
      tabEl.classList.add('active');
      // Toggle active tab button
      page.querySelectorAll('.tab-bar button').forEach(function(b) { b.classList.remove('active'); });
      var btn = page.querySelector('.tab-bar button[data-tab="' + tabId + '"]');
      if (btn) btn.classList.add('active');
      // Load data for the tab if not already loaded
      if (!_tabLoaded[tabId]) {
        _tabLoaded[tabId] = true;
        if (tabId === 'tab-equipment') loadEquipment();
        if (tabId === 'tab-schedule') loadSchedule();
        if (tabId === 'tab-guests') loadGuests();
        if (tabId === 'tab-autopilot') loadAutopilot();
        if (tabId === 'tab-sessions') loadSessions();
        if (tabId === 'tab-analytics-data') loadAnalytics();
      }
    }

    // Delegated click handler for tab buttons
    document.addEventListener('click', function(e) {
      var btn = e.target.closest('.tab-bar button[data-tab]');
      if (btn) switchTab(btn.dataset.tab);
    });

    // Room selector change handlers
    document.addEventListener('change', function(e) {
      if (e.target.id === 'eq-room-selector') {
        var roomId = e.target.value;
        if (roomId && roomId !== _equipmentRoomId) {
          loadEquipmentForRoom(roomId);
        }
      }
      if (e.target.id === 'overview-room-selector') {
        _overviewInstance = e.target.value;
        loadOverview();
      }
    });

    // ── toast ──────────────────────────────────────────────────────────────────
    function toast(msg, isError = false) {
      const t = document.getElementById('toast');
      t.textContent = msg;
      t.className = isError ? 'error' : '';
      t.classList.add('show');
      setTimeout(() => t.classList.remove('show'), 3000);
    }

    // ── API ───────────────────────────────────────────────────────────────────
    function getCsrfToken() {
      const m = document.cookie.match(/(?:^|;\s*)tally_csrf=([^;]+)/);
      return m ? m[1] : '';
    }

    async function api(method, path, body) {
      const opts = { method, headers: { 'Content-Type': 'application/json', 'x-csrf-token': getCsrfToken() }, credentials: 'include', signal: AbortSignal.timeout(30000) };
      if (body) opts.body = JSON.stringify(body);
      const r = await fetch(path, opts);
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        const err = new Error(data.error || 'Request failed');
        Object.assign(err, data); // attach upgradeUrl, suggestedPlan, etc.
        throw err;
      }
      return data;
    }

    // ── Overview ───────────────────────────────────────────────────────────────
    var _overviewInstance = ''; // selected room/instance filter

    async function loadOverview() {
      try {
        var instanceParam = _overviewInstance ? '?instance=' + encodeURIComponent(_overviewInstance) : '';
        const d = await api('GET', '/api/church/me' + instanceParam);
        profileData = d;
        document.getElementById('stat-tds').textContent = (d.tds || []).length;
        document.getElementById('registered-date').textContent = d.registeredAt ? new Date(d.registeredAt).toLocaleDateString() : '—';
        const tierNames = { connect: 'Connect', plus: 'Plus', pro: 'Pro', managed: 'Enterprise', event: 'Event' };
        document.getElementById('plan-name').textContent = tierNames[d.billing_tier] || d.billing_tier || 'Connect';
        try {
          var roomsPayload = await api('GET', '/api/church/rooms');
          var roomLimitEl = document.getElementById('plan-room-limit');
          if (roomLimitEl) {
            var limits = roomsPayload && roomsPayload.limits ? roomsPayload.limits : null;
            if (limits) {
              roomLimitEl.textContent = limits.usedTotal + ' / ' + limits.maxTotal;
            } else {
              var rooms = roomsPayload && roomsPayload.rooms ? roomsPayload.rooms : [];
              roomLimitEl.textContent = rooms.length || '0';
            }
          }
        } catch {
          var roomLimitEl = document.getElementById('plan-room-limit');
          if (roomLimitEl) roomLimitEl.textContent = '—';
        }

        const tbody = document.getElementById('equipment-tbody');
        const status = d.status || {};
        const enc = (status.encoder && typeof status.encoder === 'object') ? status.encoder : {};
        const atemConnected = status.atem === true || !!(status.atem && status.atem.connected);
        const obsConnected = status.obs === true || !!(status.obs && status.obs.connected);
        const obsStreaming = status.streaming === true || !!(status.obs && status.obs.streaming);
        const atemStreamingFlag = !!(status.atem && status.atem.streaming);
        const vmixStreamingFlag = !!(status.vmix && status.vmix.streaming);
        const encoderConnected = status.encoder === true || !!enc.connected;
        const encoderLive = !!enc.live || !!enc.streaming || obsStreaming || atemStreamingFlag || vmixStreamingFlag;
        const encNames = {
          obs:'OBS', vmix:'vMix', ecamm:'Ecamm', blackmagic:'Blackmagic',
          aja:'AJA HELO', epiphan:'Epiphan', teradek:'Teradek', tricaster:'TriCaster', birddog:'BirdDog', ndi:'NDI Decoder',
          yolobox:'YoloBox', 'tally-encoder':'Tally Encoder', custom:'Custom',
          'custom-rtmp':'Custom RTMP', 'rtmp-generic':'RTMP Encoder',
        };
        const encoderLabel = encNames[enc.type] || (enc.type
          ? ('Encoder (' + enc.type + ')')
          : ((status.obs && (status.obs.connected || status.obs.app)) ? 'OBS Studio' : 'Streaming Encoder'));
        const encoderStatus = encoderConnected
          ? (encoderLive ? 'streaming' : 'connected')
          : (obsConnected ? (obsStreaming ? 'streaming' : 'connected') : 'unknown');
        const mixerConnected = status.mixer && status.mixer.connected;
        const audioViaAtem = !!(d.audio_via_atem);
        const atemAudioSrcs = status.atem?.atemAudioSources || [];
        const audioPortLabel = atemAudioSrcs.length > 0 ? ' (' + atemAudioSrcs[0].portType + ')' : '';
        const audioStatus = (status.mixer && status.mixer.mainMuted) ? 'muted'
          : (status.audio && status.audio.silenceDetected) ? 'warning'
          : (mixerConnected || audioViaAtem)
            ? ((encoderLive || obsStreaming) ? 'ok' : 'connected')
          : 'unknown';
        const audioLabel = 'Audio' + (audioViaAtem && audioPortLabel ? audioPortLabel : '');

        // ── Version checking helpers ──────────────────────────────────────────
        var MIN_VERS = {obs:'30.0',proPresenter:'7.14',vmix:'27.0',atem_protocol:'2.30',encoder_birddog:'6.0',encoder_teradek:'4.0',encoder_epiphan:'4.24',mixer_behringer:'4.0'};
        function cmpVer(a,b){
          if(!a||!b)return null;
          var pa=String(a).split('.').map(Number),pb=String(b).split('.').map(Number);
          for(var i=0;i<Math.max(pa.length,pb.length);i++){
            var x=pa[i]||0,y=pb[i]||0;
            if(x<y)return -1;if(x>y)return 1;
          }
          return 0;
        }
        function verInfo(ver,type){
          if(!ver)return null;
          var min=MIN_VERS[type];
          var outdated=min?cmpVer(ver,min)<0:false;
          return {text:'v'+ver,outdated:outdated};
        }

        // Extract version strings for each device
        var atemVer = status.atem && status.atem.protocolVersion ? status.atem.protocolVersion : null;
        var encVer = null, encVerType = null;
        if (enc.type === 'obs' || (!enc.type && status.obs)) {
          encVer = status.obs && status.obs.version; encVerType = 'obs';
        } else if (enc.type === 'vmix') {
          encVer = status.vmix && status.vmix.version; encVerType = 'vmix';
        } else if (enc.type) {
          encVer = enc.firmwareVersion; encVerType = 'encoder_' + enc.type;
        }
        var mixerVer = status.mixer && status.mixer.firmware ? status.mixer.firmware : null;
        var mixerVerType = status.mixer && status.mixer.type ? 'mixer_' + status.mixer.type : null;

        // ATEM program/preview detail
        var atemDetail = '';
        if (atemConnected && status.atem) {
          var parts = [];
          if (status.atem.programInput != null) parts.push('PGM: ' + friendlyInputName(status.atem.programInput));
          if (status.atem.previewInput != null) parts.push('PVW: ' + friendlyInputName(status.atem.previewInput));
          if (status.atem.model) parts.push(status.atem.model);
          atemDetail = parts.join(' · ');
        }

        // Stream detail — bitrate + FPS from any source
        var streamDetail = '';
        if (encoderLive || obsStreaming) {
          var sdParts = [];
          var br = null, fp = null;
          if (obsStreaming && status.obs.bitrate > 0) br = status.obs.bitrate;
          else if (atemStreamingFlag && status.atem.streamingBitrate > 0) br = Math.round(status.atem.streamingBitrate / 1000);
          else if (enc.bitrateKbps > 0) br = enc.bitrateKbps;
          if (obsStreaming && status.obs.fps > 0) fp = Math.round(status.obs.fps);
          else if (enc.fps > 0) fp = Math.round(enc.fps);
          if (br) sdParts.push(br.toLocaleString() + ' kbps');
          if (fp) sdParts.push(fp + ' fps');
          streamDetail = sdParts.join(' · ') || '';
        }

        // Recording detail
        var isRecording = !!(status.atem && status.atem.recording) || !!(status.obs && status.obs.recording) || !!(status.vmix && status.vmix.recording);

        const rows = [
          ['ATEM Switcher', atemConnected ? 'connected' : 'unknown', verInfo(atemVer, 'atem_protocol'), atemDetail || null],
          [encoderLabel, encoderStatus, verInfo(encVer, encVerType), null],
          ['Stream', (encoderLive || obsStreaming) ? 'live' : 'offline', null, streamDetail || null],
          ['Recording', isRecording ? 'recording' : 'offline', null, null],
          [audioLabel, audioStatus, null, null],
        ];
        // Dynamic device rows — only show if the device exists in status
        const hd = status.hyperdeck || status.hyperDeck;
        if (hd) {
          const hdSt = hd.recording ? 'recording' : (hd.connected ? 'connected' : 'unknown');
          rows.push(['HyperDeck', hdSt, null, hd.lastSeen || null]);
        }
        if (Array.isArray(status.hyperdecks || status.hyperDecks)) {
          (status.hyperdecks || status.hyperDecks).forEach(function(deck, i) {
            const hdSt = deck.recording ? 'recording' : (deck.connected ? 'connected' : 'unknown');
            rows.push(['HyperDeck ' + (i + 1), hdSt, null, deck.lastSeen || null]);
          });
        }
        const pp = status.proPresenter || status.propresenter;
        if (pp) {
          const ppSt = pp.connected ? 'connected' : 'unknown';
          const ppVer = pp.version || null;
          rows.push(['ProPresenter', ppSt, verInfo(ppVer, 'proPresenter'), pp.lastSeen || null]);
        }
        const res = status.resolume;
        if (res && res.host) {
          const resSt = res.connected ? 'connected' : 'unknown';
          const resVer = res.version || null;
          rows.push(['Resolume Arena', resSt, resVer ? verInfo(resVer, null) : null, null]);
        }
        if (status.ptz || status.cameras) {
          const cams = status.cameras || (status.ptz ? [status.ptz] : []);
          (Array.isArray(cams) ? cams : [cams]).forEach(function(cam, i) {
            if (!cam) return;
            const camSt = cam.connected ? 'connected' : 'unknown';
            const camLabel = cam.name || ('PTZ Camera ' + (i + 1));
            rows.push([camLabel, camSt, null, cam.lastSeen || null]);
          });
        }
        if (status.mixer) {
          const mxSt = status.mixer.connected ? 'connected' : 'unknown';
          const mxName = status.mixer.name || 'Audio Mixer';
          rows.push([mxName, mxSt, verInfo(mixerVer, mixerVerType), status.mixer.lastSeen || null]);
        }
        if (status.resolume && typeof status.resolume === 'object') {
          const rs = status.resolume;
          const rsSt = rs.connected ? 'connected' : 'unknown';
          const rsDetail = rs.currentColumn != null ? 'Column: ' + rs.currentColumn : null;
          rows.push(['Resolume Arena', rsSt, verInfo(rs.version || null, null), rsDetail]);
        }

        // Companion module variables — show as sub-rows under Companion
        if (status.companion && status.companion.variables) {
          var compVars = status.companion.variables;
          for (var connLabel in compVars) {
            if (!compVars.hasOwnProperty(connLabel)) continue;
            var varObj = compVars[connLabel];
            var varParts = [];
            for (var vk in varObj) {
              if (varObj.hasOwnProperty(vk) && varObj[vk] != null) {
                varParts.push(vk.replace(/_/g, ' ') + ': ' + varObj[vk]);
              }
            }
            if (varParts.length) {
              rows.push(['\u00A0\u00A0\u21B3 ' + connLabel, 'connected', null, varParts.join(' · ')]);
            }
          }
        }

        // Room label
        var roomLabel = document.getElementById('equip-room-label');
        if (roomLabel) roomLabel.textContent = d.room_name ? '· ' + d.room_name : '';

        // Staleness indicator
        const stalenessEl = document.getElementById('equip-staleness');
        if (stalenessEl && d.lastSeenAt) {
          const ago = Math.round((Date.now() - new Date(d.lastSeenAt).getTime()) / 1000);
          if (ago < 60) stalenessEl.textContent = 'Updated just now';
          else if (ago < 3600) stalenessEl.textContent = 'Updated ' + Math.round(ago / 60) + 'm ago';
          else stalenessEl.textContent = 'Updated ' + Math.round(ago / 3600) + 'h ago';
          stalenessEl.style.color = ago > 300 ? '#f59e0b' : '#475569';
        }

        tbody.innerHTML = rows.map(([name, st, ver, ts]) => {
          let badgeCls = 'badge-gray';
          let label = st;
          if (st === 'connected' || st === 'ok') badgeCls = 'badge-green';
          else if (st === 'live' || st === 'streaming') { badgeCls = 'badge-green'; label = st === 'live' ? '<span style="color:#ef4444">&#9679;</span> Live' : 'Streaming'; }
          else if (st === 'recording') { badgeCls = 'badge-green'; label = 'Recording'; }
          else if (st === 'warning') badgeCls = 'badge-yellow';
          else if (st === 'muted') { badgeCls = 'badge-yellow'; label = 'Muted'; }
          else if (st === 'offline') { badgeCls = 'badge-gray'; label = 'Offline'; }
          var verHtml = '—';
          if (ver) {
            verHtml = ver.outdated
              ? '<span style="color:#f59e0b">! ' + ver.text + '</span>'
              : '<span style="color:#22c55e">' + ver.text + '</span>';
          }
          var detailHtml = '—';
          if (typeof ts === 'string' && ts.length > 0 && isNaN(Date.parse(ts))) {
            detailHtml = '<span style="color:#94A3B8">' + ts + '</span>';
          } else if (ts) {
            detailHtml = new Date(ts).toLocaleTimeString();
          }
          return `<tr>
            <td>${name}</td>
            <td><span class="badge ${badgeCls}">${label}</span></td>
            <td style="font-size:12px">${verHtml}</td>
            <td style="color:#475569;font-size:12px">${detailHtml}</td>
          </tr>`;
        }).join('');

        // ── Live Stream Stats card ──────────────────────────────────────────
        updateStreamStats(status, enc);

        var statusText = document.getElementById('stat-status-text');
        var statusDot = document.getElementById('stat-status-dot');
        if (statusText) { statusText.textContent = d.connected ? 'Online' : 'Offline'; statusText.style.color = d.connected ? '#22c55e' : '#94A3B8'; }
        if (statusDot) { statusDot.style.background = d.connected ? '#22c55e' : '#ef4444'; }

        // ── Onboarding checklist ──────────────────────────────────────────────
        renderOnboarding(d);

        // ── Review prompt (after onboarding, after upgrade banner) ───────────
        checkReviewEligibility();
        loadReferralCard();

        // ── Schedule summary on overview ──────────────────────────────────────
        loadScheduleOverview();

        // ── Live incident commander ──────────────────────────────────────────
        loadIncidents();

        // ── ATEM detail card ──────────────────────────────────────────────────
        updateAtemDetailCard(status);

        // ── Audio health card ────────────────────────────────────────────────
        updateAudioHealthCard(status, audioViaAtem);

        // ── Pre-service check card ──────────────────────────────────────────
        loadPreServiceCheck();

        // ── Service rundown ──────────────────────────────────────────────────
        loadRundown();

        // ── Activity feed ────────────────────────────────────────────────────
        loadActivityFeed();

        // ── Tally Engineer diagnostics ──────────────────────────────────────
        loadProblems();

        // ── Room/instance selector for overview ─────────────────────────
        var instances = d.instances || [];
        var rSel = document.getElementById('overview-room-selector');
        var rWrap = document.getElementById('overview-room-selector-wrap');
        if (rSel && rWrap && instances.length > 1) {
          // Only rebuild if not already populated
          if (rSel.options.length <= 1) {
            rSel.innerHTML = '<option value="">All Rooms</option>';
            instances.forEach(function(inst) {
              var opt = document.createElement('option');
              opt.value = inst;
              opt.textContent = inst === '_default' ? 'Default' : inst;
              rSel.appendChild(opt);
            });
          }
          rWrap.style.display = '';
        }
      } catch(e) { console.error(e); }
    }

    async function refreshEquipmentStatus() {
      var btn = document.getElementById('btn-refresh-equip');
      if (btn) { btn.disabled = true; btn.textContent = '↻ Refreshing…'; }
      try {
        await loadOverview();
        toast('Equipment status refreshed');
      } catch { toast('Refresh failed', true); }
      finally { if (btn) { btn.disabled = false; btn.textContent = '↻ Refresh'; } }
    }

    var _streamStartedAt = null;
    function updateStreamStats(status, enc) {
      var card = document.getElementById('stream-stats-card');
      if (!card) return;

      // Determine if any source is streaming
      var obsStreaming = !!(status.obs && status.obs.streaming);
      var atemStreaming = !!(status.atem && status.atem.streaming);
      var vmixStreaming = !!(status.vmix && status.vmix.streaming);
      var encoderLive = !!(enc.live || enc.streaming);
      var isLive = obsStreaming || atemStreaming || vmixStreaming || encoderLive;

      if (!isLive) {
        card.style.display = 'none';
        _streamStartedAt = null;
        return;
      }
      card.style.display = '';
      if (!_streamStartedAt) _streamStartedAt = Date.now();

      // Source label
      var source = 'Unknown';
      var encNames = {obs:'OBS',vmix:'vMix',ecamm:'Ecamm',blackmagic:'Blackmagic',aja:'AJA',epiphan:'Epiphan',teradek:'Teradek',tricaster:'TriCaster',birddog:'BirdDog'};
      if (atemStreaming) source = 'ATEM Encoder' + (status.atem.streamingService ? ' → ' + status.atem.streamingService : '');
      else if (obsStreaming) source = 'OBS Studio';
      else if (vmixStreaming) source = 'vMix';
      else if (encoderLive) source = encNames[enc.type] || enc.type || 'Encoder';
      document.getElementById('stream-source-label').textContent = source;

      // Bitrate — from any source
      var bitrate = null;
      if (obsStreaming && status.obs.bitrate > 0) bitrate = status.obs.bitrate;
      else if (atemStreaming && status.atem.streamingBitrate > 0) bitrate = Math.round(status.atem.streamingBitrate / 1000);
      else if (encoderLive && enc.bitrateKbps > 0) bitrate = enc.bitrateKbps;
      var brEl = document.getElementById('ss-bitrate');
      if (brEl) {
        brEl.textContent = bitrate !== null ? bitrate.toLocaleString() : '—';
        brEl.style.color = bitrate !== null && bitrate < 1000 ? '#ef4444' : '#F8FAFC';
      }

      // FPS — from any source
      var fps = null;
      if (obsStreaming && status.obs.fps > 0) fps = Math.round(status.obs.fps);
      else if (encoderLive && enc.fps > 0) fps = Math.round(enc.fps);
      var fpsEl = document.getElementById('ss-fps');
      if (fpsEl) {
        fpsEl.textContent = fps !== null ? fps : '—';
        fpsEl.style.color = fps !== null && fps < 24 ? '#f59e0b' : '#F8FAFC';
      }

      // Health indicator
      var healthEl = document.getElementById('ss-health');
      if (healthEl) {
        if (bitrate !== null && bitrate < 1000) { healthEl.textContent = 'Low'; healthEl.style.color = '#ef4444'; }
        else if (fps !== null && fps < 24) { healthEl.textContent = 'FPS'; healthEl.style.color = '#f59e0b'; }
        else if (bitrate !== null || fps !== null) { healthEl.textContent = '✓ Good'; healthEl.style.color = '#22c55e'; }
        else { healthEl.textContent = '—'; healthEl.style.color = '#F8FAFC'; }
      }

      // Uptime
      var uptimeEl = document.getElementById('ss-uptime');
      if (uptimeEl && _streamStartedAt) {
        var sec = Math.round((Date.now() - _streamStartedAt) / 1000);
        var h = Math.floor(sec / 3600); var m = Math.floor((sec % 3600) / 60); var s = sec % 60;
        uptimeEl.textContent = h > 0 ? h + 'h ' + m + 'm' : m + 'm ' + s + 's';
      }

      // Detail row — extra info
      var details = [];
      if (atemStreaming && status.atem.streamingCacheUsed !== null && status.atem.streamingCacheUsed !== undefined) {
        details.push('ATEM cache: ' + status.atem.streamingCacheUsed + '%');
      }
      if (status.streamHealth && status.streamHealth.baselineBitrate) {
        details.push('Baseline: ' + status.streamHealth.baselineBitrate);
      }
      if (status.streamHealth && status.streamHealth.recentBitrate) {
        details.push('Recent avg: ' + status.streamHealth.recentBitrate);
      }
      var detailEl = document.getElementById('ss-detail-row');
      if (detailEl) detailEl.innerHTML = details.map(function(d) { return '<span>' + d + '</span>'; }).join('');
    }

    // ── ATEM Detail Card ─────────────────────────────────────────────────────
    function updateAtemDetailCard(status) {
      var card = document.getElementById('atem-detail-card');
      if (!card) return;
      var atem = status.atem;
      if (!atem || (!atem.connected && atem !== true)) { card.style.display = 'none'; return; }
      card.style.display = '';

      var modelEl = document.getElementById('atem-model-label');
      if (modelEl) modelEl.textContent = (typeof atem === 'object' && atem.model) ? atem.model : 'ATEM';

      var labels = (typeof atem === 'object' && atem.inputLabels) ? atem.inputLabels : {};
      var pgmEl = document.getElementById('atem-pgm-input');
      var pgmLbl = document.getElementById('atem-pgm-label');
      if (pgmEl) pgmEl.textContent = atem.programInput != null ? friendlyInputName(atem.programInput) : '—';
      if (pgmLbl) pgmLbl.textContent = labels[atem.programInput] || '';

      var pvwEl = document.getElementById('atem-pvw-input');
      var pvwLbl = document.getElementById('atem-pvw-label');
      if (pvwEl) pvwEl.textContent = atem.previewInput != null ? friendlyInputName(atem.previewInput) : '—';
      if (pvwLbl) pvwLbl.textContent = labels[atem.previewInput] || '';

      var badges = document.getElementById('atem-status-badges');
      if (badges) {
        var parts = [];
        if (atem.recording) parts.push('<span class="badge badge-green">Recording</span>');
        if (atem.streaming) parts.push('<span class="badge badge-green"><span style="color:#ef4444">&#9679;</span> Streaming</span>');
        if (!atem.recording && !atem.streaming) parts.push('<span class="badge badge-gray">Standby</span>');
        if (atem.streamingCacheUsed > 80) parts.push('<span class="badge badge-yellow">Cache ' + Math.round(atem.streamingCacheUsed) + '%</span>');
        badges.innerHTML = parts.join(' ');
      }
    }

    // ── Audio Health Card ────────────────────────────────────────────────────
    function updateAudioHealthCard(status, audioViaAtem) {
      var card = document.getElementById('audio-health-card');
      if (!card) return;
      var mixer = status.mixer || {};
      var audio = status.audio || {};
      var hasAudio = mixer.connected || audioViaAtem || audio.monitoring;
      if (!hasAudio) { card.style.display = 'none'; return; }
      card.style.display = '';

      var srcEl = document.getElementById('audio-source-label');
      if (srcEl) {
        var src = audioViaAtem ? 'ATEM Audio' : (mixer.name || mixer.type || 'Audio Mixer');
        srcEl.textContent = src;
      }

      var muteEl = document.getElementById('audio-mute-status');
      if (muteEl) {
        if (mixer.mainMuted) { muteEl.textContent = 'MUTED'; muteEl.style.color = '#ef4444'; }
        else { muteEl.textContent = 'OK'; muteEl.style.color = '#22c55e'; }
      }

      var silEl = document.getElementById('audio-silence-status');
      if (silEl) {
        if (audio.silenceDetected) { silEl.textContent = 'Silence'; silEl.style.color = '#eab308'; }
        else { silEl.textContent = '✓ Signal'; silEl.style.color = '#22c55e'; }
      }

      var monEl = document.getElementById('audio-monitoring-status');
      if (monEl) {
        if (audio.monitoring) { monEl.textContent = '✓ Active'; monEl.style.color = '#22c55e'; }
        else { monEl.textContent = '— Off'; monEl.style.color = '#94A3B8'; }
      }

      var detailRow = document.getElementById('audio-detail-row');
      if (detailRow) {
        var parts = [];
        if (mixer.firmware) parts.push('Firmware: ' + mixer.firmware);
        if (audio.lastLevel != null) parts.push('Level: ' + audio.lastLevel + ' dB');
        var atemSrcs = status.atem && status.atem.atemAudioSources;
        if (Array.isArray(atemSrcs) && atemSrcs.length) parts.push('Port: ' + atemSrcs[0].portType);
        detailRow.innerHTML = parts.map(function(p) { return '<span>' + p + '</span>'; }).join('');
      }
    }

    // ── Rundown Card ─────────────────────────────────────────────────────────
    var TRIGGER_ICONS = { manual: 'M', time_absolute: 'T', time_relative: 'R', delay: 'D', event: 'E' };

    async function loadRundown() {
      var body = document.getElementById('rundown-body');
      var badge = document.getElementById('rundown-status-badge');
      if (!body) return;
      try {
        var status = await api('GET', '/api/church/scheduler/status');
        if (status && status.active) {
          var stateColor = status.state === 'running' ? 'badge-green' : (status.state === 'paused' ? 'badge-yellow' : 'badge-gray');
          badge.className = 'badge ' + stateColor;
          badge.textContent = status.state === 'completed' ? 'Done' : ('Cue ' + (status.currentCue + 1) + '/' + status.totalCues);
          var active = await api('GET', '/api/church/rundown/active');
          renderActiveRundown(body, active, status);
        } else {
          badge.className = 'badge badge-gray';
          badge.textContent = 'Inactive';
          var rundowns = await api('GET', '/api/church/rundowns');
          renderRundownPicker(body, rundowns);
        }
      } catch (e) {
        body.innerHTML = '<div style="color:#475569;text-align:center;padding:16px;font-size:13px">Rundown unavailable</div>';
        badge.className = 'badge badge-gray';
        badge.textContent = '—';
      }
    }

    function renderActiveRundown(container, data, schedulerStatus) {
      var steps = data.rundown ? data.rundown.steps : [];
      var currentIdx = schedulerStatus ? schedulerStatus.currentCue : (data.stepIndex || 0);
      var state = schedulerStatus ? schedulerStatus.state : 'running';
      var progress = schedulerStatus ? schedulerStatus.progress : 0;
      var rundownName = schedulerStatus ? schedulerStatus.rundownName : (data.rundownName || 'Rundown');

      var html = '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">';
      html += '<div style="font-size:14px;font-weight:600;color:#F8FAFC">' + escapeHtml(rundownName) + '</div>';
      var stateIcon = state === 'running' ? '&#9654;' : (state === 'paused' ? '&#9646;&#9646;' : '&#10003;');
      html += '<span style="font-size:12px;color:#94A3B8">' + stateIcon + ' ' + state.toUpperCase() + '</span>';
      html += '</div>';

      html += '<div style="height:4px;background:#1E293B;border-radius:2px;margin-bottom:12px;overflow:hidden">';
      html += '<div style="height:100%;width:' + progress + '%;background:#22c55e;border-radius:2px;transition:width 0.3s"></div></div>';

      if (schedulerStatus && state !== 'completed') {
        html += '<div style="font-size:11px;color:#94A3B8;margin-bottom:10px">' + escapeHtml(schedulerStatus.nextTriggerInfo) + '</div>';
      }

      html += '<div style="display:flex;flex-direction:column;gap:4px;margin-bottom:14px;max-height:240px;overflow-y:auto">';
      steps.forEach(function(step, i) {
        var isCurrent = i === currentIdx;
        var isPast = i < currentIdx;
        var bg = isCurrent ? 'rgba(34,197,94,0.1)' : '#09090B';
        var border = isCurrent ? '1px solid rgba(34,197,94,0.3)' : '1px solid transparent';
        var nameColor = isCurrent ? '#22c55e' : (isPast ? '#475569' : '#94A3B8');
        var icon = isPast ? '✓' : (isCurrent ? '▶' : (i + 1));
        var iconColor = isPast ? '#22c55e' : (isCurrent ? '#22c55e' : '#475569');
        var stepName = step.label || step.name || ('Cue ' + (i + 1));
        var trigger = step.trigger || { type: 'manual' };
        var triggerIcon = TRIGGER_ICONS[trigger.type] || '?';
        var cmdCount = (step.commands || []).length;
        var cmdLabel = cmdCount > 0 ? cmdCount + ' cmd' + (cmdCount !== 1 ? 's' : '') : '';
        html += '<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:' + bg + ';border:' + border + ';border-radius:6px;cursor:pointer" onclick="portalJumpToCue(' + i + ')">';
        html += '<span style="color:' + iconColor + ';font-size:13px;width:20px;text-align:center;font-weight:700">' + icon + '</span>';
        html += '<span style="font-size:12px" title="' + trigger.type + '">' + triggerIcon + '</span>';
        html += '<span style="color:' + nameColor + ';font-size:13px;flex:1">' + escapeHtml(stepName) + '</span>';
        if (cmdLabel) html += '<span style="color:#475569;font-size:10px">' + cmdLabel + '</span>';
        html += '</div>';
      });
      html += '</div>';

      html += '<div style="display:flex;gap:8px;flex-wrap:wrap">';
      if (state !== 'completed') {
        html += '<button class="btn-primary" onclick="portalSchedulerGo()" style="font-size:12px;padding:6px 14px">Go</button>';
        html += '<button class="btn-secondary" onclick="portalSchedulerSkip()" style="font-size:12px;padding:6px 10px">Skip</button>';
        html += '<button class="btn-secondary" onclick="portalSchedulerBack()" style="font-size:12px;padding:6px 10px">Back</button>';
        if (state === 'running') html += '<button class="btn-secondary" onclick="portalSchedulerPause()" style="font-size:12px;padding:6px 10px">Pause</button>';
        else if (state === 'paused') html += '<button class="btn-secondary" onclick="portalSchedulerResume()" style="font-size:12px;padding:6px 10px;border-color:#22c55e;color:#22c55e">Resume</button>';
      }
      html += '<button class="btn-secondary" onclick="portalEndRundown()" style="font-size:12px;padding:6px 10px;border-color:#ef4444;color:#ef4444">End</button>';
      html += '</div>';

      if (steps[currentIdx] && steps[currentIdx].notes) {
        html += '<div style="margin-top:10px;padding:8px 12px;background:rgba(245,158,11,0.08);border-radius:6px;font-size:12px;color:#f59e0b"><strong>Tip:</strong> ' + escapeHtml(steps[currentIdx].notes) + '</div>';
      }
      container.innerHTML = html;
    }

    function renderRundownPicker(container, rundowns) {
      if (!rundowns || !rundowns.length) {
        container.innerHTML = '<div style="color:#475569;text-align:center;padding:16px;font-size:13px">No rundowns yet. Create one via Telegram or the API.</div>';
        return;
      }
      var html = '<div style="display:flex;flex-direction:column;gap:6px">';
      rundowns.forEach(function(r) {
        var stepCount = (r.steps || []).length;
        var autoLabel = r.auto_activate ? ' <span style="color:#f59e0b;font-size:10px">AUTO</span>' : '';
        html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:#09090B;border-radius:6px">';
        html += '<div><span style="color:#F8FAFC;font-size:13px">' + escapeHtml(r.name) + '</span>' + autoLabel;
        html += ' <span style="color:#475569;font-size:11px">' + stepCount + ' cues</span></div>';
        html += '<button class="btn-sm" onclick="portalActivateRundown(&apos;' + r.id + '&apos;)">Start</button>';
        html += '</div>';
      });
      html += '</div>';
      container.innerHTML = html;
    }

    async function portalActivateRundown(rundownId) {
      try { await api('POST', '/api/church/scheduler/activate', { rundownId: rundownId }); toast('Rundown started'); loadRundown(); }
      catch (e) { toast(e.message, true); }
    }
    async function portalSchedulerGo() {
      try { await api('POST', '/api/church/scheduler/advance'); toast('Cue fired'); loadRundown(); }
      catch (e) { toast(e.message, true); }
    }
    async function portalSchedulerSkip() {
      try { await api('POST', '/api/church/scheduler/skip'); toast('Cue skipped'); loadRundown(); }
      catch (e) { toast(e.message, true); }
    }
    async function portalSchedulerBack() {
      try { await api('POST', '/api/church/scheduler/back'); toast('Back one cue'); loadRundown(); }
      catch (e) { toast(e.message, true); }
    }
    async function portalJumpToCue(index) {
      try { await api('POST', '/api/church/scheduler/jump', { cueIndex: index }); toast('Jumped to cue ' + (index + 1)); loadRundown(); }
      catch (e) { toast(e.message, true); }
    }
    async function portalSchedulerPause() {
      try { await api('POST', '/api/church/scheduler/pause'); toast('Rundown paused'); loadRundown(); }
      catch (e) { toast(e.message, true); }
    }
    async function portalSchedulerResume() {
      try { await api('POST', '/api/church/scheduler/resume'); toast('Rundown resumed'); loadRundown(); }
      catch (e) { toast(e.message, true); }
    }
    async function portalEndRundown() {
      try { await api('POST', '/api/church/scheduler/deactivate'); toast('Rundown ended'); loadRundown(); }
      catch (e) { toast(e.message, true); }
    }

    // ── Activity Feed ────────────────────────────────────────────────────────
    async function loadActivityFeed() {
      var body = document.getElementById('activity-feed-body');
      var countEl = document.getElementById('activity-feed-count');
      if (!body) return;
      try {
        var sessionData, alerts;
        try { sessionData = await api('GET', '/api/church/session/active'); } catch { sessionData = { active: false }; }
        try { alerts = await api('GET', '/api/church/alerts'); } catch { alerts = []; }

        var items = [];
        if (sessionData && sessionData.active && sessionData.events) {
          sessionData.events.forEach(function(e) {
            items.push({
              time: new Date(e.timestamp),
              type: (e.event_type || '').replace(/_/g, ' '),
              detail: typeof e.details === 'string' ? e.details.slice(0, 100) : (typeof e.message === 'string' ? e.message.slice(0, 100) : ''),
              severity: e.auto_resolved ? 'auto_fixed' : (e.resolved ? 'resolved' : 'active'),
              source: 'session'
            });
          });
        }
        (alerts || []).slice(0, 15).forEach(function(a) {
          items.push({
            time: new Date(a.created_at),
            type: (a.alert_type || '').replace(/_/g, ' '),
            detail: a.context && a.context.diagnosis ? (a.context.diagnosis.likely_cause || '').slice(0, 100) : '',
            severity: a.resolved ? 'resolved' : (a.severity || 'INFO'),
            source: 'alert'
          });
        });

        items.sort(function(a, b) { return b.time - a.time; });
        // deduplicate by type+minute
        var seen = {};
        items = items.filter(function(it) {
          var key = it.type + '-' + Math.floor(it.time.getTime() / 60000);
          if (seen[key]) return false;
          seen[key] = true;
          return true;
        }).slice(0, 20);

        if (countEl) countEl.textContent = items.length + ' events';
        if (!items.length) {
          body.innerHTML = '<div style="color:#475569;text-align:center;padding:16px;font-size:13px">No recent activity</div>';
          return;
        }

        body.innerHTML = items.map(function(item) {
          var timeStr = item.time.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
          var dateStr = item.time.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          var icon, color;
          if (item.severity === 'auto_fixed') { icon = '<span style="font-size:10px;font-weight:700">AI</span>'; color = '#22c55e'; }
          else if (item.severity === 'resolved') { icon = '<span style="color:#22c55e">&#10003;</span>'; color = '#22c55e'; }
          else if (item.severity === 'CRITICAL' || item.severity === 'EMERGENCY') { icon = '<span style="color:#ef4444">&#9679;</span>'; color = '#ef4444'; }
          else if (item.severity === 'WARNING' || item.severity === 'active') { icon = '<span style="color:#f59e0b">!</span>'; color = '#f59e0b'; }
          else { icon = '<span style="color:#94A3B8">i</span>'; color = '#94A3B8'; }
          return '<div style="display:flex;align-items:flex-start;gap:8px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.04)">'
            + '<span style="font-size:11px;color:#475569;min-width:72px;flex-shrink:0">' + dateStr + '<br>' + timeStr + '</span>'
            + '<span style="font-size:13px">' + icon + '</span>'
            + '<div style="flex:1;min-width:0">'
            + '<div style="font-size:13px;color:' + color + ';text-transform:capitalize">' + escapeHtml(item.type) + '</div>'
            + (item.detail ? '<div style="font-size:11px;color:#64748B;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtml(item.detail) + '</div>' : '')
            + '</div></div>';
        }).join('');
      } catch (e) {
        body.innerHTML = '<div style="color:#475569;text-align:center;padding:16px;font-size:13px">Unable to load activity feed</div>';
      }
    }

    // ── Auto-refresh polling ─────────────────────────────────────────────────
    var _overviewPollTimer = null;
    var OVERVIEW_POLL_MS = 15000;

    function startOverviewPoll() {
      stopOverviewPoll();
      _overviewPollTimer = setInterval(refreshOverviewData, OVERVIEW_POLL_MS);
    }
    function stopOverviewPoll() {
      if (_overviewPollTimer) { clearInterval(_overviewPollTimer); _overviewPollTimer = null; }
    }

    async function refreshOverviewData() {
      try {
        var d = await api('GET', '/api/church/me');
        var status = d.status || {};
        var enc = (status.encoder && typeof status.encoder === 'object') ? status.encoder : {};
        var audioViaAtem = !!(d.audio_via_atem);

        // Connection status
        var statusText = document.getElementById('stat-status-text');
        var statusDot = document.getElementById('stat-status-dot');
        if (statusText) { statusText.textContent = d.connected ? 'Online' : 'Offline'; statusText.style.color = d.connected ? '#22c55e' : '#94A3B8'; }
        if (statusDot) { statusDot.style.background = d.connected ? '#22c55e' : '#ef4444'; }

        // Staleness
        var stalenessEl = document.getElementById('equip-staleness');
        if (stalenessEl && d.lastSeen) {
          var ago = Math.round((Date.now() - new Date(d.lastSeen).getTime()) / 1000);
          if (ago < 60) stalenessEl.textContent = 'Updated just now';
          else if (ago < 3600) stalenessEl.textContent = 'Updated ' + Math.round(ago / 60) + 'm ago';
          else stalenessEl.textContent = 'Updated ' + Math.round(ago / 3600) + 'h ago';
          stalenessEl.style.color = ago > 300 ? '#f59e0b' : '#475569';
        }

        // Cards
        updateStreamStats(status, enc);
        updateAtemDetailCard(status);
        updateAudioHealthCard(status, audioViaAtem);
        loadRundown();
        loadIncidents();
        loadActivityFeed();
      } catch (e) { /* silent fail on poll */ }
    }

    document.addEventListener('visibilitychange', function() {
      if (document.hidden) { stopOverviewPoll(); }
      else {
        var overviewPage = document.getElementById('page-overview');
        if (overviewPage && overviewPage.classList.contains('active')) startOverviewPoll();
      }
    });

    function fmt12(hhmm) {
      var mins = toMinutes(hhmm);
      if (mins === null) return hhmm || '';
      var h = Math.floor(mins / 60);
      var m = mins % 60;
      var ampm = h < 12 ? 'AM' : 'PM';
      var h12 = h === 0 ? 12 : (h > 12 ? h - 12 : h);
      return h12 + ':' + pad2(m) + ' ' + ampm;
    }

    async function loadScheduleOverview() {
      var body = document.getElementById('schedule-overview-body');
      if (!body) return;
      try {
        var raw = await api('GET', '/api/church/schedule');
        var sched = normalizeSchedulePayload(raw);
        var html = '';
        var hasAny = false;
        SCHEDULE_DAYS.forEach(function(day) {
          var entries = sched[day] || [];
          if (!entries.length) return;
          hasAny = true;
          html += '<div class="schedule-overview-day">';
          html += '<div class="schedule-day-label">' + SCHEDULE_DAY_LABELS[day] + '</div>';
          entries.forEach(function(e) {
            html += '<span class="schedule-window">';
            html += '<span class="sw-time">' + fmt12(e.start) + ' – ' + fmt12(e.end) + '</span>';
            if (e.label) html += '<span class="sw-label">' + escapeHtml(e.label) + '</span>';
            html += '</span>';
          });
          html += '</div>';
        });
        if (!hasAny) {
          body.innerHTML = '<span style="color:#475569">No service windows configured. <a href="#" style="color:#22c55e;text-decoration:none" onclick="event.preventDefault();showPage(\'schedule\', document.querySelector(\'[data-page=schedule]\'))">Set up your schedule →</a></span>';
        } else {
          body.innerHTML = html;
        }
      } catch(e) {
        body.innerHTML = '<span style="color:#475569">Unable to load schedule</span>';
      }
    }

    // ── Live Incident Commander ──────────────────────────────────────────

    async function loadIncidents() {
      var card = document.getElementById('incident-card');
      var body = document.getElementById('incident-body');
      var durationEl = document.getElementById('incident-duration');
      var metaEl = document.getElementById('incident-meta');
      var dot = document.getElementById('incident-status-dot');
      if (!card) return;

      try {
        var data = await api('GET', '/api/church/session/active');
        if (!data || !data.active) {
          card.style.display = 'none';
          return;
        }

        card.style.display = '';
        var session = data;

        // Duration
        var startMs = new Date(session.startedAt).getTime();
        var durMin = Math.round((Date.now() - startMs) / 60000);
        var durH = Math.floor(durMin / 60);
        var durM = durMin % 60;
        if (durationEl) durationEl.textContent = durH > 0 ? durH + 'h ' + durM + 'm' : durM + 'm';

        // Meta line
        var parts = [];
        if (session.tdName) parts.push('TD: ' + session.tdName);
        if (session.streaming) parts.push('<span style="color:#ef4444">&#9679;</span> Streaming');
        if (session.peakViewers !== null) parts.push(session.peakViewers + ' peak viewers');
        if (metaEl) metaEl.textContent = parts.join(' · ');

        // Status dot color: green=clean, yellow=minor, red=escalated
        if (dot) {
          if (session.escalated > 0) { dot.style.background = '#ef4444'; }
          else if (session.alertCount > 0) { dot.style.background = '#f59e0b'; }
          else { dot.style.background = '#22c55e'; }
        }

        // Events for this session
        var events = data.events || [];
        if (!events.length && session.alertCount === 0) {
          body.innerHTML = '<div style="color:#22c55e;font-size:13px;padding:8px 0">No issues — smooth sailing</div>';
          return;
        }

        var html = events.map(function(e) {
          var t = new Date(e.timestamp);
          var time = t.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
          var type = (e.event_type || '').replace(/_/g, ' ');
          var detail = e.details ? ' — ' + escapeHtml(typeof e.details === 'string' ? e.details.slice(0, 80) : '') : '';

          var icon, statusLine;
          if (e.auto_resolved) {
            icon = '<span style="font-size:10px;font-weight:700;color:#22c55e">AI</span>';
            statusLine = '<span style="color:#22c55e;font-size:11px;margin-left:8px">(auto-fixed)</span>';
          } else if (e.resolved) {
            icon = '<span style="color:#22c55e">&#10003;</span>';
            statusLine = '<span style="color:#22c55e;font-size:11px;margin-left:8px">(resolved)</span>';
          } else {
            icon = '<span style="color:#f59e0b">!</span>';
            statusLine = '<span style="color:#f59e0b;font-size:11px;margin-left:8px">(active)</span>';
          }

          // Diagnosis info if available
          var diagHtml = '';
          if (e.diagnosis) {
            var confPct = e.diagnosis.confidence ? ' (' + e.diagnosis.confidence + '%)' : '';
            diagHtml = '<div style="font-size:11px;color:#64748b;margin-top:2px;margin-left:28px">'
              + 'Likely: ' + escapeHtml(e.diagnosis.likely_cause || '') + confPct
              + '</div>';
          }

          return '<div style="padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.04)">'
            + '<div style="display:flex;align-items:center;gap:8px">'
            + '<span style="font-size:11px;color:#64748b;min-width:60px">' + time + '</span>'
            + '<span>' + icon + '</span>'
            + '<span style="color:#F8FAFC;font-size:13px">' + escapeHtml(type) + '</span>'
            + statusLine
            + '</div>'
            + (detail ? '<div style="font-size:12px;color:#94A3B8;margin-left:28px">' + detail + '</div>' : '')
            + diagHtml
            + '</div>';
        }).join('');

        if (!html) html = '<div style="color:#22c55e;font-size:13px;padding:8px 0">No incidents recorded yet</div>';
        body.innerHTML = html;
      } catch(e) {
        card.style.display = 'none';
      }
    }

    // ── Pre-Service Check ────────────────────────────────────────────────

    async function loadPreServiceCheck() {
      var body = document.getElementById('psc-dash-body');
      var badge = document.getElementById('psc-dash-badge');
      var timeEl = document.getElementById('psc-dash-time');
      if (!body) return;

      try {
        var data = await api('GET', '/api/church/preservice-check');
        if (!data || !data.checks_json) {
          body.innerHTML = '<div style="color:#475569;text-align:center;padding:14px;font-size:13px">No check data yet — click <strong>Run Check Now</strong> or wait for the automatic check 30 min before your next service.</div>';
          if (badge) { badge.textContent = 'Not Run'; badge.className = 'badge badge-gray'; }
          return;
        }

        var checks = [];
        try { checks = JSON.parse(data.checks_json || '[]'); } catch {}

        // Show relative time
        if (data.created_at && timeEl) {
          var ago = Math.round((Date.now() - new Date(data.created_at).getTime()) / 60000);
          var agoStr = ago < 1 ? 'just now' : ago < 60 ? ago + ' min ago' : ago < 1440 ? Math.round(ago / 60) + 'h ago' : Math.round(ago / 1440) + 'd ago';
          timeEl.textContent = 'Last run ' + agoStr + (data.trigger_type === 'manual' ? ' · manual' : ' · automatic');
        }

        var passCount = checks.filter(function(c) { return c.pass; }).length;
        var failCount = checks.length - passCount;
        var allPass = failCount === 0;

        if (badge) {
          badge.textContent = allPass ? 'All Clear' : failCount + ' Issue' + (failCount !== 1 ? 's' : '');
          badge.className = allPass ? 'badge badge-green' : 'badge badge-yellow';
        }

        // Two-column grid of checks
        var html = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:6px">';
        html += checks.map(function(c) {
          var icon = c.pass ? '\u2713' : '!';
          var borderColor = c.pass ? '#16a34a' : '#d97706';
          var bg = c.pass ? 'rgba(34,197,94,0.05)' : 'rgba(245,158,11,0.08)';
          var detail = c.detail ? '<div style="color:#64748b;font-size:11px;margin-top:3px;line-height:1.4">' + escapeHtml(c.detail) + '</div>' : '';
          return '<div style="padding:8px 10px;border-radius:6px;border:1px solid ' + borderColor + ';background:' + bg + '">'
            + '<div style="display:flex;align-items:center;gap:6px;font-size:13px">'
            + '<span>' + icon + '</span><span style="font-weight:500">' + escapeHtml(c.name || 'Check') + '</span>'
            + '</div>' + detail + '</div>';
        }).join('');
        html += '</div>';

        body.innerHTML = html;

        // Show fix-all button if there are auto-fixable failures
        var FIXABLE_CHECKS = ['Main Output'];
        var fixableFailures = checks.filter(function(c) { return !c.pass && FIXABLE_CHECKS.indexOf(c.name) !== -1; });
        var fixBtn = document.getElementById('psc-dash-fix-btn');
        if (fixBtn) {
          fixBtn.style.display = fixableFailures.length > 0 ? '' : 'none';
          fixBtn.textContent = 'Fix ' + fixableFailures.length + ' Safe Issue' + (fixableFailures.length !== 1 ? 's' : '');
        }
      } catch(e) {
        if (body) body.innerHTML = '<div style="color:#475569;text-align:center;padding:14px;font-size:13px">No check data yet — click <strong>Run Check Now</strong> to start.</div>';
        if (badge) { badge.textContent = 'Not Run'; badge.className = 'badge badge-gray'; }
      }
    }

    async function runPreServiceCheck() {
      var body = document.getElementById('psc-dash-body');
      var badge = document.getElementById('psc-dash-badge');
      if (badge) { badge.textContent = 'Running…'; badge.className = 'badge badge-gray'; }
      if (body) body.innerHTML = '<div style="color:#94A3B8;text-align:center;padding:14px;font-size:13px">Running system check…</div>';

      try {
        var data = await api('POST', '/api/church/preservice-check/run');
        if (data && data.result) {
          await loadPreServiceCheck();
        } else {
          if (body) body.innerHTML = '<div style="color:#f59e0b;text-align:center;padding:14px;font-size:13px">Could not run check — is the Tally app connected?</div>';
          if (badge) { badge.textContent = 'Offline'; badge.className = 'badge badge-yellow'; }
        }
      } catch(e) {
        if (body) body.innerHTML = '<div style="color:#ef4444;text-align:center;padding:14px;font-size:13px">Error running check: ' + escapeHtml(e.message || 'unknown') + '</div>';
        if (badge) { badge.textContent = 'Error'; badge.className = 'badge badge-red'; }
      }
    }

    async function fixAllPreServiceIssues() {
      var btn = document.getElementById('psc-dash-fix-btn');
      if (btn) { btn.disabled = true; btn.textContent = 'Fixing…'; }
      try {
        var data = await api('POST', '/api/church/preservice-check/fix-all');
        if (data && data.results) {
          var fixed = data.results.filter(function(r) { return r.success; }).length;
          var failed = data.results.length - fixed;
          toast(fixed + ' issue' + (fixed !== 1 ? 's' : '') + ' fixed' + (failed > 0 ? ', ' + failed + ' could not be fixed' : ''));
        } else {
          toast('No fixable issues or client offline', true);
        }
        await new Promise(function(r) { setTimeout(r, 2000); });
        await runPreServiceCheck();
      } catch(e) {
        toast('Fix error: ' + (e.message || 'unknown'), true);
      } finally {
        if (btn) { btn.disabled = false; }
        await loadPreServiceCheck();
      }
    }

    // ── Tally Engineer: card rendering ────────────────────────────────────────

    async function loadProblems() {
      var body = document.getElementById('pf-body');
      var badge = document.getElementById('pf-badge');
      if (!body) return;
      try {
        var data = await api('GET', '/api/church/problems');
        renderProblems(data, body, badge);
      } catch(e) {
        body.innerHTML = '<div style="color:#475569;text-align:center;padding:20px;font-size:13px">No diagnostics data yet — connect the Tally desktop app to see results.</div>';
        if (badge) { badge.className = 'badge badge-gray'; badge.textContent = '—'; }
      }
    }

    function renderProblems(data, body, badge) {
      if (!data || !data.status) {
        body.innerHTML = '<div style="color:#475569;text-align:center;padding:20px;font-size:13px">No diagnostics data yet — connect the Tally desktop app to see results.</div>';
        if (badge) { badge.className = 'badge badge-gray'; badge.textContent = '—'; }
        return;
      }

      // Badge
      if (badge) {
        if (data.status === 'GO') {
          badge.className = 'badge badge-green';
          badge.textContent = 'GO';
        } else {
          badge.className = 'badge badge-red';
          badge.textContent = 'NO GO';
        }
      }

      var html = '';

      // Timestamp + coverage
      html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;font-size:12px;color:#64748B">';
      html += '<span>Last scan: ' + (data.created_at ? new Date(data.created_at).toLocaleString() : '—') + '</span>';
      if (data.coverage_score !== undefined) {
        html += '<span>Coverage: ' + Math.min(100, Math.round(data.coverage_score * 100)) + '%</span>';
      }
      html += '</div>';

      // Section: What Tally Found
      var issues = [];
      try { issues = JSON.parse(data.issues_json || '[]'); } catch {}
      html += '<div style="margin-bottom:16px">';
      html += '<div style="font-size:12px;font-weight:600;color:#94A3B8;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">What Tally Found</div>';
      if (issues.length === 0) {
        html += '<div style="color:#22c55e;font-size:13px">✓ No issues detected</div>';
      } else {
        var sevCounts = { critical: 0, high: 0, medium: 0, low: 0 };
        issues.forEach(function(i) { if (sevCounts[i.severity] !== undefined) sevCounts[i.severity]++; });
        html += '<div style="display:flex;gap:12px;flex-wrap:wrap">';
        if (sevCounts.critical > 0) html += '<span class="badge badge-red">' + sevCounts.critical + ' Critical</span>';
        if (sevCounts.high > 0) html += '<span class="badge badge-red">' + sevCounts.high + ' High</span>';
        if (sevCounts.medium > 0) html += '<span class="badge badge-yellow">' + sevCounts.medium + ' Medium</span>';
        if (sevCounts.low > 0) html += '<span class="badge badge-gray">' + sevCounts.low + ' Low</span>';
        html += '</div>';
      }
      html += '</div>';

      // Section: What Tally Fixed
      var autoFixed = [];
      try { autoFixed = JSON.parse(data.auto_fixed_json || '[]'); } catch {}
      html += '<div style="margin-bottom:16px">';
      html += '<div style="font-size:12px;font-weight:600;color:#94A3B8;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">What Tally Fixed</div>';
      if (autoFixed.length === 0 && data.auto_fixed_count === 0) {
        html += '<div style="color:#64748B;font-size:13px">No auto-fixes applied</div>';
      } else {
        if (autoFixed.length > 0) {
          autoFixed.forEach(function(f) {
            html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;font-size:13px">';
            html += '<span style="color:#22c55e">✓</span>';
            html += '<span style="color:#F8FAFC">' + escapeHtml(f.title || f.id) + '</span>';
            html += '</div>';
          });
        } else {
          html += '<div style="color:#22c55e;font-size:13px">✓ ' + data.auto_fixed_count + ' item(s) auto-resolved</div>';
        }
      }
      html += '</div>';

      // Section: Needs TD Attention
      var needsAttention = [];
      try { needsAttention = JSON.parse(data.needs_attention_json || '[]'); } catch {}
      html += '<div style="margin-bottom:16px">';
      html += '<div style="font-size:12px;font-weight:600;color:#94A3B8;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">Needs TD Attention</div>';
      if (needsAttention.length === 0 && data.blocker_count === 0) {
        html += '<div style="color:#22c55e;font-size:13px">✓ Nothing needs attention</div>';
      } else {
        needsAttention.forEach(function(item) {
          var sevCls = item.severity === 'critical' ? 'badge-red' : 'badge-yellow';
          html += '<div style="background:rgba(15,22,19,0.5);border:1px solid #1a2e1f;border-radius:8px;padding:12px;margin-bottom:8px">';
          html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">';
          html += '<span class="badge ' + sevCls + '">' + (item.severity || 'high') + '</span>';
          html += '<span style="font-size:13px;font-weight:600;color:#F8FAFC">' + escapeHtml(item.title || item.id) + '</span>';
          html += '</div>';
          if (item.symptom) {
            html += '<div style="font-size:12px;color:#94A3B8;margin-bottom:4px">' + escapeHtml(item.symptom) + '</div>';
          }
          if (item.fixStep) {
            html += '<div style="font-size:12px;color:#22c55e">→ ' + escapeHtml(item.fixStep) + '</div>';
          }
          html += '</div>';
        });
      }
      html += '</div>';

      // Section: Recommended Actions
      var topActions = [];
      try { topActions = JSON.parse(data.top_actions_json || '[]'); } catch {}
      if (topActions.length > 0) {
        html += '<div>';
        html += '<div style="font-size:12px;font-weight:600;color:#94A3B8;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">Recommended Actions</div>';
        topActions.forEach(function(action, idx) {
          html += '<div style="display:flex;gap:8px;margin-bottom:4px;font-size:13px;color:#F8FAFC">';
          html += '<span style="color:#22c55e;font-weight:700">' + (idx + 1) + '.</span>';
          html += '<span>' + escapeHtml(typeof action === 'string' ? action : (action.step || action.title || '')) + '</span>';
          html += '</div>';
        });
        html += '</div>';
      }

      body.innerHTML = html;
    }

    function renderOnboarding(d) {
      const container = document.getElementById('onboarding-checklist');
      const itemsEl = document.getElementById('onboarding-items');
      const resumeEl = document.getElementById('onboarding-resume');
      if (!container || !itemsEl) return;

      onboardingRegCode = d.registration_code || '';

      const steps = [
        {
          key: 'device',
          done: !!d.onboarding_app_connected_at,
          label: pt('onboarding.step.device.label'),
          detail: pt('onboarding.step.device.detail'),
          action: '<a href="/download" target="_blank" class="onboard-action-btn">' + pt('onboarding.step.device.btn') + '</a>',
        },
        {
          key: 'telegram',
          done: !!d.onboarding_telegram_registered_at,
          label: pt('onboarding.step.telegram.label'),
          detail: pt('onboarding.step.telegram.detail', { code: escapeHtml(d.registration_code || 'CODE') }),
          action: '<span class="onboard-action-btn" onclick="copyOnboardingCode()"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" width="14" height="14" aria-hidden="true" style="vertical-align:middle;margin-right:4px"><path fill-rule="evenodd" d="M4 2a1.5 1.5 0 0 1 1.5-1.5h5A1.5 1.5 0 0 1 12 2v1.5a1.5 1.5 0 0 1-1.5 1.5h-5A1.5 1.5 0 0 1 4 3.5V2ZM3 4.5A1.5 1.5 0 0 0 1.5 6v7A1.5 1.5 0 0 0 3 14.5h10a1.5 1.5 0 0 0 1.5-1.5V6A1.5 1.5 0 0 0 13 4.5H3Z" clip-rule="evenodd"/></svg> ' + pt('onboarding.step.telegram.copy') + '</span> <a href="https://t.me/TallyConnectBot" target="_blank" class="onboard-action-btn"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" width="16" height="16" aria-hidden="true"><path fill-rule="evenodd" d="M2.5 3A1.5 1.5 0 0 0 1 4.5v6A1.5 1.5 0 0 0 2.5 12H4v2.25a.75.75 0 0 0 1.28.53L7.56 12H13.5A1.5 1.5 0 0 0 15 10.5v-6A1.5 1.5 0 0 0 13.5 3h-11Z" clip-rule="evenodd"/></svg> ' + pt('onboarding.step.telegram.open') + '</a>',
        },
        {
          key: 'failover',
          done: !!d.onboarding_failover_tested_at,
          label: pt('onboarding.step.failover.label'),
          detail: pt('onboarding.step.failover.detail'),
          action: '<span class="onboard-action-btn" onclick="markFailoverTested()" id="failover-test-btn">' + pt('onboarding.step.failover.btn') + '</span>',
        },
        {
          key: 'team',
          done: !!d.onboarding_team_invited_at,
          label: pt('onboarding.step.team.label'),
          detail: pt('onboarding.step.team.detail'),
          action: '<span class="onboard-action-btn" onclick="inviteTeam()"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" width="14" height="14" aria-hidden="true" style="vertical-align:middle;margin-right:4px"><path d="M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM12.735 14c.618 0 1.093-.561.872-1.139a6.002 6.002 0 0 0-11.215 0c-.22.578.254 1.139.872 1.139h9.47Z"/><path d="M2 5.5a2 2 0 1 1 4 0 2 2 0 0 1-4 0ZM2.5 14h-1a1 1 0 0 1-.897-1.447A4.5 4.5 0 0 1 4.5 10.5c.66 0 1.287.144 1.851.402C5.21 11.76 4.828 13.073 5.02 14H2.5ZM12 7.5a2 2 0 1 1 0-4 2 2 0 0 1 0 4ZM13.5 14h-2.52c.192-.927-.19-2.24-.831-3.098A4.472 4.472 0 0 1 11.5 10.5a4.5 4.5 0 0 1 4.897 3.053A1 1 0 0 1 15.5 14h-2Z"/></svg> ' + pt('onboarding.step.team.btn') + '</span>',
        },
      ];

      const completed = steps.filter(s => s.done).length;
      const allDone = completed >= steps.length;

      // Show celebration banner when all steps complete
      if (allDone) {
        container.style.display = 'block';
        container.style.animation = 'none';
        container.style.borderColor = '#22c55e';
        itemsEl.innerHTML = '<div style="text-align:center;padding:16px 0"><div style="font-size:28px;margin-bottom:8px;animation:onboardCheckPop 0.5s ease-out">&#9733;</div><div style="font-size:15px;font-weight:700;color:#22c55e">' + pt('onboarding.complete') + '</div><div style="font-size:12px;color:#94A3B8;margin-top:4px">' + pt('onboarding.complete.sub') + '</div></div>';
        if (resumeEl) resumeEl.style.display = 'none';
        setTimeout(function() { container.style.display = 'none'; }, 5000);
        return;
      }

      // Show resume link if dismissed but not complete
      if (d.onboarding_dismissed) {
        container.style.display = 'none';
        if (resumeEl) resumeEl.style.display = 'block';
        return;
      }

      // Show checklist
      if (resumeEl) resumeEl.style.display = 'none';
      container.style.display = 'block';
      container.style.animation = completed < 2 ? 'onboardPulse 3s ease-in-out infinite, onboardSlideIn 0.4s ease-out' : 'onboardSlideIn 0.4s ease-out';
      document.getElementById('onboarding-progress-text').textContent = pt('onboarding.progress', { done: completed, total: steps.length });

      itemsEl.innerHTML = steps.map((s, i) => {
        const icon = s.done
          ? '<div style="width:24px;height:24px;border-radius:50%;background:#22c55e;display:flex;align-items:center;justify-content:center;color:#000;font-size:13px;font-weight:700;flex-shrink:0;animation:onboardCheckPop 0.4s ease-out">✓</div>'
          : '<div style="width:24px;height:24px;border-radius:50%;border:2px solid #334155;display:flex;align-items:center;justify-content:center;color:#64748B;font-size:12px;font-weight:700;flex-shrink:0;">' + (i + 1) + '</div>';
        var actionHtml = (!s.done && s.action) ? '<div style="margin-top:4px">' + s.action + '</div>' : '';
        return '<div style="display:flex;align-items:flex-start;gap:12px;padding:10px 0;' + (i < steps.length - 1 ? 'border-bottom:1px solid #1a2e1f;' : '') + '">'
          + icon
          + '<div style="flex:1">'
          + '<div style="font-size:13px;font-weight:600;color:' + (s.done ? '#22c55e' : '#F8FAFC') + ';">' + s.label + '</div>'
          + (s.done ? '' : '<div style="font-size:12px;color:#64748B;margin-top:2px;">' + s.detail + '</div>')
          + actionHtml
          + '</div>'
          + '</div>';
      }).join('');
    }

    var onboardingRegCode = '';

    function copyOnboardingCode() {
      if (!onboardingRegCode) { toast('No registration code available', true); return; }
      navigator.clipboard.writeText('/register ' + onboardingRegCode).then(function() { toast('Copied: /register ' + onboardingRegCode); }).catch(function() { toast('Code: /register ' + onboardingRegCode); });
    }

    function showAtemTip() {
      toast('Ensure your ATEM and booth computer are on the same network subnet. The app scans automatically.');
    }

    async function markFailoverTested() {
      const btn = document.getElementById('failover-test-btn');
      if (btn) { btn.textContent = 'Recording…'; btn.style.pointerEvents = 'none'; }
      try {
        await api('POST', '/api/church/onboarding/failover-tested');
        toast('Test failover recorded! Step 3 complete.');
        loadOverview();
      } catch (e) {
        toast('Could not record test — please try again', true);
        if (btn) { btn.textContent = 'Run Test'; btn.style.pointerEvents = ''; }
      }
    }

    async function inviteTeam() {
      if (!onboardingRegCode) { toast('No registration code available', true); return; }
      const msg = 'Join me on Tally! Send this to @TallyConnectBot on Telegram: /register ' + onboardingRegCode;
      try {
        await navigator.clipboard.writeText(msg);
        toast('Invite message copied to clipboard!');
      } catch {
        toast('Share this code: /register ' + onboardingRegCode);
      }
      // Mark team-invited step done
      try {
        await api('POST', '/api/church/onboarding/team-invited');
        loadOverview();
      } catch { /* non-critical */ }
    }

    async function dismissOnboarding() {
      try {
        await api('POST', '/api/church/onboarding/dismiss');
        document.getElementById('onboarding-checklist').style.display = 'none';
        var resumeEl = document.getElementById('onboarding-resume');
        if (resumeEl) resumeEl.style.display = 'block';
      } catch(e) { console.error('Dismiss failed:', e); }
    }

    async function undismissOnboarding() {
      try {
        await api('POST', '/api/church/onboarding/undismiss');
        var resumeEl = document.getElementById('onboarding-resume');
        if (resumeEl) resumeEl.style.display = 'none';
        // Reload overview to re-render onboarding
        loadOverview();
      } catch(e) { toast('Failed to restore setup guide', true); }
    }

    // ── Equipment ──────────────────────────────────────────────────────────────
    var _equipmentLoaded = false;
    var _equipmentRoomId = null; // tracks which room_id the equipment belongs to

    function _populateEquipmentForm(eq, updatedAt) {
      document.getElementById('eq-atem-ip').value = eq.atemIp || '';
      document.getElementById('eq-obs-url').value = eq.obsUrl || '';
      document.getElementById('eq-obs-password').value = eq.obsPassword || '';
      var mixer = eq.mixer || {};
      document.getElementById('eq-mixer-type').value = mixer.type || '';
      document.getElementById('eq-mixer-host').value = mixer.host || '';
      document.getElementById('eq-mixer-port').value = mixer.port || '';
      document.getElementById('eq-audio-via-atem').checked = !!eq.audioViaAtem;
      document.getElementById('eq-encoder-type').value = eq.encoderType || '';
      document.getElementById('eq-encoder-host').value = eq.encoderHost || '';
      document.getElementById('eq-encoder-port').value = eq.encoderPort || '';
      document.getElementById('eq-rtmp-url').value = eq.rtmpUrl || '';
      document.getElementById('eq-companion-url').value = eq.companionUrl || '';
      var pp = eq.proPresenter || {};
      document.getElementById('eq-propresenter-host').value = pp.host || '';
      document.getElementById('eq-propresenter-port').value = pp.port || '';
      var vmix = eq.vmix || {};
      document.getElementById('eq-vmix-host').value = vmix.host || '';
      document.getElementById('eq-vmix-port').value = vmix.port || '';
      var res = eq.resolume || {};
      document.getElementById('eq-resolume-host').value = res.host || '';
      document.getElementById('eq-resolume-port').value = res.port || '';
      renderEquipmentList('ptz', eq.ptz || []);
      renderEquipmentList('hyperdeck', eq.hyperdecks || []);
      renderEquipmentList('videohub', eq.videoHubs || []);
      var status = document.getElementById('equipment-save-status');
      if (status) status.textContent = updatedAt ? 'Last saved: ' + new Date(updatedAt).toLocaleString() : '';
    }

    async function loadEquipment() {
      if (_equipmentLoaded) return;
      try {
        var d = await api('GET', '/api/church/config/equipment');
        _equipmentRoomId = d.roomId || null;

        // Populate room selector if rooms exist
        var sel = document.getElementById('eq-room-selector');
        var wrap = document.getElementById('eq-room-selector-wrap');
        var rooms = d.rooms || [];
        if (rooms.length > 0) {
          sel.innerHTML = '';
          // Add default option for churches that saved config without a room
          if (_equipmentRoomId && !rooms.some(function(r) { return r.id === _equipmentRoomId; })) {
            var defOpt = document.createElement('option');
            defOpt.value = _equipmentRoomId;
            defOpt.textContent = 'Default';
            sel.appendChild(defOpt);
          }
          rooms.forEach(function(r) {
            var opt = document.createElement('option');
            opt.value = r.id;
            opt.textContent = r.name + (r.hasConfig ? '' : ' (no config)');
            sel.appendChild(opt);
          });
          if (_equipmentRoomId) sel.value = _equipmentRoomId;
          wrap.style.display = '';
        }

        _populateEquipmentForm(d.equipment || {}, d.updatedAt);
        document.getElementById('equipment-loading').style.display = 'none';
        document.getElementById('equipment-form').style.display = '';
        _equipmentLoaded = true;
      } catch (e) {
        document.getElementById('equipment-loading').textContent = 'Failed to load equipment config.';
        toast('Failed to load equipment: ' + e.message, true);
      }
    }

    async function loadEquipmentForRoom(roomId) {
      try {
        document.getElementById('equipment-form').style.display = 'none';
        document.getElementById('equipment-loading').style.display = '';
        document.getElementById('equipment-loading').textContent = 'Loading equipment…';
        var d = await api('GET', '/api/church/config/equipment?roomId=' + encodeURIComponent(roomId));
        _equipmentRoomId = roomId;
        _populateEquipmentForm(d.equipment || {}, d.updatedAt);
        document.getElementById('equipment-loading').style.display = 'none';
        document.getElementById('equipment-form').style.display = '';
      } catch (e) {
        document.getElementById('equipment-loading').textContent = 'Failed to load equipment.';
        toast('Failed to load equipment: ' + e.message, true);
      }
    }

    function renderEquipmentList(type, items) {
      var container = document.getElementById('eq-' + type + '-list');
      container.innerHTML = '';
      if (!items || !items.length) return;
      items.forEach(function(item, i) {
        addEquipmentRowHtml(type, item);
      });
    }

    function addEquipmentRow(type) {
      addEquipmentRowHtml(type, {});
    }

    function addEquipmentRowHtml(type, item) {
      var container = document.getElementById('eq-' + type + '-list');
      var row = document.createElement('div');
      row.className = 'eq-device-row';
      row.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:6px';
      if (type === 'ptz') {
        row.innerHTML =
          '<input type="text" class="eq-ptz-name" placeholder="Camera name" value="' + _escAttr(item.name || '') + '" style="flex:1">' +
          '<input type="text" class="eq-ptz-ip" placeholder="IP address" value="' + _escAttr(item.ip || item.host || '') + '" style="flex:1">' +
          '<select class="eq-ptz-protocol" style="flex:0 0 120px">' +
            '<option value="visca"' + (item.protocol === 'visca' ? ' selected' : '') + '>VISCA</option>' +
            '<option value="visca-over-ip"' + (item.protocol === 'visca-over-ip' ? ' selected' : '') + '>VISCA/IP</option>' +
            '<option value="onvif"' + (item.protocol === 'onvif' ? ' selected' : '') + '>ONVIF</option>' +
          '</select>' +
          '<input type="number" class="eq-ptz-port" placeholder="Port" value="' + (item.port || '') + '" style="flex:0 0 80px" min="1" max="65535">' +
          '<button class="btn-secondary" style="flex:0 0 auto;padding:4px 8px;font-size:11px" onclick="this.parentElement.remove()">✕</button>';
      } else {
        // HyperDeck or VideoHub — just name + IP
        row.innerHTML =
          '<input type="text" class="eq-' + type + '-name" placeholder="Name" value="' + _escAttr(item.name || item.label || '') + '" style="flex:1">' +
          '<input type="text" class="eq-' + type + '-ip" placeholder="IP address" value="' + _escAttr(item.ip || item.host || '') + '" style="flex:1">' +
          '<button class="btn-secondary" style="flex:0 0 auto;padding:4px 8px;font-size:11px" onclick="this.parentElement.remove()">✕</button>';
      }
      container.appendChild(row);
    }

    function _escAttr(s) { return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }

    function collectEquipmentList(type) {
      var container = document.getElementById('eq-' + type + '-list');
      var rows = container.querySelectorAll('.eq-device-row');
      var result = [];
      rows.forEach(function(row) {
        if (type === 'ptz') {
          var name = row.querySelector('.eq-ptz-name').value.trim();
          var ip = row.querySelector('.eq-ptz-ip').value.trim();
          var protocol = row.querySelector('.eq-ptz-protocol').value;
          var port = parseInt(row.querySelector('.eq-ptz-port').value, 10) || 0;
          if (ip) result.push({ name: name, ip: ip, protocol: protocol, port: port || undefined });
        } else {
          var n = row.querySelector('.eq-' + type + '-name').value.trim();
          var addr = row.querySelector('.eq-' + type + '-ip').value.trim();
          if (addr) result.push({ name: n, ip: addr });
        }
      });
      return result;
    }

    async function saveEquipment() {
      var btn = document.getElementById('btn-save-equipment');
      var status = document.getElementById('equipment-save-status');
      btn.disabled = true;
      status.textContent = 'Saving…';
      status.style.color = '#475569';
      try {
        var equipment = {
          atemIp: document.getElementById('eq-atem-ip').value.trim(),
          obsUrl: document.getElementById('eq-obs-url').value.trim(),
          obsPassword: document.getElementById('eq-obs-password').value.trim(),
          companionUrl: document.getElementById('eq-companion-url').value.trim(),
          audioViaAtem: document.getElementById('eq-audio-via-atem').checked,
          rtmpUrl: document.getElementById('eq-rtmp-url').value.trim(),
          encoderType: document.getElementById('eq-encoder-type').value,
          encoderHost: document.getElementById('eq-encoder-host').value.trim(),
          encoderPort: parseInt(document.getElementById('eq-encoder-port').value, 10) || undefined,
          mixer: {
            type: document.getElementById('eq-mixer-type').value,
            host: document.getElementById('eq-mixer-host').value.trim(),
            port: parseInt(document.getElementById('eq-mixer-port').value, 10) || undefined,
          },
          proPresenter: {
            host: document.getElementById('eq-propresenter-host').value.trim(),
            port: parseInt(document.getElementById('eq-propresenter-port').value, 10) || undefined,
          },
          vmix: {
            host: document.getElementById('eq-vmix-host').value.trim(),
            port: parseInt(document.getElementById('eq-vmix-port').value, 10) || undefined,
          },
          resolume: {
            host: document.getElementById('eq-resolume-host').value.trim(),
            port: parseInt(document.getElementById('eq-resolume-port').value, 10) || undefined,
          },
          ptz: collectEquipmentList('ptz'),
          hyperdecks: collectEquipmentList('hyperdeck'),
          videoHubs: collectEquipmentList('videohub'),
        };

        // Clean up empty nested objects
        if (!equipment.mixer.type && !equipment.mixer.host) equipment.mixer = undefined;
        if (!equipment.proPresenter.host) equipment.proPresenter = undefined;
        if (!equipment.vmix.host) equipment.vmix = undefined;
        if (!equipment.resolume.host) equipment.resolume = undefined;
        if (!equipment.ptz.length) equipment.ptz = undefined;
        if (!equipment.hyperdecks.length) equipment.hyperdecks = undefined;
        if (!equipment.videoHubs.length) equipment.videoHubs = undefined;

        var d = await api('PUT', '/api/church/config/equipment', { equipment: equipment, roomId: _equipmentRoomId });
        status.textContent = 'Saved! ' + new Date(d.updatedAt).toLocaleString();
        status.style.color = '#22c55e';
        toast('Equipment config saved');
      } catch (e) {
        status.textContent = 'Save failed';
        status.style.color = '#ef4444';
        toast('Failed to save: ' + e.message, true);
      } finally {
        btn.disabled = false;
      }
    }

    // ── Profile ─────────────────────────────────────────────────────────────────
    async function loadProfile() {
      try {
        const d = await api('GET', '/api/church/me');
        profileData = d;
        document.getElementById('profile-name').value = d.name || '';
        document.getElementById('profile-email').value = d.email || '';
        document.getElementById('profile-phone').value = d.phone || '';
        document.getElementById('profile-location').value = d.location || '';
        document.getElementById('profile-notes').value = d.notes || '';
        document.getElementById('profile-leadership-emails').value = d.leadership_emails || '';
        const localeEl = document.getElementById('profile-locale');
        if (localeEl) localeEl.value = d.locale || 'en';
        // Timezone
        var tzEl = document.getElementById('profile-timezone');
        if (tzEl) tzEl.value = d.timezone || '';
        // Church type
        var ct = d.church_type || 'recurring';
        var recurringRadio = document.getElementById('church-type-recurring');
        var eventRadio = document.getElementById('church-type-event');
        if (recurringRadio) recurringRadio.checked = ct !== 'event';
        if (eventRadio) eventRadio.checked = ct === 'event';
        var eventFields = document.getElementById('event-fields');
        if (eventFields) eventFields.style.display = ct === 'event' ? '' : 'none';
        document.getElementById('profile-event-label').value = d.event_label || '';
        document.getElementById('profile-event-expires').value = d.event_expires_at ? d.event_expires_at.split('T')[0] : '';
        // Memory summary for engineer page
        var memEl = document.getElementById('engineer-memory-summary');
        if (memEl) memEl.value = d.memory_summary || '';
        // Ingest key for equipment page
        var ikEl = document.getElementById('eq-ingest-key');
        if (ikEl && d.ingest_stream_key) ikEl.textContent = d.ingest_stream_key;
      } catch(e) { toast('Failed to load profile', true); }
    }
    loadProfile();

    async function saveProfile() {
      btnLoading('btn-save-profile', 'Saving…');
      try {
        await api('PUT', '/api/church/me', {
          email: document.getElementById('profile-email').value,
          phone: document.getElementById('profile-phone').value,
          location: document.getElementById('profile-location').value,
          notes: document.getElementById('profile-notes').value,
          leadershipEmails: document.getElementById('profile-leadership-emails').value,
          locale: (document.getElementById('profile-locale') || {}).value || 'en',
          timezone: (document.getElementById('profile-timezone') || {}).value || '',
        });
        toast('Profile saved');
      } catch(e) { toast(e.message, true); }
      finally { btnReset('btn-save-profile'); }
    }

    async function saveChurchType() {
      btnLoading('btn-save-church-type', 'Saving…');
      try {
        var ct = document.getElementById('church-type-event').checked ? 'event' : 'recurring';
        await api('PUT', '/api/church/me', {
          churchType: ct,
          eventLabel: document.getElementById('profile-event-label').value,
          eventExpiresAt: document.getElementById('profile-event-expires').value || null,
        });
        toast('Church type saved');
      } catch(e) { toast(e.message, true); }
      finally { btnReset('btn-save-church-type'); }
    }

    // Toggle event fields visibility
    document.addEventListener('change', function(e) {
      if (e.target.name === 'church-type') {
        var ef = document.getElementById('event-fields');
        if (ef) ef.style.display = e.target.value === 'event' ? '' : 'none';
      }
    });

    async function changePassword() {
      const cur = document.getElementById('current-password').value;
      const np = document.getElementById('new-password').value;
      const cp = document.getElementById('confirm-password').value;
      if (!cur) return toast('Enter your current password', true);
      if (!np) return toast('Enter a new password', true);
      if (np !== cp) return toast('Passwords do not match', true);
      if (np.length < 8) return toast('Password must be at least 8 characters', true);
      try {
        await api('PUT', '/api/church/me', { currentPassword: cur, newPassword: np });
        document.getElementById('current-password').value = '';
        document.getElementById('new-password').value = '';
        document.getElementById('confirm-password').value = '';
        toast('Password updated');
      } catch(e) { toast(e.message, true); }
    }

    // ── Tally Engineer profile ─────────────────────────────────────────────────
    async function loadEngineerProfile() {
      try {
        const d = await api('GET', '/api/church/me');
        var ep = {};
        try { ep = JSON.parse(d.engineer_profile || '{}'); } catch {}
        document.getElementById('eng-stream-platform').value = ep.streamPlatform || '';
        document.getElementById('eng-expected-viewers').value = ep.expectedViewers || '';
        document.getElementById('eng-operator-level').value = ep.operatorLevel || '';
        document.getElementById('eng-backup-encoder').value = ep.backupEncoder || '';
        document.getElementById('eng-backup-switcher').value = ep.backupSwitcher || '';
        document.getElementById('eng-special-notes').value = ep.specialNotes || '';
        updateTrainingBadge(ep);
      } catch(e) { /* silent — profile may not have loaded yet */ }
    }
    loadEngineerProfile();
    loadCoaching();

    function updateTrainingBadge(ep) {
      var badge = document.getElementById('engineer-training-badge');
      if (!badge) return;
      var fields = [ep.streamPlatform, ep.expectedViewers, ep.operatorLevel, ep.backupEncoder, ep.backupSwitcher, ep.specialNotes];
      var filled = fields.filter(function(f) { return f && f.trim && f.trim().length > 0; }).length;
      if (filled === 0) {
        badge.className = 'badge badge-red'; badge.textContent = 'Not trained';
      } else if (filled < 4) {
        badge.className = 'badge badge-yellow'; badge.textContent = 'Partially trained (' + filled + '/6)';
      } else {
        badge.className = 'badge badge-green'; badge.textContent = 'Fully trained';
      }
    }

    async function saveEngineerProfile() {
      var ep = {
        streamPlatform: document.getElementById('eng-stream-platform').value,
        expectedViewers: document.getElementById('eng-expected-viewers').value,
        operatorLevel: document.getElementById('eng-operator-level').value,
        backupEncoder: document.getElementById('eng-backup-encoder').value.trim(),
        backupSwitcher: document.getElementById('eng-backup-switcher').value.trim(),
        specialNotes: document.getElementById('eng-special-notes').value.trim(),
      };
      try {
        await api('PUT', '/api/church/me', { engineerProfile: ep });
        updateTrainingBadge(ep);
        toast('Tally Engineer profile saved');
      } catch(e) { toast(e.message, true); }
    }

    // ── Engineer Chat ──────────────────────────────────────────────────────────

    var engineerChatMsgs = [];
    var engineerChatPollTimer = null;
    var engineerChatLastTs = null;

    async function loadEngineerChat() {
      try {
        var since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        var resp = await api('GET', '/api/church/chat?limit=50&since=' + encodeURIComponent(since));
        if (resp && resp.messages) {
          engineerChatMsgs = resp.messages;
          if (engineerChatMsgs.length > 0) {
            engineerChatLastTs = engineerChatMsgs[engineerChatMsgs.length - 1].timestamp;
          }
          renderEngineerChat();
        }
      } catch(e) { /* silent */ }
    }

    function startEngineerChatPoll() {
      loadEngineerChat();
      if (engineerChatPollTimer) clearInterval(engineerChatPollTimer);
      engineerChatPollTimer = setInterval(pollEngineerChat, 4000);
    }

    function stopEngineerChatPoll() {
      if (engineerChatPollTimer) { clearInterval(engineerChatPollTimer); engineerChatPollTimer = null; }
    }

    async function pollEngineerChat() {
      if (!engineerChatLastTs) return loadEngineerChat();
      try {
        var resp = await api('GET', '/api/church/chat?since=' + encodeURIComponent(engineerChatLastTs));
        if (resp && resp.messages && resp.messages.length > 0) {
          engineerChatMsgs = engineerChatMsgs.concat(resp.messages);
          engineerChatLastTs = resp.messages[resp.messages.length - 1].timestamp;
          hideEngineerThinking();
          renderEngineerChat();
        }
      } catch(e) { /* silent */ }
    }

    function renderEngineerChat() {
      var container = document.getElementById('engineer-chat-messages');
      var empty = document.getElementById('engineer-chat-empty');
      if (!container) return;
      if (engineerChatMsgs.length === 0) {
        if (empty) empty.style.display = '';
        return;
      }
      if (empty) empty.style.display = 'none';
      // Build HTML for all messages
      var html = '';
      for (var i = 0; i < engineerChatMsgs.length; i++) {
        var m = engineerChatMsgs[i];
        var name = m.sender_name || m.senderName || 'Unknown';
        var role = m.sender_role || m.senderRole || 'td';
        var time = new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        var nameColor = role === 'system' ? '#22c55e' : (role === 'admin' ? '#22c55e' : '#F8FAFC');
        var icon = role === 'system' ? 'SYS' : (role === 'admin' ? 'ADM' : 'ME');
        var msgText = escapeHtml(m.message);
        // Basic markdown: bold
        msgText = msgText.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
        // Bullet lists
        msgText = msgText.replace(/^[-•]\\s+/gm, '<span style="color:#22c55e">•</span> ');
        // Newlines
        msgText = msgText.replace(/\\n/g, '<br>');
        html += '<div style="padding:6px 0;margin-bottom:4px;border-bottom:1px solid rgba(26,46,31,0.3)">'
          + '<div style="font-size:10px;color:#475569;font-family:monospace">'
          + icon + ' <span style="color:' + nameColor + ';font-weight:600">' + escapeHtml(name) + '</span>'
          + ' <span style="margin-left:6px">' + time + '</span></div>'
          + '<div style="font-size:13px;color:#F8FAFC;margin-top:2px;line-height:1.5">' + msgText + '</div>'
          + '</div>';
      }
      // Keep only messages, remove empty state
      container.innerHTML = html;
      container.scrollTop = container.scrollHeight;
    }

    async function sendEngineerChat() {
      var input = document.getElementById('engineer-chat-input');
      var msg = (input.value || '').trim();
      if (!msg) return;
      input.value = '';
      try {
        var resp = await api('POST', '/api/church/chat', { message: msg, senderName: 'TD' });
        if (resp && resp.id) {
          engineerChatMsgs.push(resp);
          engineerChatLastTs = resp.timestamp;
          renderEngineerChat();
          // Show thinking indicator while waiting for AI response
          showEngineerThinking();
          // Quick-poll for faster response: check at 1s and 2s instead of waiting for 4s interval
          setTimeout(function() { pollEngineerChat(); }, 1000);
          setTimeout(function() { pollEngineerChat(); }, 2000);
        }
      } catch(e) {
        toast(e.message, true);
        input.value = msg; // restore on failure
      }
    }

    var engineerThinkingTimer = null;
    var engineerThinkingStart = 0;

    function showEngineerThinking() {
      var container = document.getElementById('engineer-chat-messages');
      if (!container) return;
      var existing = document.getElementById('engineer-thinking');
      if (existing) existing.remove();
      if (engineerThinkingTimer) { clearInterval(engineerThinkingTimer); engineerThinkingTimer = null; }
      engineerThinkingStart = Date.now();
      var div = document.createElement('div');
      div.id = 'engineer-thinking';
      div.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 12px;margin:4px 0;font-size:12px;color:#64748B';
      div.innerHTML = '<span style="display:inline-flex;gap:3px"><span style="animation:thinkBounce 1.2s infinite;width:6px;height:6px;background:#22C55E;border-radius:50%"></span><span style="animation:thinkBounce 1.2s infinite 0.2s;width:6px;height:6px;background:#22C55E;border-radius:50%"></span><span style="animation:thinkBounce 1.2s infinite 0.4s;width:6px;height:6px;background:#22C55E;border-radius:50%"></span></span> <span id="engineer-thinking-text">Tally Engineer is thinking\u2026</span> <span id="engineer-thinking-elapsed" style="color:#475569;font-size:10px;margin-left:4px"></span>';
      container.appendChild(div);
      container.scrollTop = container.scrollHeight;
      engineerThinkingTimer = setInterval(function() {
        var el = document.getElementById('engineer-thinking');
        if (!el) { clearInterval(engineerThinkingTimer); engineerThinkingTimer = null; return; }
        var elapsed = Math.floor((Date.now() - engineerThinkingStart) / 1000);
        var elapsedEl = document.getElementById('engineer-thinking-elapsed');
        if (elapsedEl) elapsedEl.textContent = elapsed + 's';
        var textEl = document.getElementById('engineer-thinking-text');
        if (textEl) {
          if (elapsed >= 15) textEl.textContent = 'Analyzing your system\u2026';
          else if (elapsed >= 5) textEl.textContent = 'Still working on it\u2026';
        }
      }, 1000);
      setTimeout(function() { var el = document.getElementById('engineer-thinking'); if (el) el.remove(); if (engineerThinkingTimer) { clearInterval(engineerThinkingTimer); engineerThinkingTimer = null; } }, 60000);
    }

    function hideEngineerThinking() {
      var el = document.getElementById('engineer-thinking');
      if (el) el.remove();
      if (engineerThinkingTimer) { clearInterval(engineerThinkingTimer); engineerThinkingTimer = null; }
    }

    function sendEngineerPill(btn) {
      var input = document.getElementById('engineer-chat-input');
      if (input) input.value = btn.textContent;
      sendEngineerChat();
    }

    function clearEngineerChat() {
      engineerChatMsgs = [];
      engineerChatLastTs = null;
      var container = document.getElementById('engineer-chat-messages');
      var empty = document.getElementById('engineer-chat-empty');
      if (container && empty) {
        container.innerHTML = '';
        container.appendChild(empty);
        empty.style.display = '';
      }
    }

    async function loadCoaching() {
      var card = document.getElementById('coaching-card');
      var body = document.getElementById('coaching-body');
      var weekEl = document.getElementById('coaching-week');
      if (!card || !body) return;

      try {
        var data = await api('GET', '/api/church/coaching');
        if (!data || data.totalEvents === undefined) {
          card.style.display = 'none';
          return;
        }

        card.style.display = '';
        if (weekEl) weekEl.textContent = 'Week of ' + data.weekOf;

        var html = '';

        // Reliability score
        if (data.reliability !== null) {
          var relColor = data.reliability >= 98 ? '#22c55e' : (data.reliability >= 95 ? '#f59e0b' : '#ef4444');
          html += '<div style="margin-bottom:12px;padding:12px;background:rgba(255,255,255,0.03);border-radius:8px">'
            + '<div style="font-size:24px;font-weight:700;color:' + relColor + '">' + data.reliability + '%</div>'
            + '<div style="font-size:11px;color:#64748b">Uptime reliability this week</div>'
            + '</div>';
        }

        // Session count
        if (data.sessions > 0) {
          html += '<div style="font-size:13px;color:#94A3B8;margin-bottom:8px">'
            + data.sessions + ' session' + (data.sessions !== 1 ? 's' : '') + ' this week'
            + (data.autoResolved > 0 ? ' · ' + data.autoResolved + ' auto-recovered' : '')
            + '</div>';
        }

        // Patterns
        if (data.patterns && data.patterns.length > 0) {
          html += '<div style="margin-top:12px;margin-bottom:4px;font-size:12px;font-weight:600;color:#F8FAFC">Recurring Patterns</div>';
          for (var i = 0; i < data.patterns.length; i++) {
            var p = data.patterns[i];
            html += '<div style="padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.04);font-size:13px">'
              + '<span style="color:#f59e0b">!</span> '
              + '<span style="color:#F8FAFC">' + escapeHtml(p.pattern) + '</span>'
              + ' <span style="color:#64748b;font-size:11px">' + escapeHtml(p.timeWindow) + '</span>';
            if (p.recommendation) {
              html += '<div style="font-size:12px;color:#94A3B8;margin-top:2px;margin-left:20px">→ ' + escapeHtml(p.recommendation) + '</div>';
            }
            html += '</div>';
          }
        }

        if (!html) {
          html = '<div style="color:#22c55e;font-size:13px;padding:8px 0">Clean week — no patterns detected</div>';
        }

        body.innerHTML = html;
      } catch(e) {
        card.style.display = 'none';
      }
    }

    // ── Room Management ──────────────────────────────────────────────────────
    async function loadRooms() {
      var container = document.getElementById('rooms-list');
      if (!container) return;
      try {
        var data = await api('GET', '/api/church/rooms');
        var rooms = data.rooms || [];
        if (!rooms.length) {
          container.innerHTML = '<div style="text-align:center;padding:16px;color:#475569">No rooms yet. Add a room to get started.</div>';
          return;
        }
        var html = '<div class="table-wrap"><table><thead><tr><th>Room</th><th>Assigned Desktop</th><th>Status</th><th></th></tr></thead><tbody>';
        for (var r of rooms) {
          var assigned = r.assignedDesktops && r.assignedDesktops.length > 0
            ? r.assignedDesktops.map(function(d) { return escapeHtml(d.name); }).join(', ')
            : '<span style="color:#475569">Unassigned</span>';
          html += '<tr>';
          html += '<td style="font-weight:600">' + escapeHtml(r.name) + (r.description ? '<br><span style="font-size:11px;color:#64748B">' + escapeHtml(r.description) + '</span>' : '') + '</td>';
          html += '<td>' + assigned + '</td>';
          html += '<td>' + (r.assignedDesktops && r.assignedDesktops.length > 0 ? '<span style="color:#22c55e">●</span>' : '<span style="color:#475569">—</span>') + '</td>';
          html += '<td style="text-align:right"><button class="btn-small btn-secondary" data-action="editRoom" data-room-id="' + escapeHtml(r.id) + '" data-room-name="' + escapeHtml(r.name) + '">Edit</button> <button class="btn-small btn-secondary" style="color:var(--danger);border-color:var(--danger)" data-action="deleteRoom" data-room-id="' + escapeHtml(r.id) + '" data-room-name="' + escapeHtml(r.name) + '">Delete</button></td>';
          html += '</tr>';
        }
        html += '</tbody></table></div>';
        container.innerHTML = html;
      } catch (e) {
        container.innerHTML = '<div style="color:#ef4444;padding:12px">' + escapeHtml(e.message) + '</div>';
      }
    }

    var _addingRoom = false;
    async function addRoom() {
      if (_addingRoom) return;
      _addingRoom = true;
      try {
        var name = await modalPrompt('Room name (e.g., Main Sanctuary, Youth Room)', '', { title: 'Add Room' });
        if (!name) { _addingRoom = false; return; }
        await api('POST', '/api/church/rooms', { name: name.trim() });
        toast('Room "' + name.trim() + '" created');
        loadRooms();
      } catch (e) {
        toast(e.message || 'Failed to create room', true);
      } finally {
        _addingRoom = false;
      }
    }

    async function editRoom(roomId, currentName) {
      var newName = await modalPrompt('Rename room', currentName, { title: 'Edit Room' });
      if (!newName || newName === currentName) return;
      try {
        await api('PATCH', '/api/church/rooms/' + encodeURIComponent(roomId), { name: newName.trim() });
        toast('Room renamed');
        loadRooms();
      } catch (e) {
        toast(e.message || 'Failed to rename room', true);
      }
    }

    async function deleteRoom(roomId, roomName) {
      if (!await modalConfirm('Delete room "' + roomName + '"? Any desktops assigned to this room will be unassigned.', { title: 'Delete Room', okLabel: 'Delete', dangerOk: true })) return;
      try {
        await api('DELETE', '/api/church/rooms/' + encodeURIComponent(roomId));
        toast('Room deleted');
        loadRooms();
      } catch (e) {
        toast(e.message || 'Failed to delete room', true);
      }
    }

    function timeAgo(iso) {
      if (!iso) return '';
      var ms = Date.now() - new Date(iso).getTime();
      if (ms < 60000) return 'just now';
      if (ms < 3600000) return Math.floor(ms / 60000) + 'm ago';
      if (ms < 86400000) return Math.floor(ms / 3600000) + 'h ago';
      return Math.floor(ms / 86400000) + 'd ago';
    }

    // ── TDs ──────────────────────────────────────────────────────────────────
    async function loadTds() {
      try {
        const tds = await api('GET', '/api/church/tds');
        const tbody = document.getElementById('tds-tbody');
        if (!tds.length) {
          tbody.innerHTML = '<tr><td colspan="5" style="color:#475569;text-align:center;padding:20px">No tech directors yet.</td></tr>';
          return;
        }
        tbody.innerHTML = tds.map(td => `
          <tr>
            <td>${escapeHtml(td.name || '')}</td>
            <td><span class="badge badge-gray">${escapeHtml(td.role || 'td')}</span></td>
            <td>
              <select style="background:#09090B;color:#F8FAFC;border:1px solid #1a2e1f;border-radius:6px;padding:3px 6px;font-size:12px;cursor:pointer" onchange="setTdAccessLevel('${escapeHtml(String(td.id || ''))}', this.value)">
                <option value="viewer" ${(td.access_level||'operator')==='viewer'?'selected':''}>Viewer</option>
                <option value="operator" ${(!td.access_level||td.access_level==='operator')?'selected':''}>Operator</option>
                <option value="admin" ${(td.access_level||'')==='admin'?'selected':''}>Admin</option>
              </select>
            </td>
            <td style="color:#94A3B8">${escapeHtml(td.email || '—')}</td>
            <td><button class="btn-danger" onclick="removeTd('${escapeHtml(String(td.id || ''))}')">Remove</button></td>
          </tr>`).join('');
        document.getElementById('stat-tds').textContent = tds.length;
      } catch(e) { toast('Failed to load TDs', true); }
    }

    async function addTd() {
      const name = document.getElementById('td-name').value.trim();
      if (!name) return toast('Name required', true);
      try {
        await api('POST', '/api/church/tds', {
          name,
          role: document.getElementById('td-role').value,
          accessLevel: document.getElementById('td-access-level').value,
          email: document.getElementById('td-email').value,
          phone: document.getElementById('td-phone').value,
        });
        document.getElementById('modal-add-td').classList.remove('open');
        document.getElementById('td-name').value = '';
        document.getElementById('td-email').value = '';
        document.getElementById('td-phone').value = '';
        loadTds();
        toast('TD added');
      } catch(e) { toast(e.message, true); }
    }

    async function removeTd(id) {
      if (!await modalConfirm('Remove this tech director?', { title: 'Remove TD', okLabel: 'Remove', dangerOk: true })) return;
      try {
        await api('DELETE', '/api/church/tds/' + id);
        loadTds();
        toast('TD removed');
      } catch(e) { toast(e.message, true); }
    }

    async function copyTdInviteLink() {
      const btn = document.getElementById('btn-copy-invite-link');
      try {
        const data = await api('GET', '/api/church/td-invite-link');
        await navigator.clipboard.writeText(data.link);
        toast('Invite link copied! Share with your TD — they click it and are registered automatically.');
        if (btn) { btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = 'Copy Invite Link'; }, 2500); }
      } catch(e) {
        // Fallback: show link in a prompt
        try {
          const data = await api('GET', '/api/church/td-invite-link');
          window.prompt('Share this Telegram invite link with your TD:', data.link);
        } catch { toast('Failed to get invite link', true); }
      }
    }

    async function setTdAccessLevel(id, accessLevel) {
      try {
        await api('PUT', '/api/church/tds/' + id + '/access-level', { accessLevel });
        const labels = { viewer: 'Viewer (read-only)', operator: 'Operator', admin: 'Admin' };
        toast('Access level set to ' + (labels[accessLevel] || accessLevel));
      } catch(e) { toast(e.message, true); loadTds(); }
    }

    // ── Schedule ─────────────────────────────────────────────────────────────
    function pad2(n) {
      return String(n).padStart(2, '0');
    }

    function toMinutes(hhmm) {
      const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
      if (!m) return null;
      const h = Number(m[1]);
      const min = Number(m[2]);
      if (!Number.isFinite(h) || !Number.isFinite(min) || h < 0 || h > 23 || min < 0 || min > 59) return null;
      return (h * 60) + min;
    }

    function fromMinutes(total) {
      const safe = Math.max(0, Math.min(1439, Number(total) || 0));
      const h = Math.floor(safe / 60);
      const m = safe % 60;
      return pad2(h) + ':' + pad2(m);
    }

    function normalizeTime(value) {
      const mins = toMinutes(value);
      return mins === null ? '' : fromMinutes(mins);
    }

    function defaultEndFor(start) {
      const startMin = toMinutes(start);
      if (startMin === null) return '11:00';
      return fromMinutes(Math.min(1439, startMin + 120));
    }

    function emptyScheduleObject() {
      const out = {};
      SCHEDULE_DAYS.forEach(function(day) { out[day] = []; });
      return out;
    }

    function normalizeSchedulePayload(raw) {
      const out = emptyScheduleObject();

      // Legacy service_times array support (day/startHour/startMin/durationHours)
      if (Array.isArray(raw)) {
        raw.forEach(function(item) {
          const dayNum = Number(item && item.day);
          if (!Number.isInteger(dayNum) || dayNum < 0 || dayNum > 6) return;
          const dayKey = SCHEDULE_DAYS[dayNum];
          const startHour = Number(item && item.startHour);
          const startMin = Number((item && item.startMin) || 0);
          const durationHours = Number((item && item.durationHours) || 2);
          if (!Number.isFinite(startHour) || !Number.isFinite(startMin) || !Number.isFinite(durationHours)) return;
          const start = fromMinutes((startHour * 60) + startMin);
          const end = fromMinutes((startHour * 60) + startMin + Math.max(15, Math.round(durationHours * 60)));
          out[dayKey].push({
            start: start,
            end: end,
            label: String((item && (item.label || item.title)) || '').trim(),
          });
        });
      }

      // Preferred object format: { sunday: [{start,end,label}], ... }
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        Object.keys(raw).forEach(function(k) {
          const dayKey = String(k || '').toLowerCase();
          if (!SCHEDULE_DAYS.includes(dayKey)) return;
          const entries = Array.isArray(raw[dayKey]) ? raw[dayKey] : [];
          entries.forEach(function(entry) {
            const start = normalizeTime(entry && (entry.start || entry.startTime));
            const end = normalizeTime(entry && (entry.end || entry.endTime));
            if (!start || !end) return;
            out[dayKey].push({
              start: start,
              end: end,
              label: String((entry && entry.label) || '').trim(),
            });
          });
        });
      }

      SCHEDULE_DAYS.forEach(function(dayKey) {
        out[dayKey].sort(function(a, b) {
          return (toMinutes(a.start) || 0) - (toMinutes(b.start) || 0);
        });
      });

      return out;
    }

    function compactSchedule(scheduleObj) {
      const out = {};
      SCHEDULE_DAYS.forEach(function(day) {
        const entries = Array.isArray(scheduleObj[day]) ? scheduleObj[day] : [];
        if (entries.length) out[day] = entries;
      });
      return out;
    }

    function updateScheduleEmptyState() {
      const emptyEl = document.getElementById('schedule-empty');
      const rowsEl = document.getElementById('schedule-rows');
      if (!emptyEl || !rowsEl) return;
      emptyEl.style.display = rowsEl.children.length ? 'none' : 'block';
    }

    function buildDayOptionsHtml(selectedDay) {
      return SCHEDULE_DAYS.map(function(day) {
        return '<option value="' + day + '"' + (day === selectedDay ? ' selected' : '') + '>' + SCHEDULE_DAY_LABELS[day] + '</option>';
      }).join('');
    }

    function buildTimeSelectHtml(fieldName, value24) {
      var mins = toMinutes(value24);
      if (mins === null) mins = 9 * 60; // default 9:00 AM
      var h24 = Math.floor(mins / 60);
      var m = mins % 60;
      var h12 = h24 === 0 ? 12 : (h24 > 12 ? h24 - 12 : h24);
      var ampm = h24 < 12 ? 'AM' : 'PM';
      // Snap minutes to nearest 5
      var snapped = Math.round(m / 5) * 5;
      if (snapped === 60) { snapped = 0; h24++; h12 = h24 === 0 ? 12 : (h24 > 12 ? h24 - 12 : h24); ampm = h24 < 12 ? 'AM' : 'PM'; }

      var hourOpts = '';
      for (var i = 1; i <= 12; i++) {
        hourOpts += '<option value="' + i + '"' + (i === h12 ? ' selected' : '') + '>' + i + '</option>';
      }
      var minOpts = '';
      for (var v = 0; v < 60; v += 5) {
        minOpts += '<option value="' + v + '"' + (v === snapped ? ' selected' : '') + '>' + pad2(v) + '</option>';
      }
      var ampmOpts = '<option value="AM"' + (ampm === 'AM' ? ' selected' : '') + '>AM</option>' +
                     '<option value="PM"' + (ampm === 'PM' ? ' selected' : '') + '>PM</option>';

      return '<div class="time-select" data-schedule-field="' + fieldName + '">' +
        '<select class="time-hour">' + hourOpts + '</select>' +
        '<span>:</span>' +
        '<select class="time-min">' + minOpts + '</select>' +
        '<select class="time-ampm">' + ampmOpts + '</select>' +
        '</div>';
    }

    function readTimeSelect(container) {
      var h = parseInt(container.querySelector('.time-hour').value, 10);
      var m = parseInt(container.querySelector('.time-min').value, 10);
      var ampm = container.querySelector('.time-ampm').value;
      if (ampm === 'AM' && h === 12) h = 0;
      else if (ampm === 'PM' && h !== 12) h += 12;
      return pad2(h) + ':' + pad2(m);
    }

    function addScheduleRow(prefill) {
      const rowsEl = document.getElementById('schedule-rows');
      if (!rowsEl) return;

      const day = (prefill && SCHEDULE_DAYS.includes(prefill.day)) ? prefill.day : 'sunday';
      const start = normalizeTime(prefill && prefill.start) || '09:00';
      const end = normalizeTime(prefill && prefill.end) || defaultEndFor(start);
      const label = String((prefill && prefill.label) || '').trim();

      const row = document.createElement('div');
      row.className = 'schedule-row';
      row.innerHTML =
        '<select data-schedule-field="day">' + buildDayOptionsHtml(day) + '</select>' +
        buildTimeSelectHtml('start', start) +
        buildTimeSelectHtml('end', end) +
        '<input data-schedule-field="label" type="text" placeholder="Service label (optional)" value="' + label.replace(/"/g, '&quot;') + '">' +
        '<button class="btn-danger" type="button">Remove</button>';

      const removeBtn = row.querySelector('button');
      removeBtn.addEventListener('click', function() {
        row.remove();
        updateScheduleEmptyState();
      });

      rowsEl.appendChild(row);
      updateScheduleEmptyState();
    }

    function renderScheduleRows(scheduleObj) {
      const rowsEl = document.getElementById('schedule-rows');
      if (!rowsEl) return;
      rowsEl.innerHTML = '';

      let added = 0;
      SCHEDULE_DAYS.forEach(function(day) {
        const entries = Array.isArray(scheduleObj[day]) ? scheduleObj[day] : [];
        entries.forEach(function(entry) {
          addScheduleRow({ day: day, start: entry.start, end: entry.end, label: entry.label });
          added += 1;
        });
      });

      if (!added) {
        updateScheduleEmptyState();
      }
    }

    function collectScheduleFromRows() {
      const out = emptyScheduleObject();
      const rows = Array.from(document.querySelectorAll('#schedule-rows .schedule-row'));

      for (const row of rows) {
        const day = String(row.querySelector('[data-schedule-field="day"]')?.value || '').toLowerCase();
        const startEl = row.querySelector('.time-select[data-schedule-field="start"]');
        const endEl = row.querySelector('.time-select[data-schedule-field="end"]');
        const start = startEl ? normalizeTime(readTimeSelect(startEl)) : '';
        const end = endEl ? normalizeTime(readTimeSelect(endEl)) : '';
        const label = String(row.querySelector('[data-schedule-field="label"]')?.value || '').trim();

        if (!day || !SCHEDULE_DAYS.includes(day)) continue;
        if (!start && !end && !label) continue;
        if (!start || !end) throw new Error('Each service window needs both a start and end time');

        const startMin = toMinutes(start);
        const endMin = toMinutes(end);
        if (startMin === null || endMin === null) {
          throw new Error('Invalid time format');
        }
        // Allow midnight crossing (e.g. 11:00 PM to 1:00 AM)
        if (endMin <= startMin && endMin !== 0) {
          // endMin=0 means midnight, which is valid for crossing
          // Otherwise endMin < startMin means a midnight-crossing service (e.g. 23:00→01:00)
          if (endMin > startMin) throw new Error('End time must be after start time');
          // midnight crossing is OK — duration = (1440 - startMin) + endMin
        }
        if (endMin === startMin) {
          throw new Error('Start and end time cannot be the same');
        }

        out[day].push({ start: start, end: end, label: label });
      }

      SCHEDULE_DAYS.forEach(function(day) {
        out[day].sort(function(a, b) {
          return (toMinutes(a.start) || 0) - (toMinutes(b.start) || 0);
        });
      });

      return compactSchedule(out);
    }

    async function loadSchedule() {
      try {
        const raw = await api('GET', '/api/church/schedule');
        const normalized = normalizeSchedulePayload(raw);
        renderScheduleRows(normalized);
      } catch(e) { toast('Failed to load schedule', true); }
    }

    async function saveSchedule() {
      btnLoading('btn-save-schedule', 'Saving…');
      try {
        const schedule = collectScheduleFromRows();
        await api('PUT', '/api/church/schedule', schedule);
        toast('Schedule saved');
      } catch(e) { toast(e.message || 'Unable to save schedule', true); }
      finally { btnReset('btn-save-schedule'); }
    }

    // ── Notifications ─────────────────────────────────────────────────────────
    async function loadNotifications() {
      try {
        const d = await api('GET', '/api/church/me');
        notifData = d.notifications || {};
        document.getElementById('notif-email').checked = !!notifData.email;
        document.getElementById('notif-telegram').checked = !!notifData.telegram;
        document.getElementById('notif-sync').checked = notifData.sync !== false;
        document.getElementById('notif-digest').checked = !!notifData.digest;
        document.getElementById('notif-auto-recovery').checked = d.autoRecoveryEnabled !== false && d.autoRecoveryEnabled !== 0;
        document.getElementById('telegram-chat-id').value = d.telegramChatId || '';
        // Populate failover dropdowns from live equipment status
        if (d.status) populateFailoverInputs(d.status);
      } catch(e) { toast('Failed to load notifications', true); }
      // Load failover settings separately
      loadFailoverSettings();
      loadEmailPreferences();
    }

    async function saveNotifications() {
      try {
        await api('PUT', '/api/church/me', {
          notifications: {
            email:    document.getElementById('notif-email').checked,
            telegram: document.getElementById('notif-telegram').checked,
            sync:     document.getElementById('notif-sync').checked,
            digest:   document.getElementById('notif-digest').checked,
          },
          telegramChatId: document.getElementById('telegram-chat-id').value,
          autoRecoveryEnabled: document.getElementById('notif-auto-recovery').checked,
        });
        toast('Notification preferences saved');
      } catch(e) { toast(e.message, true); }
    }

    // ── Email Preferences ──────────────────────────────────────────────────
    async function loadEmailPreferences() {
      var container = document.getElementById('email-prefs-container');
      if (!container) return;
      try {
        var data = await api('GET', '/api/church/email-preferences');
        var categories = data.categories || {};
        var prefs = data.preferences || {};
        var html = '';
        for (var cat in categories) {
          if (cat === 'win-back') continue; // hidden from user-facing preferences
          var checked = prefs[cat] !== false ? 'checked' : '';
          html += '<div class="toggle-row">' +
            '<div>' +
              '<div class="toggle-label">' + escapeHtml(categories[cat]) + '</div>' +
            '</div>' +
            '<label class="toggle"><input type="checkbox" data-email-cat="' + escapeHtml(cat) + '" ' + checked + ' onchange="saveEmailPref(this)"><span class="slider"></span></label>' +
          '</div>';
        }
        container.innerHTML = html;
        container.style.opacity = '1';
      } catch(e) {
        container.innerHTML = '<p style="color:#475569;font-size:12px">Unable to load email preferences.</p>';
        container.style.opacity = '1';
      }
    }

    async function saveEmailPref(el) {
      var cat = el.getAttribute('data-email-cat');
      var enabled = el.checked;
      try {
        await api('PUT', '/api/church/email-preferences', { category: cat, enabled: enabled });
        toast('Email preference updated');
      } catch(e) { toast(e.message || 'Failed to update', true); el.checked = !enabled; }
    }

    // ── Stream Failover Settings ─────────────────────────────────────────────
    function toggleFailoverAction() {
      var t = document.getElementById('failover-action-type').value;
      document.getElementById('failover-atem-fields').style.display = t === 'atem_switch' ? 'block' : 'none';
      document.getElementById('failover-videohub-fields').style.display = t === 'videohub_route' ? 'block' : 'none';
    }

    async function loadFailoverSettings() {
      try {
        var f = await api('GET', '/api/church/failover');
        document.getElementById('failover-enabled').checked = f.enabled;
        document.getElementById('failover-config').style.display = f.enabled ? 'block' : 'none';
        document.getElementById('failover-black-threshold').value = f.blackThresholdS || 5;
        document.getElementById('failover-ack-timeout').value = f.ackTimeoutS || 30;
        if (f.action) {
          document.getElementById('failover-action-type').value = f.action.type || '';
          toggleFailoverAction();
          if (f.action.type === 'atem_switch') {
            // Set ATEM input after dropdown is populated
            setTimeout(function() {
              var sel = document.getElementById('failover-atem-input');
              if (sel) sel.value = String(f.action.input || '');
            }, 500);
          } else if (f.action.type === 'videohub_route') {
            setTimeout(function() {
              var oSel = document.getElementById('failover-vh-output');
              var iSel = document.getElementById('failover-vh-input');
              if (oSel) oSel.value = String(f.action.output || '');
              if (iSel) iSel.value = String(f.action.input || '');
            }, 500);
          }
        }
        var recovEl = document.getElementById('failover-recovery-outside');
        if (recovEl) recovEl.checked = !!f.recoveryOutsideServiceHours;
      } catch(e) { /* failover not configured yet — use defaults */ }
    }

    // Toggle config visibility when enabled/disabled
    document.getElementById('failover-enabled').addEventListener('change', function() {
      document.getElementById('failover-config').style.display = this.checked ? 'block' : 'none';
    });

    function populateFailoverInputs(status) {
      // Populate ATEM input dropdown
      var atemSel = document.getElementById('failover-atem-input');
      if (atemSel && status && status.atem && status.atem.inputLabels) {
        var labels = status.atem.inputLabels;
        var prevVal = atemSel.value;
        atemSel.innerHTML = '<option value="">— Select safe source —</option>';
        // Standard inputs
        Object.keys(labels).sort(function(a, b) { return Number(a) - Number(b); }).forEach(function(id) {
          var opt = document.createElement('option');
          opt.value = id;
          opt.textContent = id + ' — ' + labels[id];
          atemSel.appendChild(opt);
        });
        // Always add media players (may not be in inputLabels)
        [{ id: 3010, name: 'Media Player 1' }, { id: 3020, name: 'Media Player 2' }].forEach(function(mp) {
          if (!labels[String(mp.id)]) {
            var opt = document.createElement('option');
            opt.value = mp.id;
            opt.textContent = mp.id + ' — ' + mp.name;
            atemSel.appendChild(opt);
          }
        });
        if (prevVal) atemSel.value = prevVal;
      }

      // Populate VideoHub dropdowns
      if (status && status.videoHubs && status.videoHubs.length > 0) {
        var hub = status.videoHubs[0];
        var oSel = document.getElementById('failover-vh-output');
        var iSel = document.getElementById('failover-vh-input');
        if (oSel && hub.outputLabels) {
          var prevO = oSel.value;
          oSel.innerHTML = '<option value="">— Select output —</option>';
          hub.outputLabels.forEach(function(l, i) {
            var opt = document.createElement('option');
            opt.value = i;
            opt.textContent = i + ' — ' + (l || 'Output ' + i);
            oSel.appendChild(opt);
          });
          if (prevO) oSel.value = prevO;
        }
        if (iSel && hub.inputLabels) {
          var prevI = iSel.value;
          iSel.innerHTML = '<option value="">— Select safe source —</option>';
          hub.inputLabels.forEach(function(l, i) {
            var opt = document.createElement('option');
            opt.value = i;
            opt.textContent = i + ' — ' + (l || 'Input ' + i);
            iSel.appendChild(opt);
          });
          if (prevI) iSel.value = prevI;
        }
      }
    }

    async function saveFailoverSettings() {
      try {
        var actionType = document.getElementById('failover-action-type').value;
        var action = null;
        if (actionType === 'atem_switch') {
          var input = document.getElementById('failover-atem-input').value;
          if (!input) { toast('Select an ATEM input for failover', true); return; }
          action = { type: 'atem_switch', input: Number(input) };
        } else if (actionType === 'videohub_route') {
          var output = document.getElementById('failover-vh-output').value;
          var vhInput = document.getElementById('failover-vh-input').value;
          if (!output || !vhInput) { toast('Select VideoHub output and input for failover', true); return; }
          action = { type: 'videohub_route', output: Number(output), input: Number(vhInput), hubIndex: 0 };
        }

        var enabled = document.getElementById('failover-enabled').checked;
        if (enabled && !action) { toast('Configure a failover action before enabling', true); return; }

        await api('PUT', '/api/church/failover', {
          enabled: enabled,
          blackThresholdS: Number(document.getElementById('failover-black-threshold').value) || 5,
          ackTimeoutS: Number(document.getElementById('failover-ack-timeout').value) || 30,
          action: action,
          recoveryOutsideServiceHours: document.getElementById('failover-recovery-outside').checked,
        });
        toast('Failover settings saved');
      } catch(e) { toast(e.message, true); }
    }

    // ── Failover Drill ───────────────────────────────────────────────────────
    async function runFailoverDrill() {
      var btn = document.getElementById('btn-run-drill');
      var spinner = document.getElementById('drill-spinner');
      var statusEl = document.getElementById('failover-drill-status');
      if (btn) btn.disabled = true;
      if (spinner) spinner.style.display = 'inline';
      if (statusEl) {
        statusEl.style.display = 'block';
        statusEl.style.background = 'rgba(234,179,8,0.08)';
        statusEl.style.border = '1px solid rgba(234,179,8,0.25)';
        statusEl.style.color = '#eab308';
        statusEl.innerHTML = '<strong>DRILL IN PROGRESS</strong> — Simulating encoder signal loss…';
      }

      // Animate through drill steps with delays to simulate real failover timeline
      var steps = [
        { delay: 800,  text: '<strong>DRILL IN PROGRESS</strong><br>Step 1/5 — Encoder bitrate dropped to 0 kbps (simulated)', color: '#eab308' },
        { delay: 2000, text: '<strong>DRILL IN PROGRESS</strong><br>Step 2/5 — Black screen detected. Waiting for confirmation (simulated 5s threshold)…', color: '#eab308' },
        { delay: 3500, text: '<strong>DRILL IN PROGRESS</strong><br>Step 3/5 — Outage confirmed. TD Telegram alert would fire now. Ack window open (30s)…', color: '#ef4444' },
        { delay: 5000, text: '<strong>DRILL IN PROGRESS</strong><br>Step 4/5 — No TD ack received (simulated). Executing failover action…', color: '#ef4444' },
      ];

      for (var i = 0; i < steps.length; i++) {
        await new Promise(function(r) { setTimeout(r, steps[i].delay); });
        if (statusEl) {
          statusEl.style.color = steps[i].color;
          statusEl.innerHTML = steps[i].text;
        }
      }

      try {
        var result = await api('POST', '/api/church/failover/drill');
        if (statusEl) {
          var passed = result && result.passed;
          statusEl.style.background = passed ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)';
          statusEl.style.border = '1px solid ' + (passed ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)');
          statusEl.style.color = passed ? '#22c55e' : '#ef4444';
          statusEl.innerHTML = (passed ? '&#10003;' : '&#10007;') + ' <strong>DRILL COMPLETE</strong><br>' +
            (result.report || (passed
              ? 'All failover steps completed successfully. Your setup is ready.'
              : 'Drill found issues — review your failover configuration above.')) +
            '<br><span style="font-size:11px;color:#64748B;margin-top:4px;display:block">This was a drill. No real equipment was changed.</span>';
        }
      } catch(e) {
        if (statusEl) {
          statusEl.style.color = '#ef4444';
          statusEl.innerHTML = '&#10007; <strong>DRILL FAILED</strong><br>' + escapeHtml(e.message || 'Could not complete drill. Make sure failover is configured.');
        }
      }

      if (btn) btn.disabled = false;
      if (spinner) spinner.style.display = 'none';
    }

    // ── Guest Tokens ──────────────────────────────────────────────────────────
    async function loadGuests() {
      try {
        const tokens = await api('GET', '/api/church/guest-tokens');
        const tbody = document.getElementById('guests-tbody');
        if (!tokens.length) {
          tbody.innerHTML = '<tr><td colspan="6" style="color:#475569;text-align:center;padding:20px">No guest tokens.</td></tr>';
          return;
        }
        tbody.innerHTML = tokens.map(t => {
          const msLeft = t.expiresAt ? new Date(t.expiresAt) - Date.now() : Infinity;
          const remaining = t.expiresAt
            ? (msLeft <= 0 ? 'Expired' : msLeft < 3600000 ? Math.ceil(msLeft/60000) + 'm left'
              : msLeft < 86400000 ? Math.ceil(msLeft/3600000) + 'h left'
              : Math.ceil(msLeft/86400000) + 'd left')
            : '—';
          const remainingColor = msLeft < 3600000 ? '#f59e0b' : msLeft < 14400000 ? '#fbbf24' : '#22c55e';
          return `
          <tr>
            <td><code style="font-size:11px;color:#22c55e">${t.token.slice(0,16)}…</code></td>
            <td style="color:#94A3B8">${t.label || '—'}</td>
            <td style="color:${t.registered ? '#22c55e' : '#64748B'};font-size:12px">${t.registered ? '\\u2713 Claimed' : 'Unclaimed'}</td>
            <td style="color:#94A3B8;font-size:12px">${new Date(t.createdAt).toLocaleDateString()}</td>
            <td style="font-size:12px"><span style="color:${remainingColor};font-weight:600">${remaining}</span><br><span style="color:#475569;font-size:11px">${t.expiresAt ? new Date(t.expiresAt).toLocaleDateString() : ''}</span></td>
            <td><button class="btn-danger" onclick="revokeToken('${t.token}')">Revoke</button></td>
          </tr>`;
        }).join('');
      } catch(e) { toast('Failed to load tokens', true); }
    }

    async function generateGuestToken() {
      const label = await modalPrompt('Label for this token (e.g. "Visiting TD — March 9")', '', { title: 'New Guest Token' });
      if (label === null) return;
      try {
        const t = await api('POST', '/api/church/guest-tokens', { label });
        toast('Token created');
        loadGuests();
        modalCopyValue('Guest Token (shown once)', t.token);
      } catch(e) { toast(e.message, true); }
    }

    async function revokeToken(token) {
      if (!await modalConfirm('Revoke this guest token? Connected guests will lose access immediately.', { title: 'Revoke Token', okLabel: 'Revoke', dangerOk: true })) return;
      try {
        await api('DELETE', '/api/church/guest-tokens/' + encodeURIComponent(token));
        loadGuests();
        toast('Token revoked');
      } catch(e) { toast(e.message, true); }
    }

    // ── Macros ────────────────────────────────────────────────────────────────
    var editingMacroId = null;

    async function loadMacros() {
      var el = document.getElementById('macros-list');
      if (!el) return;
      try {
        var macros = await api('GET', '/api/church/macros');
        if (!macros.length) {
          el.innerHTML = '<div style="color:#475569;text-align:center;padding:24px;font-size:13px">'
            + '<div style="margin-bottom:8px;color:#94A3B8"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" width="24" height="24" aria-hidden="true"><path d="M9.5 1.5 5 9h4l-2.5 5.5L13 7H9l.5-5.5Z"/></svg></div>'
            + '<div style="font-weight:600;margin-bottom:6px">No macros yet</div>'
            + '<div>Create your first macro to give your TDs one-tap shortcuts for common service sequences.</div>'
            + '</div>';
          return;
        }
        el.innerHTML = macros.map(function(m) {
          var steps = (m.steps || []);
          return '<div style="padding:14px;border:1px solid rgba(255,255,255,0.06);border-radius:8px;margin-bottom:10px">'
            + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">'
            + '<div>'
            + '<span style="font-family:monospace;font-size:15px;font-weight:700;color:#22c55e">/' + escapeHtml(m.name) + '</span>'
            + (m.description ? '<span style="color:#94A3B8;font-size:13px;margin-left:10px">' + escapeHtml(m.description) + '</span>' : '')
            + '</div>'
            + '<div style="display:flex;gap:6px">'
            + '<button class="btn-secondary" style="font-size:11px;padding:4px 10px" onclick="editMacro(\'' + escapeHtml(String(m.id)) + '\')">Edit</button>'
            + '<button class="btn-danger" style="font-size:11px;padding:4px 10px" onclick="deleteMacro(\'' + escapeHtml(String(m.id)) + '\')">Delete</button>'
            + '</div></div>'
            + (steps.length ? '<div style="font-family:monospace;font-size:11px;color:#64748b;line-height:1.8">'
              + steps.map(function(s) { return '→ ' + escapeHtml(s); }).join('<br>') + '</div>' : '');
        }).join('');
      } catch(e) { el.innerHTML = '<div style="color:#ef4444;text-align:center;padding:20px;font-size:13px">Failed to load macros</div>'; }
    }

    function closeMacroModal() {
      document.getElementById('modal-add-macro').classList.remove('open');
      document.getElementById('macro-edit-id').value = '';
      document.getElementById('macro-name').value = '';
      document.getElementById('macro-description').value = '';
      document.getElementById('macro-steps').value = '';
      document.getElementById('macro-modal-title').textContent = 'New Macro';
      editingMacroId = null;
    }

    async function editMacro(id) {
      try {
        var m = await api('GET', '/api/church/macros/' + id);
        editingMacroId = id;
        document.getElementById('macro-edit-id').value = id;
        document.getElementById('macro-name').value = m.name || '';
        document.getElementById('macro-description').value = m.description || '';
        document.getElementById('macro-steps').value = (m.steps || []).join('\\n');
        document.getElementById('macro-modal-title').textContent = 'Edit Macro';
        document.getElementById('modal-add-macro').classList.add('open');
      } catch(e) { toast('Failed to load macro', true); }
    }

    async function deleteMacro(id) {
      if (!await modalConfirm('Delete this macro? TDs will no longer be able to run it.', { title: 'Delete Macro', okLabel: 'Delete', dangerOk: true })) return;
      try {
        await api('DELETE', '/api/church/macros/' + id);
        loadMacros();
        toast('Macro deleted');
      } catch(e) { toast(e.message, true); }
    }

    async function saveMacro() {
      var name = document.getElementById('macro-name').value.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
      var description = document.getElementById('macro-description').value.trim();
      var stepsRaw = document.getElementById('macro-steps').value;
      var steps = stepsRaw.split('\\n').map(function(s) { return s.trim(); }).filter(Boolean);
      if (!name) return toast('Shortcut name is required', true);
      if (!steps.length) return toast('Add at least one command step', true);
      var editId = document.getElementById('macro-edit-id').value;
      try {
        if (editId) {
          await api('PUT', '/api/church/macros/' + editId, { name, description, steps });
          toast('Macro updated');
        } else {
          await api('POST', '/api/church/macros', { name, description, steps });
          toast('Macro created — TDs can now use /' + name + ' in Telegram');
        }
        closeMacroModal();
        loadMacros();
      } catch(e) { toast(e.message, true); }
    }

    // ── AutoPilot ─────────────────────────────────────────────────────────────
    var _autopilotChurchId = null;
    var _autopilotPaused = false;

    async function loadAutopilot() {
      try {
        var me = await api('GET', '/api/church/me');
        var billing = await api('GET', '/api/church/billing');
        _autopilotChurchId = me.churchId;

        var hasAccess = billing.features && billing.features.autopilot;
        document.getElementById('autopilot-upgrade-gate').style.display = hasAccess ? 'none' : '';
        document.getElementById('autopilot-content').style.display = hasAccess ? '' : 'none';
        if (!hasAccess) return;

        var data = await api('GET', '/api/churches/' + me.churchId + '/automation');
        _autopilotPaused = data.paused;

        var pauseBtn = document.getElementById('btn-autopilot-pause');
        if (pauseBtn) pauseBtn.textContent = _autopilotPaused ? pt('autopilot.resume') : pt('autopilot.pause');

        var banner = document.getElementById('autopilot-paused-banner');
        if (banner) { banner.style.display = _autopilotPaused ? '' : 'none'; banner.textContent = pt('autopilot.paused_banner'); }

        renderAutopilotRules(data.rules || []);
      } catch(e) {
        var el = document.getElementById('autopilot-rules-list');
        if (el) el.innerHTML = '<div style="color:#ef4444;text-align:center;padding:20px">Error loading AutoPilot: ' + escapeHtml(e.message) + '</div>';
      }
    }

    function renderAutopilotRules(rules) {
      var el = document.getElementById('autopilot-rules-list');
      if (!el) return;
      if (!rules.length) {
        el.innerHTML = '<div style="color:#475569;text-align:center;padding:24px;font-size:13px">'
          + '<div style="margin-bottom:8px;color:#94A3B8"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" width="24" height="24" aria-hidden="true"><rect x="3" y="5" width="10" height="7" rx="1.5" ry="1.5"/><circle cx="6" cy="8.5" r="1"/><circle cx="10" cy="8.5" r="1"/><rect x="6.5" y="2" width="3" height="3" rx=".5"/><path d="M5 5V4h1v1zm5 0V4h1v1z"/></svg></div>'
          + '<div style="font-weight:600;margin-bottom:6px">' + escapeHtml(pt('autopilot.no_rules')) + '</div>'
          + '</div>';
        return;
      }
      var triggerLabels = {
        'propresenter_slide_change': 'Slide Change',
        'schedule_timer': 'Schedule Timer',
        'equipment_state_match': 'Equipment State',
      };
      el.innerHTML = rules.map(function(rule) {
        var label = triggerLabels[rule.trigger_type] || rule.trigger_type;
        var firedInfo = rule.last_fired_at ? ' \u00b7 Last fired: ' + timeAgo(rule.last_fired_at) : '';
        var enabledClass = rule.enabled ? 'badge-green' : 'badge-gray';
        var enabledLabel = rule.enabled ? 'Enabled' : 'Disabled';
        return '<div style="display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid #1a2e1f">'
          + '<div style="flex:1;min-width:0;margin-right:12px">'
          +   '<div style="font-weight:600;color:#F8FAFC;font-size:14px">' + escapeHtml(rule.name) + '</div>'
          +   '<div style="font-size:12px;color:#64748B;margin-top:2px">' + escapeHtml(label) + escapeHtml(firedInfo) + '</div>'
          + '</div>'
          + '<div style="display:flex;gap:6px;align-items:center;flex-shrink:0">'
          +   '<span class="badge ' + enabledClass + '">' + escapeHtml(rule.enabled ? pt('status.enabled') : pt('status.disabled')) + '</span>'
          +   '<button class="btn-secondary" style="padding:4px 10px;font-size:11px" onclick="testAutopilotRule(\'' + rule.id + '\')">'+  escapeHtml(pt('autopilot.test')) + '</button>'
          +   '<button class="btn-secondary" style="padding:4px 10px;font-size:11px" onclick="toggleAutopilotRule(\'' + rule.id + '\',' + !rule.enabled + ')">' + escapeHtml(rule.enabled ? pt('btn.disable') : pt('btn.enable')) + '</button>'
          +   '<button class="btn-secondary" style="padding:4px 10px;font-size:11px;color:#ef4444;border-color:rgba(239,68,68,0.4)" onclick="deleteAutopilotRule(\'' + rule.id + '\')">'+  escapeHtml(pt('btn.delete')) + '</button>'
          + '</div>'
          + '</div>';
      }).join('');
    }

    async function toggleAutopilotPause() {
      try {
        var endpoint = _autopilotPaused ? '/resume' : '/pause';
        await api('POST', '/api/churches/' + _autopilotChurchId + '/automation' + endpoint);
        await loadAutopilot();
      } catch(e) { toast('Failed: ' + e.message, true); }
    }

    async function testAutopilotRule(ruleId) {
      var resultEl = document.getElementById('test-rule-result');
      resultEl.innerHTML = '<div style="color:#475569;text-align:center;padding:16px">Running dry run\u2026</div>';
      document.getElementById('modal-test-rule').classList.add('open');
      try {
        var r = await api('POST', '/api/churches/' + _autopilotChurchId + '/automation/' + ruleId + '/test');
        var fireColor = r.wouldFire ? '#22c55e' : '#ef4444';
        var fireLabel = r.wouldFire ? pt('autopilot.test.would_fire') : pt('autopilot.test.would_not_fire');
        var html = '<div style="margin-bottom:14px">';
        html += '<div style="font-size:16px;font-weight:700;color:' + fireColor + '">' + escapeHtml(fireLabel) + '</div>';
        html += '<div style="color:#94A3B8;font-size:13px;margin-top:6px;line-height:1.5">' + escapeHtml(r.reason) + '</div>';
        html += '</div>';
        if (r.wouldFire && r.actions && r.actions.length) {
          html += '<div style="font-size:12px;color:#64748B;margin-bottom:6px">' + escapeHtml(pt('autopilot.test.actions_header')) + '</div>';
          html += r.actions.map(function(a) {
            return '<div style="background:#09090B;border-radius:6px;padding:8px 12px;font-family:monospace;font-size:12px;color:#22c55e;margin-bottom:4px">'
              + escapeHtml(a.command) + (a.params && Object.keys(a.params).length ? ' ' + escapeHtml(JSON.stringify(a.params)) : '')
              + '</div>';
          }).join('');
        }
        html += '<div style="font-size:11px;color:#475569;margin-top:12px;padding-top:10px;border-top:1px solid #1a2e1f">' + escapeHtml(r.note) + '</div>';
        resultEl.innerHTML = html;
      } catch(e) {
        resultEl.innerHTML = '<div style="color:#ef4444">' + escapeHtml(e.message) + '</div>';
      }
    }

    async function toggleAutopilotRule(ruleId, enabled) {
      try {
        await api('PUT', '/api/churches/' + _autopilotChurchId + '/automation/' + ruleId, { enabled: enabled });
        await loadAutopilot();
        toast(enabled ? 'Rule enabled' : 'Rule disabled');
      } catch(e) { toast('Failed: ' + e.message, true); }
    }

    async function deleteAutopilotRule(ruleId) {
      if (!await modalConfirm('Delete this automation rule?', { title: 'Delete Rule', okLabel: 'Delete', dangerOk: true })) return;
      try {
        await api('DELETE', '/api/churches/' + _autopilotChurchId + '/automation/' + ruleId);
        await loadAutopilot();
        toast('Rule deleted');
      } catch(e) { toast('Failed: ' + e.message, true); }
    }

    async function saveAutopilotRule() {
      var name = document.getElementById('rule-name').value.trim();
      var triggerType = document.getElementById('rule-trigger-type').value;
      var tcText = document.getElementById('rule-trigger-config').value.trim();
      var actionsText = document.getElementById('rule-actions').value.trim();
      if (!name) { toast('Rule name required', true); return; }
      if (!triggerType) { toast('Select a trigger type', true); return; }
      var triggerConfig = {};
      var actions = [];
      try { if (tcText) triggerConfig = JSON.parse(tcText); } catch(e) { toast('Trigger config must be valid JSON', true); return; }
      try { if (actionsText) actions = JSON.parse(actionsText); } catch(e) { toast('Actions must be valid JSON array', true); return; }
      var btn = document.getElementById('btn-save-rule');
      btn.disabled = true;
      try {
        await api('POST', '/api/churches/' + _autopilotChurchId + '/automation', { name, triggerType, triggerConfig, actions });
        document.getElementById('modal-add-rule').classList.remove('open');
        document.getElementById('rule-name').value = '';
        document.getElementById('rule-trigger-type').value = '';
        document.getElementById('rule-trigger-config').value = '';
        document.getElementById('rule-actions').value = '';
        await loadAutopilot();
        toast('Rule created');
      } catch(e) {
        if (e.upgradeUrl || (e.message && e.message.includes('Rule limit'))) {
          document.getElementById('modal-add-rule').classList.remove('open');
          var body = pt('upgrade.rule_limit_default');
          if (e.suggestedPlan) body += ' (' + e.suggestedPlan.charAt(0).toUpperCase() + e.suggestedPlan.slice(1) + ' plan)';
          document.getElementById('rule-limit-body').textContent = body;
          document.getElementById('modal-rule-limit').classList.add('open');
        } else {
          toast('Failed: ' + e.message, true);
        }
      }
      btn.disabled = false;
    }

    // ── Sessions ──────────────────────────────────────────────────────────────
    async function loadSessions() {
      try {
        const sessions = await api('GET', '/api/church/sessions');
        const tbody = document.getElementById('sessions-tbody');
        if (!sessions.length) {
          tbody.innerHTML = '<tr><td colspan="4" style="color:#475569;text-align:center;padding:20px">No sessions recorded yet.</td></tr>';
        } else {
          tbody.innerHTML = sessions.map(s => {
            const start = new Date(s.started_at);
            const end = s.ended_at ? new Date(s.ended_at) : null;
            const dur = end ? Math.round((end - start) / 60000) + 'm' : 'Active';
            return `<tr>
              <td>${start.toLocaleDateString()} <span style="color:#475569">${start.toLocaleTimeString()}</span></td>
              <td>${dur}</td>
              <td>${s.peak_viewers || '—'}</td>
              <td><span class="badge ${s.ended_at ? 'badge-gray' : 'badge-green'}">${s.ended_at ? 'Ended' : 'Live'}</span></td>
            </tr>`;
          }).join('');
          document.getElementById('stat-sessions').textContent = sessions.length;
        }
      } catch(e) { toast('Failed to load sessions', true); }
      // Also load AI reports
      loadServiceReports();
    }

    async function loadServiceReports() {
      var el = document.getElementById('service-reports-body');
      if (!el) return;
      try {
        var reports = await api('GET', '/api/church/service-reports?limit=5');
        if (!reports.length) {
          el.innerHTML = '<div style="color:#475569;text-align:center;padding:16px;font-size:13px">No reports yet — reports are generated automatically after each service session ends.</div>';
          return;
        }
        el.innerHTML = reports.map(function(r) {
          var dateStr = new Date(r.created_at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
          var grade = r.grade || '—';
          var gradeColor = grade.startsWith('A') ? '#22c55e' : grade.startsWith('B') ? '#eab308' : '#ef4444';
          var uptime = r.uptime_pct != null ? r.uptime_pct + '%' : '—';
          var recs = (r.recommendations || []).filter(function(rc) { return rc.priority === 'high'; });
          return '<div style="padding:14px 0;border-bottom:1px solid rgba(255,255,255,0.05)">'
            + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">'
            + '<span style="font-weight:600;font-size:13px">' + dateStr + '</span>'
            + '<div style="display:flex;align-items:center;gap:10px">'
            + '<span style="color:#94A3B8;font-size:12px">' + (r.duration_minutes || 0) + ' min · ' + uptime + ' uptime</span>'
            + '<span style="background:' + gradeColor + '22;color:' + gradeColor + ';border:1px solid ' + gradeColor + ';border-radius:6px;padding:2px 8px;font-size:13px;font-weight:700">' + grade + '</span>'
            + '</div></div>'
            + (r.ai_summary ? '<div style="font-size:12px;color:#94A3B8;line-height:1.5;margin-bottom:6px">' + escapeHtml(r.ai_summary) + '</div>' : '')
            + (recs.length ? '<div style="font-size:11px;color:#ef4444">' + recs.length + ' high-priority recommendation' + (recs.length !== 1 ? 's' : '') + ' — <a href="#" onclick="viewServiceReport(\'' + r.id + '\')" style="color:#22c55e">View report</a></div>' : '<div style="font-size:11px;color:#22c55e">No critical issues</div>')
            + '</div>';
        }).join('');
      } catch { el.innerHTML = '<div style="color:#475569;text-align:center;padding:16px;font-size:13px">Could not load reports.</div>'; }
    }

    async function viewServiceReport(reportId) {
      try {
        var r = await api('GET', '/api/church/service-reports/' + reportId);
        var modal = document.createElement('div');
        modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px';
        modal.onclick = function(e) { if (e.target === modal) document.body.removeChild(modal); };
        var inner = document.createElement('div');
        inner.style.cssText = 'background:#1a2433;border-radius:12px;width:100%;max-width:640px;max-height:85vh;overflow-y:auto';
        inner.innerHTML = '<div style="position:sticky;top:0;background:#1a2433;padding:12px 16px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid rgba(255,255,255,0.08)">'
          + '<span style="font-weight:600;color:#F8FAFC">Service Report</span>'
          + '<button onclick="this.closest(\'[style*=position]\').remove()" style="background:none;border:none;color:#94A3B8;font-size:18px;cursor:pointer">✕</button>'
          + '</div>'
          + '<div style="padding:16px">'
          + (r.ai_summary ? '<div style="background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.2);border-radius:8px;padding:14px;margin-bottom:16px"><div style="font-size:11px;font-weight:700;color:#22c55e;text-transform:uppercase;margin-bottom:6px">AI Summary</div><div style="font-size:13px;color:#F8FAFC;line-height:1.6">' + escapeHtml(r.ai_summary) + '</div></div>' : '')
          + '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px">'
          + '<div style="background:rgba(255,255,255,0.04);border-radius:6px;padding:12px;text-align:center"><div style="font-size:20px;font-weight:700;color:#F8FAFC">' + (r.duration_minutes || 0) + '<span style="font-size:11px;color:#64748B">m</span></div><div style="font-size:11px;color:#64748B;margin-top:2px">Duration</div></div>'
          + '<div style="background:rgba(255,255,255,0.04);border-radius:6px;padding:12px;text-align:center"><div style="font-size:20px;font-weight:700;color:#F8FAFC">' + (r.uptime_pct != null ? r.uptime_pct + '%' : '—') + '</div><div style="font-size:11px;color:#64748B;margin-top:2px">Uptime</div></div>'
          + '<div style="background:rgba(255,255,255,0.04);border-radius:6px;padding:12px;text-align:center"><div style="font-size:20px;font-weight:700;color:#F8FAFC">' + (r.alert_count || 0) + '</div><div style="font-size:11px;color:#64748B;margin-top:2px">Alerts</div></div>'
          + '</div>'
          + (r.recommendations && r.recommendations.length ? '<div style="margin-bottom:16px"><div style="font-size:12px;font-weight:700;color:#94A3B8;text-transform:uppercase;margin-bottom:8px">Recommendations</div>' + r.recommendations.map(function(rc) { var c = rc.priority === 'high' ? '#ef4444' : rc.priority === 'medium' ? '#eab308' : '#22c55e'; return '<div style="padding:8px 10px;border-left:3px solid ' + c + ';background:rgba(255,255,255,0.03);margin-bottom:6px;border-radius:0 6px 6px 0;font-size:12px;color:#F8FAFC;line-height:1.5">' + escapeHtml(rc.text) + '</div>'; }).join('') + '</div>' : '')
          + (r.failover_events && r.failover_events.length ? '<div><div style="font-size:12px;font-weight:700;color:#94A3B8;text-transform:uppercase;margin-bottom:8px">Failover Events</div>' + r.failover_events.map(function(f) { return '<div style="padding:6px 10px;font-size:12px;color:#F8FAFC;border-bottom:1px solid rgba(255,255,255,0.05)">' + new Date(f.timestamp).toLocaleTimeString() + ' · ' + escapeHtml(f.type || 'failover') + ' · ' + (f.autoRecovered ? 'auto-recovered' : 'manual') + '</div>'; }).join('') + '</div>' : '')
          + '</div>';
        modal.appendChild(inner);
        document.body.appendChild(modal);
      } catch(e) { toast('Failed to load report', true); }
    }

    // ── Migration Wizard ──────────────────────────────────────────────────────

    var _migrateSource = null;

    var MIGRATION_DATA = {
      'Planning Center': {
        icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" width="24" height="24" aria-hidden="true"><path d="M5.75 7.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM5 10.75a.75.75 0 1 1 1.5 0 .75.75 0 0 1-1.5 0ZM10.25 7.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM9.5 10.75a.75.75 0 1 1 1.5 0 .75.75 0 0 1-1.5 0ZM7.75 7.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM7 10.75a.75.75 0 1 1 1.5 0 .75.75 0 0 1-1.5 0Z"/><path fill-rule="evenodd" d="M4.75 1a.75.75 0 0 1 .75.75V3h5V1.75a.75.75 0 0 1 1.5 0V3h1A2.5 2.5 0 0 1 15.5 5.5v8a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 1.5 13.5v-8A2.5 2.5 0 0 1 4 3h.75V1.75A.75.75 0 0 1 4.75 1ZM3 6.5h10v7a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-7Z" clip-rule="evenodd"/></svg>',
        intro: "Planning Center is a great scheduling tool — Tally adds the live production monitoring and automation layer that PCO doesn't cover.",
        features: [
          { feature: 'Service Planning & Scheduling', them: 'Full', us: 'PCO Sync (Pro plan)' },
          { feature: 'Live Stream Monitoring', them: 'None', us: 'Real-time, all platforms' },
          { feature: 'ATEM / OBS / Encoder Control', them: 'None', us: '26 device integrations' },
          { feature: 'Auto-Recovery', them: 'None', us: 'AI-powered failover' },
          { feature: 'Telegram Alerts', them: 'None', us: 'Real-time TD alerts' },
          { feature: 'Pre-Service Checks', them: 'None', us: 'Auto 30 min before service' },
        ],
        steps: [
          { title: 'Connect PCO Sync', detail: 'Go to Integrations → Planning Center and authorize your PCO account. Tally will pull your service schedule automatically.' },
          { title: 'Install Tally desktop app', detail: 'Download the Tally app on your production computer. Sign in with your church ID.' },
          { title: 'Add your ATEM or OBS', detail: 'In Equipment, add your ATEM switcher and OBS connection. Tally will start monitoring immediately.' },
          { title: 'Register your TD on Telegram', detail: 'Use the "Copy Invite Link" on the TDs page and share it with your tech director.' },
          { title: 'Set your service schedule', detail: 'Review your imported schedule or manually configure your Sunday service window.' },
        ],
        importNote: 'Your Planning Center service schedule can be imported automatically via the PCO Sync integration (Pro plan required).',
      },
      'ProPresenter Standalone': {
        icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" width="24" height="24" aria-hidden="true"><path fill-rule="evenodd" d="M1.5 3A1.5 1.5 0 0 0 0 4.5v8A1.5 1.5 0 0 0 1.5 14h13A1.5 1.5 0 0 0 16 12.5v-8A1.5 1.5 0 0 0 14.5 3h-13Zm1 .5h1v1h-1V3.5Zm0 2h1v1h-1v-1Zm0 2h1v1h-1v-1Zm0 2h1v1h-1v-1Zm0 2h1v1h-1v-1Zm9 0h1v1h-1v-1Zm1-2h-1v1h1v-1Zm-1-2h1v1h-1v-1Zm1-2h-1v1h1v-1Zm-1-2h1v1h-1v-1Zm-7.5 1H10v6H4V3.5Z" clip-rule="evenodd"/></svg>',
        intro: "ProPresenter handles slides and graphics — Tally monitors your entire production stack and adds live stream recovery so your broadcast doesn't fail.",
        features: [
          { feature: 'Slides / Graphics', them: 'Best in class', us: 'Works alongside PP7' },
          { feature: 'Live Stream Monitoring', them: 'None', us: 'Real-time' },
          { feature: 'OBS / ATEM Integration', them: 'Limited (NDI only)', us: 'Full WebSocket + IP control' },
          { feature: 'Auto-Recovery from stream drops', them: 'None', us: 'AI failover in seconds' },
          { feature: 'ProPresenter Remote Control', them: 'Stage Display only', us: 'Full remote via Telegram' },
          { feature: 'Pre-Service Checks', them: 'None', us: 'PP7 connection included' },
        ],
        steps: [
          { title: 'Install Tally alongside ProPresenter', detail: "Tally runs as a background app — it doesn't replace PP7, it adds monitoring around it." },
          { title: 'Enable ProPresenter connection in Tally', detail: 'In Equipment, add ProPresenter using its local IP and port 50000.' },
          { title: 'Add your streaming setup', detail: 'Connect OBS via WebSocket and/or your ATEM. Tally will monitor both.' },
          { title: 'Set Telegram alerts', detail: 'When Tally detects a PP7 disconnect or stream issue, your TD gets a Telegram alert immediately.' },
          { title: 'Configure pre-service check', detail: 'Set your service windows so Tally auto-checks PP7 is connected before each service.' },
        ],
        importNote: 'No import needed — Tally works alongside ProPresenter. Both run simultaneously.',
      },
      'vMix': {
        icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" width="24" height="24" aria-hidden="true"><path fill-rule="evenodd" d="M0 3.5A1.5 1.5 0 0 1 1.5 2h13A1.5 1.5 0 0 1 16 3.5v8a1.5 1.5 0 0 1-1.5 1.5h-4.25l.5 2.25h1.5a.75.75 0 0 1 0 1.5H4.25a.75.75 0 0 1 0-1.5h1.5l.5-2.25H1.5A1.5 1.5 0 0 1 0 11.5v-8Z" clip-rule="evenodd"/></svg>',
        intro: 'vMix is powerful for complex productions — Tally connects to it via its web API and adds monitoring, alerts, and Telegram control.',
        features: [
          { feature: 'Multi-camera production', them: 'Full', us: 'Connects to existing vMix setup' },
          { feature: 'Stream health monitoring', them: 'Local only', us: 'Cloud dashboard + alerts' },
          { feature: 'Telegram alerts', them: 'None', us: 'Real-time' },
          { feature: 'Auto-recovery', them: 'Manual', us: 'AI-powered' },
          { feature: 'Pre-service checks', them: 'None', us: 'vMix API check included' },
        ],
        steps: [
          { title: 'Enable vMix Web Controller', detail: 'In vMix settings, enable Web Controller on port 8088. Tally uses this to monitor and control.' },
          { title: 'Add vMix in Tally Equipment', detail: "Enter your vMix computer's IP and port 8088. Tally will connect and start monitoring." },
          { title: 'Connect your streaming outputs', detail: 'Add YouTube/Facebook OAuth in Tally for viewer count and stream health monitoring.' },
          { title: 'Set up TD alerts', detail: 'Register your tech director on Telegram using the Copy Invite Link button.' },
        ],
        importNote: 'vMix settings and presets stay in vMix — Tally adds a monitoring and alert layer on top.',
      },
      'Wirecast': {
        icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" width="24" height="24" aria-hidden="true"><path d="M2.5 1.75a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0ZM5.25 4a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM9 10.75a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0ZM11.75 13.5a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM4.28 2.22a.75.75 0 0 0-1.06 1.06L5.44 5.5l-1.72 1.72a3.5 3.5 0 0 0 4.95 4.95L10.5 10.5l2.22 2.22a.75.75 0 1 0 1.06-1.06L10.5 9.44l1.72-1.72a3.5 3.5 0 0 0-4.95-4.95L5.5 4.44 4.28 2.22Z"/></svg>',
        intro: 'Wirecast handles encoding and streaming — Tally monitors the full production chain and alerts your team when issues occur.',
        features: [
          { feature: 'Multi-source encoding', them: 'Full', us: 'Works alongside Wirecast' },
          { feature: 'Stream health dashboard', them: 'Local only', us: 'Cloud, multi-platform' },
          { feature: 'Auto-recovery', them: 'Manual restart', us: 'AI auto-recover' },
          { feature: 'ATEM integration', them: 'NDI only', us: 'Full ATEM IP control' },
          { feature: 'Telegram alerts', them: 'None', us: 'Real-time TD alerts' },
        ],
        steps: [
          { title: 'Install Tally on your production computer', detail: 'Tally runs alongside Wirecast. Both can be open at the same time.' },
          { title: 'Connect your ATEM switcher', detail: 'Add your ATEM in Tally Equipment. Tally will monitor scene cuts and detect signal loss.' },
          { title: 'Add your streaming platform', detail: 'Authorize YouTube or Facebook in Tally to monitor viewer count and stream health.' },
          { title: 'Set up Telegram alerts', detail: 'Get real-time alerts when Wirecast loses signal or your stream drops.' },
        ],
        importNote: 'No import needed — Tally adds monitoring around your existing Wirecast setup.',
      },
      'Companion Only': {
        icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" width="24" height="24" aria-hidden="true"><path d="M3 4.5a3 3 0 0 1 3-3h4a3 3 0 0 1 3 3v.5h.5A1.5 1.5 0 0 1 15 6.5v3a1.5 1.5 0 0 1-1.5 1.5H13a3 3 0 0 1-2.83 2h-4.34A3 3 0 0 1 3 11h-.5A1.5 1.5 0 0 1 1 9.5v-3A1.5 1.5 0 0 1 2.5 5H3v-.5ZM6 5h4V4.5a1.5 1.5 0 0 0-1.5-1.5h-1A1.5 1.5 0 0 0 6 4.5V5ZM5 7.5H4V9h1V7.5ZM12 9V7.5h-1V9h1ZM7 8a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm2 0a1 1 0 1 1 2 0 1 1 0 0 1-2 0Z"/></svg>',
        intro: "If you're already using Bitfocus Companion, you're halfway there — Tally integrates directly with Companion and adds monitoring, cloud dashboard, and AI recovery.",
        features: [
          { feature: 'Button deck control', them: 'Best in class', us: 'Companion integration built-in' },
          { feature: 'Cloud portal / dashboard', them: 'None', us: 'Full web portal' },
          { feature: 'Monitoring & alerts', them: 'None', us: 'Real-time' },
          { feature: 'Auto-recovery', them: 'Manual', us: 'AI failover' },
          { feature: 'Telegram alerts', them: 'Via HTTP action', us: 'Native, role-aware' },
        ],
        steps: [
          { title: 'Add Companion in Tally Equipment', detail: "Enter your Companion computer's IP and port 8000. Tally will connect to the Companion HTTP API." },
          { title: 'Keep your existing Companion setup', detail: 'None of your existing Companion buttons or modules need to change.' },
          { title: 'Install Tally app for ATEM/OBS monitoring', detail: 'Tally adds visibility and AI recovery to the devices Companion already controls.' },
          { title: 'Enable Tally → Companion triggers', detail: 'In Autopilot, you can set rules that trigger Companion button presses on device events.' },
        ],
        importNote: 'Your Companion configuration imports automatically when you connect Companion to Tally.',
      },
      'Nothing — New Setup': {
        icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" width="24" height="24" aria-hidden="true"><path d="M8 1C4.686 1 2 3.686 2 7v1.5c0 .828.672 1.5 1.5 1.5H4v1a4 4 0 0 0 8 0v-1h.5c.828 0 1.5-.672 1.5-1.5V7c0-3.314-2.686-6-6-6Zm0 2a4 4 0 0 1 4 4H4a4 4 0 0 1 4-4Zm0 7a2 2 0 0 1-2-2h4a2 2 0 0 1-2 2Z"/></svg>',
        intro: "You're starting fresh — great! Follow these steps to get Tally running for your first service.",
        features: [],
        steps: [
          { title: 'Download the Tally desktop app', detail: 'Install on the computer that runs your production software (OBS, ProPresenter, etc.).' },
          { title: 'Connect your ATEM switcher', detail: "Enter your ATEM's IP address in Equipment → Add Device. Tally auto-detects the model." },
          { title: 'Connect OBS via WebSocket', detail: 'In OBS: Tools → WebSocket Server Settings. Enable it and note the port (default 4455).' },
          { title: 'Set up Telegram alerts', detail: 'Register your tech director using the Copy Invite Link button on the TDs page.' },
          { title: 'Run your first pre-service check', detail: 'Click "Run Check Now" on the dashboard 30 minutes before your service.' },
        ],
        importNote: null,
      },
      'Other': {
        icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" width="24" height="24" aria-hidden="true"><path fill-rule="evenodd" d="M9.66 1.2a5 5 0 0 0-5.956 6.437L1.146 10.2A.5.5 0 0 0 1 10.56V14a.5.5 0 0 0 .5.5h3.44a.5.5 0 0 0 .354-.146l2.563-2.558A5 5 0 0 0 13.8 6.34l-2.122 2.121a2.5 2.5 0 0 1-3.536-3.536L10.264 2.8A4.978 4.978 0 0 0 9.66 1.2Z" clip-rule="evenodd"/></svg>',
        intro: "Tally works alongside most production software. Here's the standard setup path.",
        features: [],
        steps: [
          { title: 'Install the Tally app', detail: 'Download and install on your production computer.' },
          { title: 'Add your devices', detail: 'In Equipment, add your ATEM (by IP), OBS (WebSocket), encoders, and ProPresenter.' },
          { title: 'Set up Telegram alerts', detail: "Share the invite link with your tech director so they're connected for Sunday." },
          { title: 'Set your service schedule', detail: 'Configure your Sunday service window so Tally knows when to send alerts.' },
          { title: 'Run a pre-service check', detail: 'Test the system by clicking Run Check Now before your next service.' },
        ],
        importNote: null,
      },
    };

    function initMigrationWizard() {
      // Populate source grid if empty
      var grid = document.getElementById('migrate-source-grid');
      if (grid && !grid.children.length) {
        ['Planning Center', 'ProPresenter Standalone', 'vMix', 'Wirecast', 'Companion Only', 'Nothing — New Setup', 'Other'].forEach(function(s) {
          var btn = document.createElement('button');
          btn.className = 'migrate-source-btn';
          btn.style.cssText = 'background:#09090B;border:2px solid #1a2e1f;border-radius:10px;padding:16px 12px;text-align:center;cursor:pointer;transition:all 0.15s;color:#F8FAFC;font-size:13px;font-weight:600';
          btn.textContent = s;
          btn.onclick = function() { selectMigrateSource(s, btn); };
          grid.appendChild(btn);
        });
      }
      // Reset to step 1
      document.getElementById('migrate-step-1').style.display = '';
      document.getElementById('migrate-step-2').style.display = 'none';
      document.getElementById('migrate-step-2').innerHTML = '';
      document.querySelectorAll('.migrate-source-btn').forEach(function(b) {
        b.style.borderColor = '#1a2e1f';
        b.style.background = '#09090B';
      });
      _migrateSource = null;
    }

    function selectMigrateSource(source, btn) {
      _migrateSource = source;
      document.querySelectorAll('.migrate-source-btn').forEach(function(b) {
        b.style.borderColor = '#1a2e1f';
        b.style.background = '#09090B';
        b.style.color = '#F8FAFC';
      });
      btn.style.borderColor = '#22c55e';
      btn.style.background = 'rgba(34,197,94,0.08)';
      btn.style.color = '#22c55e';
      renderMigrationGuide(source);
    }

    function renderMigrationGuide(source) {
      var data = MIGRATION_DATA[source];
      if (!data) return;
      var step2 = document.getElementById('migrate-step-2');
      step2.style.display = '';

      var html = '';

      // Intro
      html += '<div class="card"><div style="display:flex;align-items:center;gap:10px;margin-bottom:12px"><span style="font-size:24px">' + data.icon + '</span><div><div class="card-title" style="margin:0">Switching from ' + escapeHtml(source) + '</div></div></div><p style="color:#94A3B8;font-size:14px;line-height:1.6;margin:0">' + escapeHtml(data.intro) + '</p></div>';

      // Feature comparison (if available)
      if (data.features.length > 0) {
        html += '<div class="card"><div class="card-title" style="margin-bottom:12px">Feature Comparison</div><div class="table-wrap"><table>';
        html += '<thead><tr><th>Capability</th><th>' + escapeHtml(source) + '</th><th>Tally</th></tr></thead><tbody>';
        html += data.features.map(function(f) {
          return '<tr><td style="font-size:13px">' + escapeHtml(f.feature) + '</td>'
            + '<td style="font-size:13px;color:#94A3B8">' + escapeHtml(f.them) + '</td>'
            + '<td style="font-size:13px;color:#22c55e;font-weight:500">' + escapeHtml(f.us) + '</td></tr>';
        }).join('');
        html += '</tbody></table></div></div>';
      }

      // Setup steps
      html += '<div class="card"><div class="card-title" style="margin-bottom:16px">Your Setup Checklist</div>';
      html += data.steps.map(function(step, i) {
        return '<div style="display:flex;gap:14px;padding:12px 0;border-bottom:1px solid rgba(255,255,255,0.05)">'
          + '<div style="min-width:28px;height:28px;background:rgba(34,197,94,0.1);border:2px solid #22c55e;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#22c55e;flex-shrink:0">' + (i+1) + '</div>'
          + '<div><div style="font-weight:600;font-size:13px;margin-bottom:4px">' + escapeHtml(step.title) + '</div>'
          + '<div style="font-size:12px;color:#94A3B8;line-height:1.5">' + escapeHtml(step.detail) + '</div></div>'
          + '</div>';
      }).join('');
      html += '</div>';

      // Import note
      if (data.importNote) {
        html += '<div class="card" style="background:rgba(34,197,94,0.05);border-color:rgba(34,197,94,0.2)"><div style="display:flex;gap:10px;align-items:flex-start"><span><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" fill="currentColor" width="18" height="18" aria-hidden="true"><path d="M3 2a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V5.414A1 1 0 0 0 15.707 5L13 2.293A1 1 0 0 0 12.586 2H3Zm0 1h9v3a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V3Zm2 8a3 3 0 1 1 6 0 3 3 0 0 1-6 0Z"/></svg></span><div><div style="font-weight:600;font-size:13px;margin-bottom:4px">Import / Migration Note</div><div style="font-size:13px;color:#94A3B8;line-height:1.5">' + escapeHtml(data.importNote) + '</div></div></div></div>';
      }

      // CTA
      html += '<div style="text-align:center;padding:8px 0 16px"><button class="btn-primary" onclick="showPage(\'team\', document.querySelector(\'[data-page=team]\'))" style="margin-right:8px">Set Up Tech Directors →</button><button class="btn-secondary" onclick="showPage(\'engineer\', document.querySelector(\'[data-page=engineer]\'))">Open Tally Engineer</button></div>';

      step2.innerHTML = html;
      step2.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    // ── Billing ───────────────────────────────────────────────────────────────
    let billingData = null;
    async function loadBilling() {
      try {
        const b = await api('GET', '/api/church/billing');
        billingData = b;
        const statusColors = { active: '#22c55e', trialing: '#eab308', past_due: '#ef4444', canceled: '#94A3B8', pending: '#94A3B8', trial_expired: '#ef4444', inactive: '#94A3B8' };
        const statusLabels = { active: 'Active', trialing: 'Trial', past_due: 'Past Due', canceled: 'Canceled', pending: 'Pending', trial_expired: 'Expired', inactive: 'Inactive' };
        const tierName = b.tierName || b.tier || 'Connect';
        const intervalName = b.billingIntervalLabel || (b.billingInterval === 'annual' ? 'Annual' : (b.billingInterval === 'one_time' ? 'One-time' : 'Monthly'));
        const statusColor = statusColors[b.status] || '#94A3B8';
        const statusLabel = statusLabels[b.status] || b.status;

        let html = '<div class="card" style="margin-bottom:16px">';
        html += '<div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">';
        html += '<span style="font-size:20px;font-weight:800;color:#F8FAFC">' + tierName + '</span>';
        html += '<span style="background:#111827;color:#94A3B8;padding:2px 10px;border-radius:12px;font-size:11px;font-weight:700">' + intervalName + '</span>';
        html += '<span style="background:' + statusColor + ';color:#000;padding:2px 10px;border-radius:12px;font-size:11px;font-weight:700">' + statusLabel + '</span>';
        html += '</div>';

        if (b.status === 'trialing' && b.trialDaysRemaining != null) {
          const pct = Math.max(0, Math.min(100, ((30 - b.trialDaysRemaining) / 30) * 100));
          html += '<div style="background:rgba(234,179,8,0.08);border:1px solid rgba(234,179,8,0.3);border-radius:8px;padding:12px;margin-bottom:16px">';
          html += '<div style="color:#eab308;font-size:13px;font-weight:600;margin-bottom:6px">Trial: ' + b.trialDaysRemaining + ' days remaining</div>';
          html += '<div style="background:#1a2e1f;border-radius:4px;height:6px;overflow:hidden"><div style="background:#eab308;height:100%;width:' + pct + '%;border-radius:4px"></div></div>';
          html += '</div>';
        }

        if (b.status === 'past_due') {
          html += '<div style="background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.3);border-radius:8px;padding:12px;margin-bottom:16px">';
          html += '<div style="color:#ef4444;font-size:13px;font-weight:600">Payment failed — update your card to avoid service interruption.</div></div>';
        }

        html += '<h3 style="font-size:14px;color:#F8FAFC;margin:12px 0 8px">Your Plan Includes</h3>';
        html += '<div class="grid-2col" style="gap:6px;font-size:13px">';
        const features = b.features || {};
        const includedFeatures = [
          ['ATEM + encoder monitoring (OBS, vMix, NDI, hardware)', true],
          ['Pre-service checks', true],
          ['Slack + Telegram alerts', true],
          ['Auto-recovery', true],
          ['ProPresenter control', features.propresenter],
          ['On-call TD rotation', features.oncall],
          ['Live video preview', features.livePreview],
          ['AI Autopilot', features.autopilot],
          ['Planning Center sync', features.planningCenter],
          ['Monthly reports', features.monthlyReport],
        ];
        includedFeatures.forEach(function(f) {
          if (f[1]) html += '<div style="color:#94A3B8">\\u2713 ' + f[0] + '</div>';
        });
        html += '</div></div>';

        // AI Diagnostics usage progress bar
        if (b.aiUsage && b.aiUsage.diagnosticLimit !== Infinity && b.aiUsage.diagnosticLimit !== null) {
          var aiPct = Math.min(100, Math.round((b.aiUsage.diagnosticUsage / b.aiUsage.diagnosticLimit) * 100));
          var aiBarColor = aiPct >= 80 ? '#eab308' : '#22c55e';
          html += '<div class="card" style="margin-bottom:16px">';
          html += '<h3 style="font-size:14px;color:#F8FAFC;margin:0 0 8px">AI Diagnostics</h3>';
          html += '<div style="color:#94A3B8;font-size:13px;margin-bottom:8px">' + b.aiUsage.diagnosticUsage + ' / ' + b.aiUsage.diagnosticLimit + ' messages this month</div>';
          html += '<div style="background:#1F2937;border-radius:4px;height:6px;overflow:hidden">';
          html += '<div style="background:' + aiBarColor + ';height:100%;width:' + aiPct + '%;border-radius:4px;transition:width 0.3s"></div></div>';
          html += '<div style="color:#64748B;font-size:11px;margin-top:4px">Resets ' + (b.aiUsage.diagnosticResetDate || '1st of next month') + '</div>';
          html += '</div>';
        }

        // Upgrade cards for locked features
        var currentTier = (b.tier || 'connect').toLowerCase();

        if (currentTier === 'connect') {
          // Plus upgrade card
          html += '<div style="margin-bottom:16px;background:rgba(34,197,94,0.04);border:1px solid rgba(34,197,94,0.2);border-radius:12px;padding:20px 24px">';
          html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">';
          html += '<span style="background:rgba(34,197,94,0.12);color:#22c55e;padding:3px 10px;border-radius:12px;font-size:10px;font-weight:800;letter-spacing:0.08em;font-family:ui-monospace,monospace">PLUS</span>';
          html += '<span style="color:#F8FAFC;font-size:14px;font-weight:700">Unlock with Plus</span>';
          html += '</div>';
          html += '<div class="grid-2col" style="gap:6px;font-size:13px;margin-bottom:16px">';
          html += '<div style="color:#94A3B8">✦ ProPresenter control (looks, timers, stage)</div>';
          html += '<div style="color:#94A3B8">✦ Live video preview stream</div>';
          html += '<div style="color:#94A3B8">✦ On-call TD rotation</div>';
          html += '<div style="color:#94A3B8">✦ Up to 3 rooms</div>';
          html += '</div>';
          html += '<button onclick="upgradePlan(\'plus\')" id="btn-upgrade-plus" style="display:inline-block;padding:8px 20px;font-size:13px;font-weight:700;border-radius:8px;background:#22c55e;color:#000;border:none;cursor:pointer">Upgrade to Plus — $99/mo →</button>';
          html += '</div>';

          // Pro upgrade card
          html += '<div style="margin-bottom:16px;background:rgba(34,197,94,0.04);border:1px solid rgba(34,197,94,0.2);border-radius:12px;padding:20px 24px">';
          html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">';
          html += '<span style="background:rgba(34,197,94,0.12);color:#22c55e;padding:3px 10px;border-radius:12px;font-size:10px;font-weight:800;letter-spacing:0.08em;font-family:ui-monospace,monospace">PRO</span>';
          html += '<span style="color:#F8FAFC;font-size:14px;font-weight:700">Unlock with Pro</span>';
          html += '</div>';
          html += '<div class="grid-2col" style="gap:6px;font-size:13px;margin-bottom:16px">';
          html += '<div style="color:#94A3B8">✦ Everything in Plus</div>';
          html += '<div style="color:#94A3B8">✦ AI Autopilot automation rules</div>';
          html += '<div style="color:#94A3B8">✦ Planning Center sync + write-back</div>';
          html += '<div style="color:#94A3B8">✦ Monthly leadership reports</div>';
          html += '<div style="color:#94A3B8">✦ Up to 5 rooms</div>';
          html += '</div>';
          html += '<button onclick="upgradePlan(\'pro\')" id="btn-upgrade-pro" style="display:inline-block;padding:8px 20px;font-size:13px;font-weight:700;border-radius:8px;background:transparent;color:#22c55e;border:1px solid rgba(34,197,94,0.3);cursor:pointer">Upgrade to Pro — $149/mo →</button>';
          html += '</div>';
        } else if (currentTier === 'plus') {
          // Pro upgrade card only
          html += '<div style="margin-bottom:16px;background:rgba(34,197,94,0.04);border:1px solid rgba(34,197,94,0.2);border-radius:12px;padding:20px 24px">';
          html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">';
          html += '<span style="background:rgba(34,197,94,0.12);color:#22c55e;padding:3px 10px;border-radius:12px;font-size:10px;font-weight:800;letter-spacing:0.08em;font-family:ui-monospace,monospace">PRO</span>';
          html += '<span style="color:#F8FAFC;font-size:14px;font-weight:700">Unlock with Pro</span>';
          html += '</div>';
          html += '<div class="grid-2col" style="gap:6px;font-size:13px;margin-bottom:16px">';
          html += '<div style="color:#94A3B8">✦ AI Autopilot automation rules</div>';
          html += '<div style="color:#94A3B8">✦ Planning Center sync + write-back</div>';
          html += '<div style="color:#94A3B8">✦ Monthly leadership reports</div>';
          html += '<div style="color:#94A3B8">✦ Up to 5 rooms</div>';
          html += '</div>';
          html += '<button onclick="upgradePlan(\'pro\')" id="btn-upgrade-pro" style="display:inline-block;padding:8px 20px;font-size:13px;font-weight:700;border-radius:8px;background:#22c55e;color:#000;border:none;cursor:pointer">Upgrade to Pro — $149/mo →</button>';
          html += '</div>';
        }

        if (b.portalUrl) {
          html += '<div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:12px">';
          html += '<a href="' + b.portalUrl + '" target="_blank" class="btn-primary" style="display:inline-block;text-decoration:none">Manage Subscription →</a>';
          if (['active','trialing'].includes(b.status) && !b.cancelAtPeriodEnd) {
            html += '<button onclick="cancelSubscription()" style="background:none;border:1px solid rgba(239,68,68,0.3);color:#ef4444;font-size:13px;padding:8px 16px;border-radius:8px;cursor:pointer;font-weight:600">Cancel Subscription</button>';
          }
          html += '</div>';
          if (b.cancelAtPeriodEnd && b.currentPeriodEnd) {
            var endLabel = new Date(b.currentPeriodEnd).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
            html += '<div style="background:rgba(234,179,8,0.08);border:1px solid rgba(234,179,8,0.3);border-radius:8px;padding:10px 16px;margin-bottom:12px;font-size:13px;color:#eab308">Cancellation scheduled. Your plan will remain active until <strong>' + endLabel + '</strong>.</div>';
          }
          html += '<p style="color:#475569;font-size:12px">Update payment method and view invoices from the Stripe portal.</p>';
        }

        // Reactivation button for cancelled/expired/inactive churches
        if (['trial_expired','canceled','inactive'].includes(b.status)) {
          html += '<div style="margin-top:16px;background:rgba(34,197,94,0.06);border:1px solid rgba(34,197,94,0.2);border-radius:12px;padding:20px 24px">';
          html += '<div style="font-size:15px;font-weight:700;color:#22c55e;margin-bottom:8px">Reactivate Your Subscription</div>';
          html += '<div style="font-size:13px;color:#94A3B8;line-height:1.6;margin-bottom:14px">Your settings and data are still here. Reactivate to resume monitoring immediately.</div>';
          html += '<button onclick="reactivateSubscription()" id="btn-reactivate" class="btn-primary" style="cursor:pointer">Reactivate Now →</button>';
          html += '</div>';
        }

        // Downgrade option (only show for tiers above connect)
        if (['active','trialing'].includes(b.status) && currentTier !== 'connect') {
          html += '<div style="margin-top:16px;background:#0F1613;border:1px solid #1a2e1f;border-radius:12px;padding:16px 24px">';
          html += '<div style="font-size:13px;color:#94A3B8;margin-bottom:8px">Need fewer features?</div>';
          if (currentTier === 'managed' || currentTier === 'pro') {
            html += '<button onclick="downgradePlan(\'plus\')" style="background:none;border:1px solid #1a2e1f;color:#94A3B8;font-size:12px;padding:6px 14px;border-radius:6px;cursor:pointer;margin-right:8px">Downgrade to Plus ($99/mo)</button>';
            html += '<button onclick="downgradePlan(\'connect\')" style="background:none;border:1px solid #1a2e1f;color:#94A3B8;font-size:12px;padding:6px 14px;border-radius:6px;cursor:pointer">Downgrade to Connect ($49/mo)</button>';
          } else if (currentTier === 'plus') {
            html += '<button onclick="downgradePlan(\'connect\')" style="background:none;border:1px solid #1a2e1f;color:#94A3B8;font-size:12px;padding:6px 14px;border-radius:6px;cursor:pointer">Downgrade to Connect ($49/mo)</button>';
          }
          html += '</div>';
        }

        // Data export & account management
        html += '<div style="margin-top:24px;padding-top:16px;border-top:1px solid #1a2e1f">';
        html += '<div style="font-size:14px;font-weight:700;color:#F8FAFC;margin-bottom:12px">Data & Privacy</div>';
        html += '<div style="display:flex;gap:8px;flex-wrap:wrap">';
        html += '<button onclick="exportData()" style="background:none;border:1px solid #1a2e1f;color:#94A3B8;font-size:12px;padding:6px 14px;border-radius:6px;cursor:pointer">Export All Data (JSON)</button>';
        html += '<button onclick="deleteAccount()" style="background:none;border:1px solid rgba(239,68,68,0.3);color:#ef4444;font-size:12px;padding:6px 14px;border-radius:6px;cursor:pointer">Delete Account</button>';
        html += '</div>';
        html += '<p style="color:#475569;font-size:11px;margin-top:8px;line-height:1.5">Export downloads a JSON file with all your church data. Deletion is permanent and cannot be undone.</p>';
        html += '</div>';

        html += '<div style="margin-top:16px;padding-top:12px;border-top:1px solid #1a2e1f">';
        html += '<p style="color:#475569;font-size:12px;line-height:1.6">Cancel anytime. Service continues through the end of your billing period. No partial-month refunds. Questions? <a href="mailto:support@tallyconnect.app" style="color:#22c55e">support@tallyconnect.app</a></p>';
        html += '</div>';

        document.getElementById('billing-content').innerHTML = html;
        updateBillingBanner(b);
        renderUpgradeBanner(b);
      } catch(e) {
        document.getElementById('billing-content').innerHTML = '<div style="color:#475569;text-align:center;padding:30px">Billing info unavailable. <a href="mailto:support@tallyconnect.app" style="color:#22c55e">Contact support</a></div>';
      }
    }

    function updateBillingBanner(b) {
      var el = document.getElementById('billing-banner');
      if (!el) return;
      var lnk = 'color:#22c55e;font-weight:700';
      if (b.status === 'trialing' && b.trialDaysRemaining != null && b.trialDaysRemaining <= 7) {
        var dayWord = b.trialDaysRemaining !== 1 ? pt('billing.banner.days') : pt('billing.banner.day');
        el.innerHTML = '<div style="background:rgba(234,179,8,0.08);border:1px solid rgba(234,179,8,0.3);border-radius:8px;padding:10px 16px;margin-bottom:16px;font-size:13px;color:#eab308">' + pt('billing.banner.trial_pre') + ' ' + b.trialDaysRemaining + ' ' + dayWord + '. <a href="https://tallyconnect.app/signup" style="' + lnk + '">' + pt('billing.banner.trial_link') + '</a> ' + pt('billing.banner.trial_post') + '</div>';
      } else if (b.status === 'past_due') {
        el.innerHTML = '<div style="background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.3);border-radius:8px;padding:10px 16px;margin-bottom:16px;font-size:13px;color:#ef4444">' + pt('billing.banner.past_due_msg') + ' <a href="' + (b.portalUrl || 'https://tallyconnect.app/signup') + '" style="' + lnk + '">' + pt('billing.banner.past_due_link') + '</a> ' + pt('billing.banner.past_due_post') + '</div>';
      } else if (b.status === 'canceled' || b.status === 'trial_expired') {
        el.innerHTML = '<div style="background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.3);border-radius:8px;padding:10px 16px;margin-bottom:16px;font-size:13px;color:#ef4444">' + pt('billing.banner.canceled_msg') + ' <a href="#" onclick="showPage(\'billing\',document.querySelector(\'[data-page=billing]\'));return false" style="' + lnk + '">' + pt('billing.banner.reactivate_link') + '</a> ' + pt('billing.banner.canceled_post') + '</div>';
      } else if (b.status === 'inactive' || b.status === 'pending') {
        el.innerHTML = '<div style="background:rgba(234,179,8,0.08);border:1px solid rgba(234,179,8,0.3);border-radius:8px;padding:10px 16px;margin-bottom:16px;font-size:13px;color:#eab308">' + pt('billing.banner.inactive_msg') + ' <a href="https://tallyconnect.app/signup" style="' + lnk + '">' + pt('billing.banner.checkout_link') + '</a> ' + pt('billing.banner.inactive_post') + '</div>';
      } else {
        el.innerHTML = '';
      }
    }

    // ── Upgrade Banner (Overview page) ──────────────────────────────────────
    function renderUpgradeBanner(b) {
      var el = document.getElementById('upgrade-banner');
      if (!el) return;
      var tier = (b.tier || 'connect').toLowerCase();
      var status = b.status || 'inactive';

      // Only show for active/trialing on connect or plus
      if (!['active', 'trialing'].includes(status)) { el.innerHTML = ''; return; }
      if (tier !== 'connect' && tier !== 'plus') { el.innerHTML = ''; return; }

      // Check localStorage dismiss
      var dismissKey = 'tally_upgrade_dismissed_' + tier;
      if (localStorage.getItem(dismissKey) === '1') { el.innerHTML = ''; return; }

      var nextTierSlug = tier === 'connect' ? 'plus' : 'pro';
      var nextTier = tier === 'connect' ? 'Plus' : 'Pro';
      var nextPrice = tier === 'connect' ? '$99' : '$149';
      var headline = pt(tier === 'connect' ? 'upgrade.connect.headline' : 'upgrade.plus.headline');
      var body = pt(tier === 'connect' ? 'upgrade.connect.body' : 'upgrade.plus.body');
      var btnLabel = pt('upgrade.btn', { tier: nextTier, price: nextPrice });

      el.innerHTML = '<div style="margin-bottom:20px;background:rgba(34,197,94,0.06);border:1px solid rgba(34,197,94,0.25);border-radius:12px;padding:20px 24px;position:relative">' +
        '<button onclick="dismissUpgradeBanner(\''+dismissKey+'\')" style="position:absolute;top:12px;right:14px;background:none;border:none;color:#475569;font-size:16px;cursor:pointer;padding:4px" title="Dismiss">\\u2715</button>' +
        '<div style="font-size:15px;font-weight:700;color:#22c55e;margin-bottom:6px">' + headline + '</div>' +
        '<div style="font-size:13px;color:#94A3B8;line-height:1.6;margin-bottom:14px;padding-right:24px">' + body + '</div>' +
        '<button onclick="upgradePlan(\'' + nextTierSlug + '\')" id="btn-upgrade-' + nextTierSlug + '-banner" style="display:inline-block;padding:8px 20px;font-size:13px;font-weight:700;border-radius:8px;background:#22c55e;color:#000;border:none;cursor:pointer">' + btnLabel + '</button>' +
        '</div>';
    }

    function dismissUpgradeBanner(key) {
      localStorage.setItem(key, '1');
      var el = document.getElementById('upgrade-banner');
      if (el) el.innerHTML = '';
    }

    // ── Upgrade Plan ─────────────────────────────────────────────────────────
    async function upgradePlan(tier) {
      var tierNames = { plus: 'Plus', pro: 'Pro', managed: 'Enterprise' };
      var label = tierNames[tier] || tier;

      if (!await modalConfirm('Upgrade to ' + label + '? Your subscription will be updated immediately with prorated billing.', { title: 'Upgrade Plan', okLabel: 'Upgrade' })) return;

      // Disable all upgrade buttons and show loading
      var btns = document.querySelectorAll('[id^="btn-upgrade-"]');
      btns.forEach(function(b) { b.disabled = true; b.style.opacity = '0.5'; });
      var clickedBtn = document.getElementById('btn-upgrade-' + tier);
      var origText = clickedBtn ? clickedBtn.textContent : '';
      if (clickedBtn) clickedBtn.textContent = 'Upgrading…';

      try {
        var data = await api('POST', '/api/church/billing/upgrade', { tier: tier });

        if (data.redirect) {
          // No Stripe subscription yet — redirect to signup
          window.location.href = data.redirect;
          return;
        }

        if (data.success) {
          toast('Plan upgraded to ' + label + '!');
          // Reload billing data to reflect new plan
          await loadBilling();
          // Also update the overview plan badge
          var planEl = document.getElementById('plan-name');
          if (planEl) planEl.textContent = label;
        }
      } catch(e) {
        toast(e.message || 'Upgrade failed', true);
        // Restore buttons
        btns.forEach(function(b) { b.disabled = false; b.style.opacity = '1'; });
        if (clickedBtn) clickedBtn.textContent = origText;
      }
    }

    // ── Reactivate subscription ───────────────────────────────────────────────
    async function reactivateSubscription() {
      if (!await modalConfirm('Reactivate your subscription? You will be redirected to Stripe to complete payment.', { title: 'Reactivate Subscription', okLabel: 'Reactivate' })) return;
      var btn = document.getElementById('btn-reactivate');
      if (btn) { btn.disabled = true; btn.textContent = 'Redirecting…'; }
      try {
        var data = await api('POST', '/api/church/billing/reactivate', {});
        if (data.url) {
          window.location.href = data.url;
        } else {
          toast('Reactivation started. Check your email for next steps.');
        }
      } catch(e) {
        toast(e.message || 'Reactivation failed', true);
        if (btn) { btn.disabled = false; btn.textContent = 'Reactivate Now →'; }
      }
    }

    // ── Cancel subscription (opens retention modal) ─────────────────────────
    function cancelSubscription() {
      document.getElementById('modal-cancel-retention').classList.add('open');
    }

    // ── Accept retention offer (50% off 3 months) ───────────────────────────
    async function acceptRetentionOffer() {
      var btn = document.getElementById('btn-accept-retention');
      if (btn) { btn.disabled = true; btn.textContent = 'Applying…'; }
      try {
        await api('POST', '/api/church/billing/retention', {});
        document.getElementById('modal-cancel-retention').classList.remove('open');
        toast('Discount applied! 50% off for the next 3 months. Thank you for staying.');
        await loadBilling();
      } catch(e) {
        toast('Could not apply discount: ' + (e.message || 'Please try again.'));
        if (btn) { btn.disabled = false; btn.textContent = pt('billing.cancel.accept') || 'Accept 50% Off'; }
      }
    }

    // ── Confirm cancellation (no thanks branch) ─────────────────────────────
    async function confirmCancellation() {
      var btn = document.getElementById('btn-confirm-cancel');
      if (btn) { btn.disabled = true; btn.textContent = 'Cancelling…'; }
      try {
        var data = await api('POST', '/api/church/billing/cancel', {});
        document.getElementById('modal-cancel-retention').classList.remove('open');
        if (data.endDate) {
          toast('Subscription cancelled. Your access continues until ' + data.endDate + '.');
        } else {
          toast('Subscription cancelled. Your access continues through the end of your billing period.');
        }
        await loadBilling();
      } catch(e) {
        toast('Cancellation failed: ' + (e.message || 'Please contact support.'));
        if (btn) { btn.disabled = false; btn.textContent = pt('billing.cancel.decline') || 'No thanks, cancel my account'; }
      }
    }

    // ── Downgrade plan ──────────────────────────────────────────────────────
    async function downgradePlan(tier) {
      var tierNames = { connect: 'Connect', plus: 'Plus' };
      var label = tierNames[tier] || tier;
      if (!await modalConfirm('Downgrade to ' + label + '? The change takes effect at the end of your current billing period.', { title: 'Downgrade Plan', okLabel: 'Downgrade', dangerOk: true })) return;
      try {
        var data = await api('POST', '/api/church/billing/downgrade', { tier: tier });
        if (data.success) {
          toast(data.message || 'Plan downgraded to ' + label);
          await loadBilling();
        }
      } catch(e) {
        toast(e.message || 'Downgrade failed', true);
      }
    }

    // ── Export data ─────────────────────────────────────────────────────────
    async function exportData() {
      try {
        var resp = await fetch('/api/church/data-export', { credentials: 'include', signal: AbortSignal.timeout(30000) });
        if (!resp.ok) throw new Error('Export failed');
        var blob = await resp.blob();
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'tally-data-export.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        toast('Data exported successfully');
      } catch(e) {
        toast(e.message || 'Export failed', true);
      }
    }

    // ── Delete account ──────────────────────────────────────────────────────
    async function deleteAccount() {
      var churchName = await modalPrompt('This will permanently delete your account and all data. To confirm, type your church name:', '', { title: 'Delete Account' });
      if (!churchName) return;
      try {
        var data = await api('DELETE', '/api/church/account', { confirmName: churchName });
        if (data.deleted) {
          await modalAlert('Your account has been deleted. You will be redirected to the homepage.', { title: 'Account Deleted' });
          window.location.href = 'https://tallyconnect.app';
        }
      } catch(e) {
        toast(e.message || 'Deletion failed', true);
      }
    }

    // ── Review system ─────────────────────────────────────────────────────────
    var reviewRating = 0;

    async function checkReviewEligibility() {
      try {
        var data = await api('GET', '/api/church/review');
        var banner = document.getElementById('review-prompt-banner');
        if (!banner) return;

        if (!data.hasReview && data.eligible && localStorage.getItem('tally_review_dismissed') !== '1') {
          banner.style.display = 'block';
          banner.innerHTML = '<div style="margin-bottom:20px;background:#0F1613;border:1px solid #1a3a24;border-radius:12px;padding:20px 24px">' +
            '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap">' +
            '<div style="flex:1;min-width:200px">' +
            '<div style="font-size:15px;font-weight:700;color:#F8FAFC">\\u2B50 Loving Tally? Share your experience</div>' +
            '<div style="font-size:13px;color:#94A3B8;margin-top:4px;line-height:1.5">Your review helps other church production teams discover Tally. Takes 60 seconds.</div>' +
            '</div>' +
            '<div style="display:flex;gap:8px;flex-shrink:0;align-items:center">' +
            '<button class="btn-primary" onclick="openReviewModal()" style="padding:8px 16px;font-size:13px">Leave a Review</button>' +
            '<button onclick="dismissReviewBanner()" style="background:none;border:1px solid #1a2e1f;color:#64748B;font-size:11px;padding:6px 12px;border-radius:6px;cursor:pointer">Later</button>' +
            '</div></div></div>';
        } else {
          banner.style.display = 'none';
        }

        // Auto-open from email link
        var params = new URLSearchParams(window.location.search);
        if (params.get('action') === 'review' && !data.hasReview) {
          openReviewModal();
          window.history.replaceState({}, '', window.location.pathname);
        }
      } catch(e) { /* not critical */ }
    }

    function openReviewModal() {
      document.getElementById('review-form-content').style.display = 'block';
      document.getElementById('review-thanks-content').style.display = 'none';
      document.getElementById('modal-review').classList.add('open');
      renderStars();
    }

    function closeReviewModal() {
      document.getElementById('modal-review').classList.remove('open');
    }

    function renderStars() {
      var container = document.getElementById('star-rating');
      if (!container) return;
      container.innerHTML = [1,2,3,4,5].map(function(n) {
        return '<button onclick="setRating(' + n + ')" style="background:none;border:none;font-size:28px;cursor:pointer;color:' + (n <= reviewRating ? '#22c55e' : '#334155') + ';transition:color 0.15s">\\u2605</button>';
      }).join('');
    }

    function setRating(n) {
      reviewRating = n;
      renderStars();
    }

    async function submitReview() {
      var body = (document.getElementById('review-body').value || '').trim();
      var name = (document.getElementById('review-name').value || '').trim();
      var role = (document.getElementById('review-role').value || '').trim();

      if (!reviewRating) return toast('Please select a star rating', true);
      if (!name) return toast('Please enter your name', true);
      if (body.length < 10) return toast('Please write at least a short review (10+ characters)', true);

      var btn = document.getElementById('btn-submit-review');
      var origText = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Submitting…';

      try {
        await api('POST', '/api/church/review', {
          rating: reviewRating,
          body: body,
          reviewerName: name,
          reviewerRole: role,
        });
        // Show thank-you with external links
        document.getElementById('review-form-content').style.display = 'none';
        document.getElementById('review-thanks-content').style.display = 'block';
        // Hide the banner
        var banner = document.getElementById('review-prompt-banner');
        if (banner) banner.style.display = 'none';
        toast('Review submitted! Thank you');
      } catch(e) {
        toast(e.message || 'Failed to submit review', true);
        btn.disabled = false;
        btn.textContent = origText;
      }
    }

    function dismissReviewBanner() {
      localStorage.setItem('tally_review_dismissed', '1');
      var banner = document.getElementById('review-prompt-banner');
      if (banner) banner.style.display = 'none';
    }

    // Character counter for review textarea
    (function() {
      var ta = document.getElementById('review-body');
      var counter = document.getElementById('review-char-count');
      if (ta && counter) {
        ta.addEventListener('input', function() {
          counter.textContent = ta.value.length;
        });
      }
    })();

    // ── Referral system ──────────────────────────────────────────────────────
    async function loadReferralCard() {
      var card = document.getElementById('referral-card');
      if (!card) return;
      try {
        var data = await api('GET', '/api/church/referrals');
        if (!data.referralCode) { card.style.display = 'none'; return; }

        var statsHtml = '';
        if (data.totalReferred > 0) {
          var creditDollars = data.totalCredits ? '$' + (data.totalCredits / 100).toFixed(0) : '$0';
          statsHtml = '<div style="display:flex;gap:24px;margin-bottom:14px">' +
            '<div><div style="font-size:20px;font-weight:800;color:#F8FAFC">' + data.totalReferred + '</div><div style="font-size:11px;color:#475569">' + pt('referral.stat.referred') + '</div></div>' +
            '<div><div style="font-size:20px;font-weight:800;color:#22c55e">' + data.totalConverted + '</div><div style="font-size:11px;color:#475569">' + pt('referral.stat.signed_up') + '</div></div>' +
            '<div><div style="font-size:20px;font-weight:800;color:#22c55e">' + creditDollars + '</div><div style="font-size:11px;color:#475569">' + pt('referral.stat.credits') + '</div></div>' +
            '</div>';
        }

        card.style.display = 'block';
        card.innerHTML = '<div style="margin-bottom:20px;background:#0F1613;border:1px solid #1a2e1f;border-radius:12px;padding:20px 24px">' +
          '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">' +
          '<span style="font-size:18px">&#127873;</span>' +
          '<span style="font-size:15px;font-weight:700;color:#F8FAFC">' + pt('referral.title') + '</span>' +
          '</div>' +
          '<div style="font-size:13px;color:#94A3B8;line-height:1.5;margin-bottom:14px">' +
          pt('referral.body') + ' ' +
          '<span style="color:#475569">' + pt('referral.fine_print') + '</span>' +
          '</div>' +
          statsHtml +
          '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
          '<div style="flex:1;min-width:200px;background:#09090B;border:1px solid #1a2e1f;border-radius:8px;padding:8px 12px;font-family:ui-monospace,monospace;font-size:13px;color:#F8FAFC;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" id="referral-link">' + escapeHtml(data.shareUrl || '') + '</div>' +
          '<button onclick="copyReferralLink()" class="btn-primary" style="padding:8px 16px;font-size:13px;flex-shrink:0">' + pt('referral.copy_btn') + '</button>' +
          '</div>' +
          '</div>';
      } catch(e) { card.style.display = 'none'; }
    }

    function copyReferralLink() {
      var link = document.getElementById('referral-link');
      if (!link) return;
      navigator.clipboard.writeText(link.textContent).then(function() {
        toast(pt('referral.copied'));
      }).catch(function() {
        // Fallback
        var range = document.createRange();
        range.selectNodeContents(link);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
        document.execCommand('copy');
        toast(pt('referral.copied'));
      });
    }

    // ── Referral Marketing Page ──────────────────────────────────────────────
    var _refData = null;

    async function loadReferralsPage() {
      try {
        _refData = await api('GET', '/api/church/referrals');
        var linkEl = document.getElementById('ref-page-link');
        if (linkEl) linkEl.textContent = _refData.shareUrl || '';

        // Progress section
        var progressEl = document.getElementById('ref-progress-content');
        if (progressEl) {
          var total = _refData.totalReferred || 0;
          var converted = _refData.totalConverted || 0;
          var credited = _refData.totalCredited || 0;
          var max = _refData.maxCredits || 5;
          var remaining = _refData.creditsRemaining || 0;
          var creditDollars = _refData.totalCredits ? '$' + (_refData.totalCredits / 100).toFixed(0) : '$0';
          var pct = Math.min(100, Math.round((credited / max) * 100));

          progressEl.innerHTML =
            '<div style="display:flex;gap:24px;margin-bottom:20px;flex-wrap:wrap">' +
              '<div style="text-align:center;flex:1;min-width:80px"><div style="font-size:24px;font-weight:800;color:#F8FAFC">' + total + '</div><div style="font-size:11px;color:#475569">Referred</div></div>' +
              '<div style="text-align:center;flex:1;min-width:80px"><div style="font-size:24px;font-weight:800;color:#eab308">' + (total - converted) + '</div><div style="font-size:11px;color:#475569">Pending</div></div>' +
              '<div style="text-align:center;flex:1;min-width:80px"><div style="font-size:24px;font-weight:800;color:#22c55e">' + converted + '</div><div style="font-size:11px;color:#475569">Signed Up</div></div>' +
              '<div style="text-align:center;flex:1;min-width:80px"><div style="font-size:24px;font-weight:800;color:#22c55e">' + creditDollars + '</div><div style="font-size:11px;color:#475569">Earned</div></div>' +
            '</div>' +
            '<div style="margin-bottom:6px;display:flex;justify-content:space-between;font-size:12px;color:#94A3B8">' +
              '<span>' + credited + ' of ' + max + ' free months earned</span>' +
              '<span>' + remaining + ' remaining</span>' +
            '</div>' +
            '<div style="background:#1E293B;border-radius:6px;height:10px;overflow:hidden">' +
              '<div style="background:#22c55e;height:100%;width:' + pct + '%;border-radius:6px;transition:width 0.5s"></div>' +
            '</div>';
          progressEl.style.opacity = '1';
        }

        // History table
        var histEl = document.getElementById('ref-history-content');
        if (histEl) {
          var referrals = _refData.referrals || [];
          if (referrals.length === 0) {
            histEl.innerHTML = '<p style="color:#475569;text-align:center;padding:16px;font-size:13px">No referrals yet. Share your link to get started!</p>';
          } else {
            var tbl = '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:13px">' +
              '<thead><tr style="border-bottom:1px solid #1a2e1f">' +
                '<th style="text-align:left;padding:8px 10px;color:#64748B;font-weight:600;font-size:11px">Church</th>' +
                '<th style="text-align:left;padding:8px 10px;color:#64748B;font-weight:600;font-size:11px">Date</th>' +
                '<th style="text-align:left;padding:8px 10px;color:#64748B;font-weight:600;font-size:11px">Status</th>' +
                '<th style="text-align:right;padding:8px 10px;color:#64748B;font-weight:600;font-size:11px">Credit</th>' +
              '</tr></thead><tbody>';
            for (var i = 0; i < referrals.length; i++) {
              var r = referrals[i];
              var statusColor = r.status === 'credited' ? '#22c55e' : r.status === 'converted' ? '#3b82f6' : r.status === 'expired' ? '#ef4444' : '#eab308';
              var statusLabel = r.status === 'credited' ? 'Credited' : r.status === 'converted' ? 'Subscribed' : r.status === 'expired' ? 'Expired' : 'Pending';
              var credit = r.credit_amount ? '$' + (r.credit_amount / 100).toFixed(0) : '—';
              var date = r.created_at ? new Date(r.created_at).toLocaleDateString() : '—';
              tbl += '<tr style="border-bottom:1px solid #0F1613">' +
                '<td style="padding:10px;color:#F8FAFC">' + escapeHtml(r.referred_name || 'Unknown') + '</td>' +
                '<td style="padding:10px;color:#94A3B8">' + date + '</td>' +
                '<td style="padding:10px"><span style="background:' + statusColor + '22;color:' + statusColor + ';padding:2px 10px;border-radius:10px;font-size:11px;font-weight:600">' + statusLabel + '</span></td>' +
                '<td style="padding:10px;text-align:right;color:#F8FAFC;font-weight:600">' + credit + '</td>' +
              '</tr>';
            }
            tbl += '</tbody></table></div>';
            histEl.innerHTML = tbl;
          }
          histEl.style.opacity = '1';
        }
      } catch(e) {
        var pc = document.getElementById('ref-progress-content');
        if (pc) { pc.innerHTML = '<p style="color:#ef4444;font-size:12px">Failed to load referral data.</p>'; pc.style.opacity = '1'; }
      }
    }

    function copyRefPageLink() {
      var link = document.getElementById('ref-page-link');
      if (!link) return;
      navigator.clipboard.writeText(link.textContent).then(function() {
        toast('Referral link copied!');
      }).catch(function() {
        var range = document.createRange();
        range.selectNodeContents(link);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
        document.execCommand('copy');
        toast('Referral link copied!');
      });
    }

    function shareRefEmail() {
      if (!_refData) return;
      var subject = encodeURIComponent('Check out Tally for your church production team');
      var body = encodeURIComponent(
        'Hey!\\n\\nI wanted to share Tally with you — it monitors our church production gear and auto-recovers issues during services. ' +
        'It\\x27s been a game changer for our team.\\n\\n' +
        'If you sign up with my link, we both get a free month:\\n' +
        (_refData.shareUrl || '') + '\\n\\n' +
        'Worth checking out if your team deals with stream drops or Sunday morning scrambles.'
      );
      window.open('mailto:?subject=' + subject + '&body=' + body, '_blank');
    }

    function shareRefSMS() {
      if (!_refData) return;
      var text = encodeURIComponent(
        'Hey! Check out Tally for your church production team — it auto-monitors and fixes stream issues. ' +
        'Sign up with my link and we both get a free month: ' + (_refData.shareUrl || '')
      );
      window.open('sms:?body=' + text, '_blank');
    }

    // ── Alerts ────────────────────────────────────────────────────────────────
    async function loadAlerts() {
      try {
        const alerts = await api('GET', '/api/church/alerts');
        var container = document.getElementById('alerts-content');
        if (!alerts.length) {
          container.innerHTML = '<p style="color:#475569;text-align:center;padding:20px">No alerts yet. Alerts will appear here during and after your services.</p>';
          return;
        }
        var sevColors = { INFO: '#22c55e', WARNING: '#eab308', CRITICAL: '#ef4444', EMERGENCY: '#ef4444' };
        var html = '<div style="display:flex;flex-direction:column;gap:8px">';
        alerts.forEach(function(a) {
          var color = sevColors[a.severity] || '#94A3B8';
          var time = new Date(a.created_at).toLocaleString();
          var type = (a.alert_type || '').replace(/_/g, ' ');
          var acked = a.acknowledged_at ? '<span style="color:#22c55e;font-size:11px">\\u2713 Acknowledged' + (a.acknowledged_by ? ' by ' + escapeHtml(a.acknowledged_by) : '') + '</span>' : '<span style="color:#475569;font-size:11px">Not acknowledged</span>';
          var ctx = a.context || {};
          var diag = ctx.diagnosis || ctx;

          html += '<div class="card" style="padding:12px">';
          html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">';
          html += '<span style="background:' + color + ';color:#000;padding:1px 8px;border-radius:10px;font-size:10px;font-weight:700">' + (a.severity || 'INFO') + '</span>';
          html += '<span style="color:#F8FAFC;font-size:13px;font-weight:600">' + type + '</span>';
          html += '<span style="color:#475569;font-size:11px;margin-left:auto">' + time + '</span>';
          html += '</div>';
          html += '<div style="margin-top:4px">' + acked;
          if (a.resolved) html += ' <span style="color:#22c55e;font-size:11px;margin-left:8px">\\u2713 Resolved</span>';
          html += '</div>';

          if (diag.likely_cause || (diag.steps && diag.steps.length)) {
            html += '<div style="margin-top:8px;background:#09090B;border-radius:6px;padding:8px 12px;font-size:12px">';
            if (diag.likely_cause) html += '<div style="color:#94A3B8;margin-bottom:4px"><strong style="color:#F8FAFC">Likely cause:</strong> ' + escapeHtml(diag.likely_cause) + '</div>';
            if (diag.steps && diag.steps.length) {
              html += '<div style="color:#94A3B8"><strong style="color:#F8FAFC">Steps:</strong></div><ol style="margin:4px 0 0;padding-left:20px;color:#94A3B8">';
              diag.steps.forEach(function(s) { html += '<li>' + escapeHtml(s) + '</li>'; });
              html += '</ol>';
            }
            if (diag.canAutoFix) html += '<div style="color:#22c55e;font-size:11px;margin-top:4px">Tally can attempt auto-recovery for this issue.</div>';
            html += '</div>';
          }
          html += '</div>';
        });
        html += '</div>';
        container.innerHTML = html;
      } catch(e) {
        document.getElementById('alerts-content').innerHTML = '<p style="color:#ef4444">' + escapeHtml(e.message) + '</p>';
      }
    }

    // ── Support info ──────────────────────────────────────────────────────────
    function loadSupportInfo() {
      var tier = billingData ? billingData.tier : (profileData.billing_tier || 'connect');
      var times = { connect: '48 hours', plus: '24 hours', pro: '12 hours', managed: '15 minutes (Mon\\u2013Fri 9\\u20135 ET + service windows)' };
      var el = document.getElementById('support-response-time');
      if (el) el.textContent = 'Response time for your plan: ' + (times[tier] || '48 hours');
      loadSupportStatus();
      loadSupportTickets();
      loadCompanionGuide();
    }

    function loadCompanionGuide() {
      var guide = document.getElementById('companion-setup-guide');
      if (!guide) return;
      var status = profileData && profileData.status || {};
      var comp = status.companion || {};

      // Always show the guide — useful even if Companion isn't connected yet
      guide.style.display = '';

      // Status section
      var statusEl = document.getElementById('companion-guide-status');
      if (statusEl) {
        if (comp.connected) {
          var cc = comp.connectionCount || 0;
          var labels = (comp.connections || []).map(function(c) { return c.label; }).filter(Boolean);
          statusEl.innerHTML = '<div style="padding:10px 14px;background:#0c2818;border:1px solid #16532e;border-radius:8px;font-size:13px">' +
            '<span style="color:#22c55e;font-weight:700">✓ Companion Connected</span>' +
            (cc > 0 ? ' — ' + cc + ' module' + (cc !== 1 ? 's' : '') + (labels.length ? ': ' + labels.join(', ') : '') : '') +
            '</div>';
        } else {
          statusEl.innerHTML = '<div style="padding:10px 14px;background:#1e1e1e;border:1px solid #333;border-radius:8px;font-size:13px;color:#94A3B8">' +
            '⚠ Companion not detected. Make sure it\'s running on the same machine as Tally (port 8888).' +
            '</div>';
        }
      }

      // Suggested buttons based on detected gear
      var btnEl = document.getElementById('companion-suggested-buttons');
      if (btnEl) {
        var suggestions = [];
        // Core buttons every church needs
        suggestions.push({ name: 'Start Stream', module: 'OBS / vMix / Encoder', icon: '🔴' });
        suggestions.push({ name: 'Stop Stream', module: 'OBS / vMix / Encoder', icon: '⏹' });
        suggestions.push({ name: 'Start Recording', module: 'OBS / HyperDeck', icon: '⏺' });
        suggestions.push({ name: 'Stop Recording', module: 'OBS / HyperDeck', icon: '⏹' });

        // ATEM-specific
        if (status.atem) {
          suggestions.push({ name: 'Camera 1', module: 'ATEM', icon: '📷' });
          suggestions.push({ name: 'Camera 2', module: 'ATEM', icon: '📷' });
          suggestions.push({ name: 'Camera 3', module: 'ATEM', icon: '📷' });
          suggestions.push({ name: 'Media Player 1', module: 'ATEM', icon: '🖼' });
          suggestions.push({ name: 'Fade to Black', module: 'ATEM', icon: '⬛' });
        }

        // ProPresenter
        if (status.proPresenter || status.propresenter) {
          suggestions.push({ name: 'Next Slide', module: 'ProPresenter', icon: '▶' });
          suggestions.push({ name: 'Previous Slide', module: 'ProPresenter', icon: '◀' });
          suggestions.push({ name: 'Clear All', module: 'ProPresenter', icon: '🗑' });
        }

        // Audio
        if (status.mixer) {
          suggestions.push({ name: 'Mute Audience Mics', module: 'Audio Mixer', icon: '🔇' });
          suggestions.push({ name: 'Worship Preset', module: 'Audio Mixer', icon: '🎵' });
          suggestions.push({ name: 'Speaking Preset', module: 'Audio Mixer', icon: '🎤' });
        }

        // Lighting
        suggestions.push({ name: 'House Lights Up', module: 'Lighting / ArtNet', icon: '💡' });
        suggestions.push({ name: 'House Lights Down', module: 'Lighting / ArtNet', icon: '🌑' });
        suggestions.push({ name: 'Stage Look: Worship', module: 'Lighting / ArtNet', icon: '✨' });

        btnEl.innerHTML = suggestions.map(function(s) {
          return '<div style="background:#0F1613;border:1px solid #1a2e1f;border-radius:8px;padding:10px 12px;font-size:12px">' +
            '<div style="font-size:16px;margin-bottom:4px">' + s.icon + '</div>' +
            '<div style="color:#F8FAFC;font-weight:600">' + s.name + '</div>' +
            '<div style="color:#475569;font-size:11px;margin-top:2px">' + s.module + '</div>' +
            '</div>';
        }).join('');
      }
    }

    function supportStateChip(state) {
      if (state === 'operational') return '<span style="color:#22c55e;font-weight:700">Operational</span>';
      if (state === 'degraded') return '<span style="color:#eab308;font-weight:700">Degraded</span>';
      return '<span style="color:#ef4444;font-weight:700">Outage</span>';
    }

    // ── Analytics ───────────────────────────────────────────────────────────
    var analyticsRange = 30;

    async function exportAnalyticsCSV() {
      try {
        var blob = await fetch('/api/church/analytics/export?days=' + analyticsRange, {
          headers: { 'Authorization': 'Bearer ' + token }
        }).then(function(r) {
          if (!r.ok) throw new Error('Export failed');
          return r.blob();
        });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'tally-sessions-' + analyticsRange + 'd.csv';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        toast('CSV exported');
      } catch (e) {
        toast(e.message || 'Export failed', true);
      }
    }

    function setAnalyticsRange(days, el) {
      analyticsRange = days;
      document.querySelectorAll('.analytics-range').forEach(function(b) { b.classList.remove('active'); });
      el.classList.add('active');
      loadAnalytics();
    }

    async function loadAnalytics() {
      try {
        var data = await api('GET', '/api/church/analytics?days=' + analyticsRange);
        renderAnalyticsKPI(data);
        renderStreamHealth(data);
        renderViewerChart(data);
        renderSessionStats(data);
        renderEquipmentPerf(data);
      } catch (e) {
        document.getElementById('a-health-content').innerHTML =
          '<p style="color:#ef4444">' + escapeHtml(e.message) + '</p>';
      }
      // Load platform-specific audience data in parallel
      loadAudienceAnalytics();
    }

    function renderAnalyticsKPI(d) {
      var upEl = document.getElementById('a-uptime');
      upEl.textContent = d.uptime_pct.toFixed(1) + '%';
      upEl.style.color = d.uptime_pct >= 99 ? '#22c55e' : d.uptime_pct >= 95 ? '#eab308' : '#ef4444';
      document.getElementById('a-sessions-count').textContent = d.total_sessions;
      document.getElementById('a-avg-viewers').textContent =
        d.avg_peak_viewers !== null ? Math.round(d.avg_peak_viewers) : '—';
      document.getElementById('a-recovery-rate').textContent =
        d.auto_recovery_rate !== null ? d.auto_recovery_rate.toFixed(0) + '%' : '—';
      document.getElementById('a-recovery-rate').style.color =
        d.auto_recovery_rate === null ? '#94A3B8' : d.auto_recovery_rate >= 80 ? '#22c55e' : d.auto_recovery_rate >= 50 ? '#eab308' : '#ef4444';
    }

    function renderStreamHealth(d) {
      var el = document.getElementById('a-health-content');
      if (!d.total_sessions) {
        el.innerHTML = '<p style="color:#475569">No sessions in this period.</p>';
        return;
      }
      var html = '<div class="a-metric-grid">';
      html += aMetricBox(d.total_alerts, 'Total Alerts');
      html += aMetricBox(d.auto_recovered_count, 'Auto-Recovered');
      html += aMetricBox(d.escalated_count, 'Escalated');
      html += aMetricBox(d.audio_silence_total, 'Audio Silence Events');
      html += '</div>';

      if (d.top_event_types && d.top_event_types.length) {
        html += '<div style="margin-top:16px">';
        html += '<div style="font-size:12px;color:#94A3B8;margin-bottom:8px;font-weight:600">Most Common Issues</div>';
        var maxCount = d.top_event_types[0].count;
        d.top_event_types.forEach(function(t) {
          var pct = Math.round((t.count / maxCount) * 100);
          var label = t.type.replace(/_/g, ' ');
          html += '<div class="a-bar-row">';
          html += '<div class="a-bar-label" title="' + escapeHtml(t.type) + '">' + escapeHtml(label) + '</div>';
          html += '<div class="a-bar-track"><div class="a-bar-fill" style="width:' + pct + '%"></div></div>';
          html += '<div class="a-bar-value">' + t.count + '</div>';
          html += '</div>';
        });
        html += '</div>';
      }
      el.innerHTML = html;
    }

    function renderViewerChart(d) {
      var el = document.getElementById('a-viewer-chart');
      if (!d.viewer_trend || !d.viewer_trend.length) {
        el.innerHTML = '<p style="color:#475569">No viewer data available.</p>';
        return;
      }
      var maxV = Math.max.apply(null, d.viewer_trend.map(function(v) { return v.peak; }));
      if (maxV === 0) maxV = 1;
      var html = '';
      d.viewer_trend.forEach(function(v) {
        var pct = Math.round((v.peak / maxV) * 100);
        html += '<div class="a-bar-row">';
        html += '<div class="a-bar-label">' + escapeHtml(v.label) + '</div>';
        html += '<div class="a-bar-track"><div class="a-bar-fill" style="width:' + pct + '%"></div></div>';
        html += '<div class="a-bar-value">' + v.peak + '</div>';
        html += '</div>';
      });
      el.innerHTML = html;
    }

    // ── Audience (platform) analytics ────────────────────────────────
    async function loadAudienceAnalytics() {
      try {
        var d = await api('GET', '/api/church/analytics/audience?days=' + analyticsRange);
        renderAudienceKPI(d);
        renderPlatformChart(d);
        renderLiveChart(d);
      } catch (e) {
        document.getElementById('aud-platform-chart').innerHTML =
          '<p style="color:#ef4444">' + escapeHtml(e.message) + '</p>';
      }
    }

    function renderAudienceKPI(d) {
      var s = d.platform_summary || {};
      document.getElementById('aud-yt-peak').textContent = s.peak_youtube != null ? s.peak_youtube : '—';
      document.getElementById('aud-fb-peak').textContent = s.peak_facebook != null ? s.peak_facebook : '—';
      document.getElementById('aud-vim-peak').textContent = s.peak_vimeo != null ? s.peak_vimeo : '—';
      document.getElementById('aud-total-avg').textContent = s.avg_total != null ? Math.round(s.avg_total) : '—';
    }

    function renderPlatformChart(d) {
      var el = document.getElementById('aud-platform-chart');
      var trend = d.weekly_trend || [];
      if (!trend.length) {
        el.innerHTML = '<p style="color:#475569">No platform viewer data yet. Viewer counts are collected during live streams when YouTube, Facebook, or Vimeo API keys are configured.</p>';
        return;
      }
      var maxV = Math.max.apply(null, trend.map(function(w) { return w.peak_total || 0; }));
      if (maxV === 0) maxV = 1;

      var html = '<div style="font-size:12px;color:#94A3B8;margin-bottom:8px;font-weight:600">Weekly Viewers by Platform</div>';
      trend.forEach(function(w) {
        var yt = w.peak_youtube || 0;
        var fb = w.peak_facebook || 0;
        var vim = w.peak_vimeo || 0;
        var total = w.peak_total || 0;
        var pct = Math.round((total / maxV) * 100);

        html += '<div class="a-bar-row">';
        html += '<div class="a-bar-label">' + escapeHtml(w.week_key) + '</div>';
        html += '<div class="a-bar-track" style="position:relative">';
        // Stacked bar: YouTube (red) + Facebook (blue) + Vimeo (teal)
        var ytPct = total > 0 ? Math.round((yt / total) * pct) : 0;
        var fbPct = total > 0 ? Math.round((fb / total) * pct) : 0;
        var vimPct = total > 0 ? Math.round((vim / total) * pct) : 0;
        // Ensure at least the total is shown if there's no breakdown
        if (ytPct + fbPct + vimPct === 0 && total > 0) ytPct = pct;
        html += '<div style="position:absolute;left:0;top:0;bottom:0;width:' + (ytPct + fbPct + vimPct) + '%;display:flex">';
        if (ytPct > 0) html += '<div style="width:' + Math.round(ytPct * 100 / (ytPct + fbPct + vimPct || 1)) + '%;background:#ff0000;border-radius:3px 0 0 3px;height:100%"></div>';
        if (fbPct > 0) html += '<div style="width:' + Math.round(fbPct * 100 / (ytPct + fbPct + vimPct || 1)) + '%;background:#1877f2;height:100%"></div>';
        if (vimPct > 0) html += '<div style="width:' + Math.round(vimPct * 100 / (ytPct + fbPct + vimPct || 1)) + '%;background:#1ab7ea;border-radius:0 3px 3px 0;height:100%"></div>';
        html += '</div>';
        html += '</div>';
        html += '<div class="a-bar-value">' + total + '</div>';
        html += '</div>';
      });

      // Legend
      html += '<div style="display:flex;gap:16px;margin-top:10px;font-size:11px;color:#94A3B8">';
      html += '<span>\\u25cf <span style="color:#ff0000">YouTube</span></span>';
      html += '<span>\\u25cf <span style="color:#1877f2">Facebook</span></span>';
      html += '<span>\\u25cf <span style="color:#1ab7ea">Vimeo</span></span>';
      html += '</div>';
      el.innerHTML = html;
    }

    function renderLiveChart(d) {
      var snaps = d.recent_snapshots || [];
      var container = document.getElementById('aud-live-chart');
      var el = document.getElementById('aud-live-bars');
      if (!snaps.length) {
        container.style.display = 'none';
        return;
      }
      container.style.display = 'block';
      var maxV = Math.max.apply(null, snaps.map(function(s) { return s.total || 0; }));
      if (maxV === 0) maxV = 1;

      var html = '';
      snaps.forEach(function(s) {
        var pct = Math.round(((s.total || 0) / maxV) * 100);
        var time = s.captured_at ? new Date(s.captured_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : '';
        html += '<div style="display:flex;align-items:center;gap:6px;margin-bottom:2px">';
        html += '<div style="width:50px;text-align:right;font-size:10px;color:#94A3B8">' + time + '</div>';
        html += '<div style="flex:1;height:6px;background:var(--border,#1e293b);border-radius:3px;overflow:hidden">';
        html += '<div style="height:100%;width:' + pct + '%;background:linear-gradient(90deg,#22c55e,#3b82f6);border-radius:3px"></div>';
        html += '</div>';
        html += '<div style="width:35px;font-size:10px;color:#cbd5e1;text-align:right">' + (s.total || 0) + '</div>';
        html += '</div>';
      });
      el.innerHTML = html;
    }

    function renderSessionStats(d) {
      var el = document.getElementById('a-session-stats');
      if (!d.total_sessions) {
        el.innerHTML = '<p style="color:#475569">No sessions in this period.</p>';
        return;
      }
      var html = '<div class="a-metric-grid">';
      html += aMetricBox(aFmtHours(d.total_stream_hours), 'Total Stream Hours');
      html += aMetricBox(d.avg_session_minutes !== null ? d.avg_session_minutes + 'm' : '—', 'Avg Session Length');
      html += aMetricBox(d.sessions_per_week !== null ? d.sessions_per_week.toFixed(1) : '—', 'Sessions / Week');
      html += aMetricBox(d.stream_ran_pct !== null ? d.stream_ran_pct.toFixed(0) + '%' : '—', 'Sessions With Stream');
      html += '</div>';

      if (d.weekly_sessions && d.weekly_sessions.length) {
        html += '<div style="margin-top:16px">';
        html += '<div style="font-size:12px;color:#94A3B8;margin-bottom:8px;font-weight:600">Sessions Per Week</div>';
        var maxW = Math.max.apply(null, d.weekly_sessions.map(function(w) { return w.count; }));
        if (maxW === 0) maxW = 1;
        d.weekly_sessions.forEach(function(w) {
          var pct = Math.round((w.count / maxW) * 100);
          html += '<div class="a-bar-row">';
          html += '<div class="a-bar-label">' + escapeHtml(w.label) + '</div>';
          html += '<div class="a-bar-track"><div class="a-bar-fill" style="width:' + pct + '%"></div></div>';
          html += '<div class="a-bar-value">' + w.count + '</div>';
          html += '</div>';
        });
        html += '</div>';
      }
      el.innerHTML = html;
    }

    function renderEquipmentPerf(d) {
      var el = document.getElementById('a-equipment-content');
      if (!d.equipment_disconnects || !d.equipment_disconnects.length) {
        el.innerHTML = '<p style="color:#475569">No equipment disconnect data available.</p>';
        return;
      }
      var maxC = d.equipment_disconnects[0].count;
      if (maxC === 0) maxC = 1;
      var html = '<div style="font-size:12px;color:#94A3B8;margin-bottom:8px;font-weight:600">Disconnects by Device</div>';
      d.equipment_disconnects.forEach(function(eq) {
        var pct = Math.round((eq.count / maxC) * 100);
        var colorClass = eq.count >= 10 ? 'red' : eq.count >= 5 ? 'yellow' : '';
        html += '<div class="a-bar-row">';
        html += '<div class="a-bar-label" title="' + escapeHtml(eq.device) + '">' + escapeHtml(eq.device) + '</div>';
        html += '<div class="a-bar-track"><div class="a-bar-fill ' + colorClass + '" style="width:' + pct + '%"></div></div>';
        html += '<div class="a-bar-value">' + eq.count + '</div>';
        html += '</div>';
      });

      if (d.equipment_auto_resolve_rates && d.equipment_auto_resolve_rates.length) {
        html += '<div style="margin-top:16px;font-size:12px;color:#94A3B8;margin-bottom:8px;font-weight:600">Auto-Resolve Rate by Device</div>';
        d.equipment_auto_resolve_rates.forEach(function(eq) {
          var pct = Math.round(eq.rate);
          var colorClass = pct >= 80 ? '' : pct >= 50 ? 'yellow' : 'red';
          html += '<div class="a-bar-row">';
          html += '<div class="a-bar-label">' + escapeHtml(eq.device) + '</div>';
          html += '<div class="a-bar-track"><div class="a-bar-fill ' + colorClass + '" style="width:' + pct + '%"></div></div>';
          html += '<div class="a-bar-value">' + pct + '%</div>';
          html += '</div>';
        });
      }
      el.innerHTML = html;
    }

    function aMetricBox(val, label) {
      return '<div class="a-metric-item"><div class="a-metric-val">' + val + '</div><div class="a-metric-lbl">' + label + '</div></div>';
    }
    function aFmtHours(h) {
      if (h === null || h === undefined) return '—';
      return h < 1 ? Math.round(h * 60) + 'm' : h.toFixed(1) + 'h';
    }

    // Client-side mirror of shared escapeHtml in src/auth.js
    // (inline because this runs in the browser, not Node)
    function escapeHtml(v) {
      if (typeof v !== 'string') return '';
      return v.replace(/[<>&"']/g, function(c) {
        return {'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c];
      });
    }

    function friendlyInputName(input) {
      if (input == null) return '';
      var n = Number(input);
      if (n >= 1 && n <= 40) return 'Cam ' + n;
      if (n >= 1000 && n < 2000) return 'Color Bars';
      if (n === 2001) return 'Color 1';
      if (n === 2002) return 'Color 2';
      if (n === 3010) return 'MP1';
      if (n === 3011) return 'MP1 Key';
      if (n === 3020) return 'MP2';
      if (n === 3021) return 'MP2 Key';
      if (n === 6000) return 'Super Source';
      if (n === 7001) return 'Clean Feed 1';
      if (n === 7002) return 'Clean Feed 2';
      if (n === 10010) return 'ME 1 PGM';
      if (n === 10011) return 'ME 1 PVW';
      return 'Input ' + n;
    }

    // ── Async modal dialogs (replaces confirm/prompt/alert) ─────────────
    function _showDialog(title, message, { input = false, defaultVal = '', cancelable = true, okLabel = 'OK', dangerOk = false } = {}) {
      return new Promise(resolve => {
        const backdrop = document.getElementById('modal-dialog');
        const bodyEl = document.getElementById('dialog-body');
        const inputWrap = document.getElementById('dialog-input-wrap');
        const inputEl = document.getElementById('dialog-input');
        const cancelBtn = document.getElementById('dialog-cancel');
        const okBtn = document.getElementById('dialog-ok');
        const closeX = document.getElementById('dialog-close-x');
        document.getElementById('dialog-title').textContent = title;
        bodyEl.textContent = message;
        inputWrap.style.display = input ? '' : 'none';
        inputEl.value = defaultVal;
        cancelBtn.style.display = cancelable ? '' : 'none';
        okBtn.textContent = okLabel;
        if (dangerOk) { okBtn.className = 'btn-danger'; } else { okBtn.className = 'btn-primary'; }

        function cleanup(val) {
          backdrop.classList.remove('open');
          okBtn.removeEventListener('click', onOk);
          cancelBtn.removeEventListener('click', onCancel);
          closeX.removeEventListener('click', onCancel);
          backdrop.removeEventListener('click', onBackdrop);
          resolve(val);
        }
        function onOk() { cleanup(input ? inputEl.value : true); }
        function onCancel() { cleanup(input ? null : false); }
        function onBackdrop(e) { if (e.target === backdrop) onCancel(); }

        okBtn.addEventListener('click', onOk);
        cancelBtn.addEventListener('click', onCancel);
        closeX.addEventListener('click', onCancel);
        backdrop.addEventListener('click', onBackdrop);
        backdrop.classList.add('open');
        if (input) { setTimeout(() => { inputEl.focus(); inputEl.select(); }, 100); }
        else { setTimeout(() => okBtn.focus(), 100); }
      });
    }

    function modalConfirm(message, { title = 'Confirm', okLabel = 'Confirm', dangerOk = false } = {}) {
      return _showDialog(title, message, { cancelable: true, okLabel, dangerOk });
    }
    function modalPrompt(message, defaultVal, { title = 'Input' } = {}) {
      return _showDialog(title, message, { input: true, defaultVal: defaultVal || '', cancelable: true });
    }
    function modalAlert(message, { title = 'Notice' } = {}) {
      return _showDialog(title, message, { cancelable: false, okLabel: 'OK' });
    }
    // ── Button loading state helper ───────────────────────────────────────
    function btnLoading(id, loadingText) {
      var btn = document.getElementById(id);
      if (!btn) return;
      btn._origText = btn.textContent;
      btn.disabled = true;
      btn.style.opacity = '0.7';
      btn.textContent = loadingText || 'Saving…';
    }
    function btnReset(id) {
      var btn = document.getElementById(id);
      if (!btn) return;
      btn.disabled = false;
      btn.style.opacity = '';
      btn.textContent = btn._origText || 'Save';
    }

    function modalCopyValue(label, value) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).then(() => toast('Copied to clipboard'));
      } else {
        return _showDialog(label, value, { cancelable: false, okLabel: 'Close' });
      }
    }

    async function loadSupportStatus() {
      var wrap = document.getElementById('support-status-components');
      if (!wrap) return;
      wrap.innerHTML = '<div style="color:#475569">Loading status...</div>';
      try {
        var r = await fetch('/api/status/components', { signal: AbortSignal.timeout(10000) });
        var payload = await r.json();
        var items = payload.components || [];
        if (!items.length) {
          wrap.innerHTML = '<div style="color:#475569">No status data available.</div>';
          return;
        }
        wrap.innerHTML = items.map(function(c) {
          var latency = c.latency_ms == null ? '—' : (c.latency_ms + ' ms');
          return '<div style=\"display:flex;justify-content:space-between;gap:10px;background:#09090B;border:1px solid #1a2e1f;border-radius:8px;padding:8px 10px\">' +
            '<div><div style=\"color:#F8FAFC;font-size:13px;font-weight:600\">' + escapeHtml(c.name) + '</div><div style=\"color:#64748B;font-size:12px\">' + escapeHtml(c.detail || '') + '</div></div>' +
            '<div style=\"text-align:right;font-size:12px\">' + supportStateChip(c.state) + '<div style=\"color:#64748B;margin-top:3px\">' + latency + '</div></div>' +
          '</div>';
        }).join('');
      } catch (e) {
        wrap.innerHTML = '<div style="color:#ef4444">Unable to load status right now.</div>';
      }
    }

    async function runSupportTriage() {
      try {
        var issue = document.getElementById('support-issue').value;
        var severity = document.getElementById('support-severity').value;
        var summary = document.getElementById('support-summary').value.trim();
        var triage = await api('POST', '/api/church/support/triage', {
          issueCategory: issue,
          severity: severity,
          summary: summary,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
        });
        supportTriage = triage;
        var checks = (triage.checks || []).map(function(c) {
          return (c.ok ? '\\u2705 ' : '\\u274C ') + c.note;
        }).join('<br>');
        var html = '<div style="background:#09090B;border:1px solid #1a2e1f;border-radius:8px;padding:14px">';
        html += '<div style="font-weight:700;color:#F8FAFC;margin-bottom:8px">Triage: ' + escapeHtml(triage.triageResult || 'monitoring') + '</div>';
        html += '<div style="color:#94A3B8;margin-bottom:10px">' + checks + '</div>';

        // AI Analysis
        var ai = triage.aiAnalysis;
        if (ai && ai.primaryCause) {
          html += '<div style="border-top:1px solid #1a2e1f;padding-top:10px;margin-top:10px">';
          html += '<div style="font-weight:700;color:#22c55e;font-size:13px;margin-bottom:8px">AI Diagnosis</div>';
          // Primary cause
          var conf = ai.primaryCause.confidence || 0;
          var confColor = conf >= 70 ? '#22c55e' : conf >= 40 ? '#eab308' : '#ef4444';
          html += '<div style="margin-bottom:8px"><span style="font-weight:700;color:#F8FAFC">' + escapeHtml(ai.primaryCause.cause) + '</span>';
          html += ' <span style="color:' + confColor + ';font-size:12px;font-weight:600">' + conf + '% confidence</span></div>';
          if (ai.primaryCause.explanation) {
            html += '<div style="color:#94A3B8;font-size:13px;margin-bottom:8px">' + escapeHtml(ai.primaryCause.explanation) + '</div>';
          }
          // Secondary causes
          if (ai.secondaryCauses && ai.secondaryCauses.length) {
            html += '<div style="font-size:12px;color:#475569;margin-bottom:8px">Also possible: ';
            html += ai.secondaryCauses.map(function(s) { return escapeHtml(s.cause) + ' (' + s.confidence + '%)'; }).join(', ');
            html += '</div>';
          }
          // Steps
          if (ai.steps && ai.steps.length) {
            html += '<div style="font-weight:600;color:#F8FAFC;font-size:12px;margin-bottom:4px">Recommended steps:</div>';
            html += '<ol style="color:#94A3B8;font-size:13px;padding-left:20px;margin:0">';
            ai.steps.forEach(function(step) { html += '<li style="margin-bottom:4px">' + escapeHtml(step) + '</li>'; });
            html += '</ol>';
          }
          // Suggested AutoPilot rule
          if (ai.suggestedRule) {
            html += '<div style="margin-top:12px;padding:10px;background:#0c2818;border:1px solid #16532e;border-radius:8px">';
            html += '<div style="font-size:12px;color:#22c55e;font-weight:600;margin-bottom:4px">💡 Suggested AutoPilot Rule</div>';
            html += '<div style="font-size:13px;color:#F8FAFC;font-weight:600">' + escapeHtml(ai.suggestedRule.name) + '</div>';
            html += '<div style="font-size:12px;color:#94A3B8">' + escapeHtml(ai.suggestedRule.description) + '</div>';
            html += '</div>';
          }
          html += '</div>';
        }
        html += '</div>';
        document.getElementById('support-triage-result').innerHTML = html;
        toast('Triage complete');
      } catch (e) {
        toast(e.message, true);
      }
    }

    async function createSupportTicket() {
      try {
        if (!supportTriage || !supportTriage.triageId) {
          await runSupportTriage();
        }
        if (!supportTriage || !supportTriage.triageId) {
          throw new Error('Run triage before opening a ticket');
        }
        var issue = document.getElementById('support-issue').value;
        var severity = document.getElementById('support-severity').value;
        var summary = document.getElementById('support-summary').value.trim();
        if (!summary) throw new Error('Please add a short summary before opening a ticket');

        await api('POST', '/api/church/support/tickets', {
          triageId: supportTriage.triageId,
          issueCategory: issue,
          severity: severity,
          title: summary.slice(0, 120),
          description: summary,
        });
        toast('Support ticket opened');
        document.getElementById('support-summary').value = '';
        await loadSupportTickets();
      } catch (e) {
        toast(e.message, true);
      }
    }

    function formatTicketStatus(status) {
      if (status === 'open') return 'Open';
      if (status === 'in_progress') return 'In Progress';
      if (status === 'waiting_customer') return 'Waiting on You';
      if (status === 'resolved') return 'Resolved';
      if (status === 'closed') return 'Closed';
      return status || 'Open';
    }

    async function addSupportUpdate(ticketId) {
      var note = await modalPrompt('Add an update to this ticket:', '', { title: 'Ticket Update' });
      if (!note) return;
      try {
        await api('POST', '/api/church/support/tickets/' + ticketId + '/updates', { message: note, status: 'waiting_customer' });
        toast('Update sent');
        await loadSupportTickets();
      } catch (e) {
        toast(e.message, true);
      }
    }

    async function loadSupportTickets() {
      var tbody = document.getElementById('support-tickets-tbody');
      if (!tbody) return;
      tbody.innerHTML = '<tr><td colspan=\"5\" style=\"color:#475569;text-align:center;padding:20px\">Loading...</td></tr>';
      try {
        var tickets = await api('GET', '/api/church/support/tickets?limit=25');
        if (!tickets.length) {
          tbody.innerHTML = '<tr><td colspan=\"5\" style=\"color:#475569;text-align:center;padding:20px\">No tickets yet.</td></tr>';
          return;
        }
        tbody.innerHTML = tickets.map(function(t) {
          return '<tr>' +
            '<td>' + new Date(t.created_at).toLocaleString() + '</td>' +
            '<td>' + escapeHtml(formatTicketStatus(t.status)) + '</td>' +
            '<td>' + escapeHtml(t.severity || 'P3') + '</td>' +
            '<td>' + escapeHtml(t.title || '') + '</td>' +
            '<td><button class=\"btn-secondary support-note-btn\" style=\"padding:6px 10px\" data-ticket-id=\"' + escapeHtml(t.id) + '\">Add note</button></td>' +
          '</tr>';
        }).join('');
        Array.from(tbody.querySelectorAll('.support-note-btn')).forEach(function(btn) {
          btn.addEventListener('click', function() {
            addSupportUpdate(btn.getAttribute('data-ticket-id'));
          });
        });
      } catch (e) {
        tbody.innerHTML = '<tr><td colspan=\"5\" style=\"color:#ef4444;text-align:center;padding:20px\">' + escapeHtml(e.message) + '</td></tr>';
      }
    }

    // ── Contextual Help ───────────────────────────────────────────────────────
    var HELP_CONTENT = {
      overview: {
        title: 'Overview — What Am I Looking At?',
        body: `
          <p>This is your <strong>church dashboard</strong> — your mission control for Sunday morning. Think of it like the check-engine light for your production system, except it actually tells you what's wrong.</p>
          <h3>Connection Status</h3>
          <p>The green dot means the Tally desktop app installed at your church is talking to this portal. If it's gray, check that your AV computer is on and the Tally app is running.</p>
          <h3>Equipment Status Table</h3>
          <p>Shows every device Tally is monitoring — your ATEM switcher, OBS (for recording/streaming), ProPresenter, and more. <strong>Green = connected and working. Yellow = warning. Red = problem.</strong></p>
          <div class="tip-box"><strong>Tip:</strong> <strong>Tip for Worship Pastors:</strong> You don't need to understand every row. Just check that everything is green before service starts. If anything is yellow or red, tap your TD on Telegram.</div>
          <h3>Live Session</h3>
          <p>During a service, the "Live Session" card appears with real-time status. You can see if the stream is healthy and if any auto-recoveries have run.</p>
          <h3>Activity Feed</h3>
          <p>A log of everything that happened — stream started, camera switched, alert sent, auto-recovery ran. Great for the debrief after service.</p>
        `,
      },
      profile: {
        title: 'Profile & Settings',
        body: `
          <p>This is where you set up your church's basic information and connect Tally to your notification channels.</p>
          <h3>Church Name & Contact</h3>
          <p>Keep this accurate — it shows up in alerts sent to your tech team so they know which church it's for (important if your TD supports multiple rooms).</p>
          <h3>Notifications</h3>
          <p>Choose how you want to receive alerts. <strong>Telegram is required</strong> — it's how Tally reaches your tech director during service. Email and SMS are for non-urgent notifications like weekly summaries.</p>
          <div class="tip-box"><strong>Tip:</strong> Telegram is a free messaging app. Your TD downloads it once, clicks a setup link, and they're connected. Most TDs prefer it over text messages during service.</div>
          <h3>Auto-Recovery</h3>
          <p>When enabled, Tally will try to fix common problems automatically (restart a dropped stream, reconnect a disconnected device) before alerting anyone. This handles the "5-second blip" situations automatically.</p>
        `,
      },
      rooms: {
        title: 'Rooms — Managing Physical Spaces',
        body: `
          <p>Rooms represent physical spaces where your production equipment lives — Main Sanctuary, Youth Room, Chapel, etc.</p>
          <h3>How it works</h3>
          <p>Create a room for each physical space, then assign a Tally desktop app to that room from the app's Equipment tab. Each room tracks its own equipment status, alerts, and sessions independently.</p>
          <h3>Adding a Room</h3>
          <ol style="padding-left:18px">
            <li>Click "+ Add Room" on the Rooms tab</li>
            <li>Enter the room name (e.g., Main Sanctuary)</li>
            <li>In the Tally desktop app, go to Equipment and select the room</li>
          </ol>
          <div class="tip-box"><strong>Tip:</strong> Use room names that your team recognizes. When alerts fire, they'll reference the room name so your TD knows exactly where to go.</div>
          <h3>Plan Limits</h3>
          <p>The number of rooms you can create depends on your plan: Connect (1), Plus (3), Pro (10), Enterprise (unlimited).</p>
        `,
      },
      tds: {
        title: 'Tech Directors — Who Gets Alerts?',
        body: `
          <p>Tech Directors (TDs) are the people who receive alerts when something goes wrong during your service. Think of them as your "first responders" for production issues.</p>
          <h3>Primary TD vs. On-Call TD</h3>
          <p><strong>Primary TD</strong> is your main tech person. They get escalated alerts if no one else responds.<br><strong>On-Call TD</strong> is whoever is running the board that week. They receive the first alert.</p>
          <h3>On-Call Rotation</h3>
          <p>TDs can swap on-call duty themselves via Telegram using <code style="color:#22c55e">/swap [name]</code>. No need to update the portal every week.</p>
          <div class="tip-box"><strong>Tip:</strong> <strong>For volunteer teams:</strong> Even if you only have one tech person, add them as both Primary and On-Call so they always get alerts. If you have a team, rotate so no one gets burned out.</div>
          <h3>Connecting via Telegram</h3>
          <p>After you add a TD, click "Copy Link" to get their Telegram deep link. They click it, Telegram opens, and they're connected automatically. That's it — no codes to memorize.</p>
        `,
      },
      schedule: {
        title: 'Service Schedule — When Are You Live?',
        body: `
          <p>Tally uses your schedule to know when to be alert. Outside of service windows, most alerts are suppressed so your TD doesn't get woken up at 3 AM over a test stream.</p>
          <h3>Service Windows</h3>
          <p>Add each time slot when you're regularly live. For example:</p>
          <ul>
            <li>Sunday 8:30 AM – 10:30 AM (first service)</li>
            <li>Sunday 11:00 AM – 1:00 PM (second service)</li>
            <li>Wednesday 6:30 PM – 8:00 PM (midweek)</li>
          </ul>
          <div class="tip-box"><strong>Tip:</strong> Add a "buffer" window — if your service starts at 9 AM, set the window to start at 8:30 AM so Tally is watching during setup. Pre-service issues are caught before you go live.</div>
          <h3>Why This Matters</h3>
          <p>The AutoPilot features (Pro plan) use these windows to auto-start streaming and recording at the right time. Without a schedule, you'd have to manually trigger everything.</p>
        `,
      },
      notifications: {
        title: 'Notifications & Failover',
        body: `
          <h3>Notification Channels</h3>
          <p>Choose how Tally reaches your team. <strong>Telegram is the primary channel</strong> — it's fast, reliable, and supports the interactive buttons your TD needs to acknowledge alerts and run commands.</p>
          <h3>Stream Failover</h3>
          <p>This is Tally's "insurance policy" for your stream. When enabled, if your encoder signal drops for more than a few seconds, Tally will:</p>
          <ol style="padding-left:18px">
            <li>Alert your TD via Telegram</li>
            <li>Wait for them to tap a button to confirm they're on it</li>
            <li>If no response in 30 seconds, automatically switch your ATEM to a safe backup source (like your media player with a holding slide)</li>
          </ol>
          <div class="tip-box"><strong>Tip:</strong> <strong>Real example:</strong> Your camera feed dies mid-sermon. Tally detects the black signal, alerts your TD, and if they don't respond in 30 seconds, automatically switches to a "We'll be right back" slide. Your online congregation sees a clean transition instead of a black screen.</div>
          <h3>Failover Drill</h3>
          <p>Use the Failover Drill button to simulate this scenario without affecting anything real. Run it before a big Sunday to make sure everything is configured correctly.</p>
        `,
      },
      engineer: {
        title: 'Tally Engineer — Your AI Assistant',
        body: `
          <p>Tally Engineer is an AI trained on church production. You can ask it anything about your setup, and it will diagnose problems, suggest fixes, and even run commands.</p>
          <h3>What Can It Do?</h3>
          <ul>
            <li>Diagnose "why is my stream choppy?" by looking at your actual equipment data</li>
            <li>Answer questions like "what's the best bitrate for YouTube at 720p?"</li>
            <li>Run commands: "start recording in OBS" or "switch ATEM to camera 2"</li>
            <li>Generate a pre-service checklist based on your specific equipment</li>
          </ul>
          <h3>Training Your Engineer</h3>
          <p>The more you tell it about your setup, the better it gets. Fill in your equipment details (ATEM model, OBS settings, typical service flow) and Tally Engineer will give more accurate diagnoses.</p>
          <div class="tip-box"><strong>Tip:</strong> <strong>For non-technical staff:</strong> You can type exactly what you're seeing: "the stream keeps buffering for online viewers" and Tally Engineer will ask follow-up questions and walk you through the fix — no tech jargon required.</div>
        `,
      },
      guests: {
        title: 'Guest Access — Temporary TD Access',
        body: `
          <p>Sometimes you need to give a substitute tech director access for a single service — a volunteer covering while your regular TD is sick, or a guest worship leader who needs to run commands.</p>
          <h3>How Guest Tokens Work</h3>
          <p>Generate a guest token and send the link to the substitute. They click it in Telegram and get temporary access for a set number of hours. When time expires, access is automatically revoked — no cleanup needed.</p>
          <h3>What Can Guests Do?</h3>
          <p>Guests have the same alert access as a regular TD — they can receive alerts and tap response buttons in Telegram. You can choose whether they can also run commands (like switching sources).</p>
          <div class="tip-box"><strong>Tip:</strong> <strong>Best practice:</strong> Generate the guest token 30 minutes before service and send it to your substitute. That gives them time to connect before you go live. Set expiry to match your service length plus 30 minutes.</div>
        `,
      },
      sessions: {
        title: 'Sessions — Service History',
        body: `
          <p>Every service gets its own session record — a complete log of what happened, what alerts fired, and how they were resolved.</p>
          <h3>What's in a Session?</h3>
          <ul>
            <li>Start/end times of your service</li>
            <li>All alerts that fired, with timestamps</li>
            <li>How each alert was resolved (TD ack, auto-recovery, or unknown)</li>
            <li>Stream uptime and health grade</li>
            <li>Commands run during service</li>
          </ul>
          <h3>Health Grade</h3>
          <p>Each session gets a letter grade (A–F) based on stream stability, alert frequency, and recovery time. Your goal is an A every week.</p>
          <div class="tip-box"><strong>Tip:</strong> Review sessions after service to spot patterns. If you're getting the same alert three weeks in a row, that's a setup problem worth fixing rather than just acknowledging every Sunday.</div>
        `,
      },
      alerts: {
        title: 'Alerts — Understanding Your Notifications',
        body: `
          <p>Alerts are how Tally tells you something needs attention. They arrive in Telegram during service and appear here in the portal afterward.</p>
          <h3>Alert Severity</h3>
          <ul>
            <li><strong style="color:#ef4444">Critical</strong> — Stream is down or about to fail. Respond immediately.</li>
            <li><strong style="color:#eab308">Warning</strong> — Something is degraded but not broken yet. Investigate soon.</li>
            <li><strong style="color:#22c55e">Info</strong> — Informational. Stream started, recording began, pre-service check passed.</li>
          </ul>
          <h3>Responding to Alerts</h3>
          <p>When you get an alert in Telegram, you'll see response buttons like "On it" and "Run Diagnostics." Tapping "On it" tells Tally you've seen it and are handling it — this prevents auto-failover from kicking in.</p>
          <div class="tip-box"><strong>Tip:</strong> The most important thing to know: <strong>always tap a response button when you get an alert</strong>. Tally is watching to see if a human is handling the situation. No response = auto-failover after 30 seconds.</div>
        `,
      },
    };

    function openHelp(section) {
      var content = HELP_CONTENT[section];
      if (!content) return;
      document.getElementById('help-modal-title').textContent = content.title;
      document.getElementById('help-modal-body').innerHTML = content.body;
      document.getElementById('help-modal').classList.add('open');
    }

    function closeHelpModal() {
      document.getElementById('help-modal').classList.remove('open');
    }

    // Close help modal on backdrop click
    document.getElementById('help-modal').addEventListener('click', function(e) {
      if (e.target === this) closeHelpModal();
    });

    // ── Logout ────────────────────────────────────────────────────────────────
    async function logout() {
      await fetch('/api/church/logout', { method: 'POST', credentials: 'include' });
      window.location.href = '/church-login';
    }

    // Apply i18n translations to all data-i18n elements based on navigator.language
    translatePage();

    // Auto-load overview + billing banner on start
    loadOverview();
    startOverviewPoll();
    loadBilling(); // populates billing banner on all pages

    // ── Real-time status push via SSE ─────────────────────────────────────────
    // Connect to the server-sent event stream for this church. When the server
    // pushes a status_update we patch the equipment table live, so the worship
    // pastor or TD doesn't need to manually refresh.
    (function initPortalStatusStream() {
      var es;
      var reconnectDelay = 3000;

      function connect() {
        if (es) { try { es.close(); } catch {} }
        es = new EventSource('/api/church/stream');

        es.onmessage = function(event) {
          try {
            var data = JSON.parse(event.data);
            if (data.type === 'status_update' || data.type === 'status_snapshot' || data.type === 'connected') {
              if (data.status) {
                // Update the status dot on the connection stat card
                var dot = document.getElementById('stat-status-dot');
                var txt = document.getElementById('stat-status-text');
                if (dot && txt) {
                  var isConnected = data.type === 'connected' || !!(data.status.connected !== false && (data.status.atem || data.status.obs || data.status.encoder));
                  dot.style.background = isConnected ? '#22c55e' : '#475569';
                  txt.textContent = isConnected ? 'Connected' : 'Offline';
                }
                // Pulse the equipment staleness indicator
                var stale = document.getElementById('equip-staleness');
                if (stale) {
                  stale.textContent = 'Live';
                  stale.style.color = '#22c55e';
                }
                // Refresh the equipment table if the overview page is visible
                if (document.getElementById('page-overview').classList.contains('active')) {
                  loadOverview();
                }
              }
            } else if (data.type === 'viewer_update') {
              var card = document.getElementById('live-viewers-card');
              if (card && data.total !== undefined) {
                card.style.display = '';
                document.getElementById('live-viewers-total').textContent = data.total.toLocaleString();
                var bd = data.breakdown || {};
                var parts = [];
                if (bd.youtube !== undefined) parts.push('<span style="color:#ff0000">YT: ' + bd.youtube + '</span>');
                if (bd.facebook !== undefined) parts.push('<span style="color:#1877f2">FB: ' + bd.facebook + '</span>');
                if (bd.vimeo !== undefined) parts.push('<span style="color:#1ab7ea">Vim: ' + bd.vimeo + '</span>');
                document.getElementById('live-viewers-breakdown').innerHTML = parts.join(' ');
                // Sparkline: append a bar
                var spark = document.getElementById('live-viewers-sparkline');
                if (spark) {
                  if (!window._viewerSparkData) window._viewerSparkData = [];
                  window._viewerSparkData.push(data.total);
                  if (window._viewerSparkData.length > 30) window._viewerSparkData.shift();
                  var max = Math.max.apply(null, window._viewerSparkData) || 1;
                  spark.innerHTML = window._viewerSparkData.map(function(v) {
                    var h = Math.max(2, Math.round((v / max) * 36));
                    return '<div style="flex:1;height:' + h + 'px;background:#22c55e;border-radius:2px;min-width:2px"></div>';
                  }).join('');
                }
              }
            } else if (data.type === 'disconnected') {
              var dot2 = document.getElementById('stat-status-dot');
              var txt2 = document.getElementById('stat-status-text');
              if (dot2 && txt2) { dot2.style.background = '#475569'; txt2.textContent = 'Offline'; }
            }
          } catch {}
          reconnectDelay = 3000; // reset backoff on successful message
        };

        es.onerror = function() {
          es.close();
          // Exponential backoff up to 30s
          setTimeout(connect, reconnectDelay);
          reconnectDelay = Math.min(reconnectDelay * 2, 30000);
        };
      }

      connect();

      // Close stream on page hide to avoid zombie SSE connections
      document.addEventListener('visibilitychange', function() {
        if (document.hidden) {
          if (es) { try { es.close(); } catch {} es = null; }
        } else {
          connect();
        }
      });
    })();

// ── CSP-safe event delegation ─────────────────────────────────────────────────
// Replaces all inline onclick/onchange/onkeydown/oninput handlers that were
// removed from portal.html so that 'unsafe-inline' can be dropped from CSP.
document.addEventListener('DOMContentLoaded', function() {

  // ── Click delegation ────────────────────────────────────────────────────────
  document.addEventListener('click', function(e) {
    var btn = e.target.closest('[data-action]');
    if (!btn) return;
    var action = btn.dataset.action;
    var page   = btn.dataset.page;
    var modal  = btn.dataset.modal;

    switch (action) {
      // Navigation
      case 'showPage':
        if (typeof showPage === 'function') {
          var navBtn = document.querySelector('.nav-item[data-page="' + page + '"]') || btn;
          showPage(page, navBtn);
        }
        break;

      // Mobile nav
      case 'toggleMobileNav':
        if (typeof toggleMobileNav === 'function') toggleMobileNav();
        break;

      // Language
      case 'toggleLanguage':
        if (typeof toggleLanguage === 'function') toggleLanguage();
        break;

      // Auth
      case 'logout':
        if (typeof logout === 'function') logout();
        break;

      // Volunteer mode
      case 'toggleVolunteerMode':
        if (typeof toggleVolunteerMode === 'function') toggleVolunteerMode();
        break;

      // Theme
      case 'toggleTheme':
        if (typeof toggleTheme === 'function') toggleTheme();
        break;



      // Contextual help
      case 'openHelp':
        if (typeof openHelp === 'function') openHelp(btn.dataset.helpPage);
        break;
      case 'closeHelpModal':
        if (typeof closeHelpModal === 'function') closeHelpModal();
        break;

      // Onboarding checklist
      case 'dismissOnboarding':
        if (typeof dismissOnboarding === 'function') dismissOnboarding();
        break;
      case 'undismissOnboarding':
        if (typeof undismissOnboarding === 'function') undismissOnboarding();
        break;

      // Pre-service check
      case 'fixAllPreServiceIssues':
        if (typeof fixAllPreServiceIssues === 'function') fixAllPreServiceIssues();
        break;
      case 'runPreServiceCheck':
        if (typeof runPreServiceCheck === 'function') runPreServiceCheck();
        break;

      // Equipment
      case 'refreshEquipmentStatus':
        if (typeof refreshEquipmentStatus === 'function') refreshEquipmentStatus();
        break;

      // Profile
      case 'saveProfile':
        if (typeof saveProfile === 'function') saveProfile();
        break;
      case 'saveChurchType':
        if (typeof saveChurchType === 'function') saveChurchType();
        break;
      case 'changePassword':
        if (typeof changePassword === 'function') changePassword();
        break;
      case 'copyIngestKey':
        (function() {
          var el = document.getElementById('eq-ingest-key');
          if (el && el.textContent && el.textContent !== '—') {
            navigator.clipboard.writeText(el.textContent).then(function() { toast('Copied to clipboard'); });
          }
        })();
        break;
      case 'regenIngestKey':
        (async function() {
          if (!confirm('Regenerate ingest key? The old key will stop working.')) return;
          try {
            var d = await api('POST', '/api/church/config/ingest-key/regenerate');
            document.getElementById('eq-ingest-key').textContent = d.ingestStreamKey;
            toast('Ingest key regenerated');
          } catch(e) { toast(e.message, true); }
        })();
        break;

      case 'addRoom':
        if (typeof addRoom === 'function') addRoom();
        break;
      case 'editRoom':
        if (typeof editRoom === 'function') editRoom(btn.dataset.roomId, btn.dataset.roomName);
        break;
      case 'deleteRoom':
        if (typeof deleteRoom === 'function') deleteRoom(btn.dataset.roomId, btn.dataset.roomName);
        break;

      // Tech directors
      case 'copyTdInviteLink':
        if (typeof copyTdInviteLink === 'function') copyTdInviteLink();
        break;
      case 'addTd':
        if (typeof addTd === 'function') addTd();
        break;

      // Schedule
      case 'addScheduleRow':
        if (typeof addScheduleRow === 'function') addScheduleRow();
        break;
      case 'saveSchedule':
        if (typeof saveSchedule === 'function') saveSchedule();
        break;

      // Notifications / failover
      case 'saveNotifications':
        if (typeof saveNotifications === 'function') saveNotifications();
        break;
      case 'saveFailoverSettings':
        if (typeof saveFailoverSettings === 'function') saveFailoverSettings();
        break;
      case 'runFailoverDrill':
        if (typeof runFailoverDrill === 'function') runFailoverDrill();
        break;

      // Equipment
      case 'saveEquipment':
        if (typeof saveEquipment === 'function') saveEquipment();
        break;
      case 'addPtzRow':
        if (typeof addEquipmentRow === 'function') addEquipmentRow('ptz');
        break;
      case 'addHyperdeckRow':
        if (typeof addEquipmentRow === 'function') addEquipmentRow('hyperdeck');
        break;
      case 'addVideohubRow':
        if (typeof addEquipmentRow === 'function') addEquipmentRow('videohub');
        break;

      // Tally Engineer
      case 'saveEngineerProfile':
        if (typeof saveEngineerProfile === 'function') saveEngineerProfile();
        break;
      case 'clearEngineerChat':
        if (typeof clearEngineerChat === 'function') clearEngineerChat();
        break;
      case 'sendEngineerPill':
        if (typeof sendEngineerPill === 'function') sendEngineerPill(btn);
        break;
      case 'sendEngineerChat':
        if (typeof sendEngineerChat === 'function') sendEngineerChat();
        break;

      // Guest tokens
      case 'generateGuestToken':
        if (typeof generateGuestToken === 'function') generateGuestToken();
        break;

      // Macros
      case 'closeMacroModal':
        if (typeof closeMacroModal === 'function') closeMacroModal();
        break;
      case 'saveMacro':
        if (typeof saveMacro === 'function') saveMacro();
        break;

      // AutoPilot
      case 'toggleAutopilotPause':
        if (typeof toggleAutopilotPause === 'function') toggleAutopilotPause();
        break;
      case 'saveAutopilotRule':
        if (typeof saveAutopilotRule === 'function') saveAutopilotRule();
        break;

      // Analytics
      case 'setAnalyticsRange':
        if (typeof setAnalyticsRange === 'function') setAnalyticsRange(parseInt(btn.dataset.days, 10), btn);
        break;
      case 'exportAnalyticsCSV':
        if (typeof exportAnalyticsCSV === 'function') exportAnalyticsCSV();
        break;

      // Referrals
      case 'copyRefPageLink':
        if (typeof copyRefPageLink === 'function') copyRefPageLink();
        break;
      case 'shareRefEmail':
        if (typeof shareRefEmail === 'function') shareRefEmail();
        break;
      case 'shareRefSMS':
        if (typeof shareRefSMS === 'function') shareRefSMS();
        break;

      // Support
      case 'runSupportTriage':
        if (typeof runSupportTriage === 'function') runSupportTriage();
        break;
      case 'createSupportTicket':
        if (typeof createSupportTicket === 'function') createSupportTicket();
        break;
      case 'loadSupportTickets':
        if (typeof loadSupportTickets === 'function') loadSupportTickets();
        break;

      // Review modal
      case 'closeReviewModal':
        if (typeof closeReviewModal === 'function') closeReviewModal();
        break;
      case 'submitReview':
        if (typeof submitReview === 'function') submitReview();
        break;

      // Billing / retention
      case 'acceptRetentionOffer':
        if (typeof acceptRetentionOffer === 'function') acceptRetentionOffer();
        break;
      case 'confirmCancellation':
        if (typeof confirmCancellation === 'function') confirmCancellation();
        break;

      // Generic modal open/close
      case 'openModal':
        if (modal) { var m = document.getElementById(modal); if (m) m.classList.add('open'); }
        break;
      case 'closeModal':
        if (modal) { var mc = document.getElementById(modal); if (mc) mc.classList.remove('open'); }
        break;
      case 'closeModalAndShowPage':
        if (modal) { var mcsp = document.getElementById(modal); if (mcsp) mcsp.classList.remove('open'); }
        if (page && typeof showPage === 'function') {
          var navBtnCmsp = document.querySelector('.nav-item[data-page="' + page + '"]') || btn;
          showPage(page, navBtnCmsp);
        }
        break;
    }
  });

  // ── Change delegation (select elements with data-action-change) ─────────────
  document.addEventListener('change', function(e) {
    var el = e.target;
    if (!el.dataset.actionChange) return;
    var action = el.dataset.actionChange;
    switch (action) {
      case 'loadProblems':
        if (typeof loadProblems === 'function') loadProblems();
        break;
      case 'toggleFailoverAction':
        if (typeof toggleFailoverAction === 'function') toggleFailoverAction();
        break;
      case 'loadSchedule':
        if (typeof loadSchedule === 'function') loadSchedule();
        break;
    }
  });

  // ── Keydown delegation (inputs with data-action-keydown) ────────────────────
  document.addEventListener('keydown', function(e) {
    var el = e.target;
    if (!el.dataset.actionKeydown) return;
    var action = el.dataset.actionKeydown;
    switch (action) {
      case 'sendEngineerChatOnEnter':
        if (e.key === 'Enter' && typeof sendEngineerChat === 'function') sendEngineerChat();
        break;
    }
  });

  // ── Input delegation (inputs with data-action-input) ────────────────────────
  document.addEventListener('input', function(e) {
    var el = e.target;
    if (!el.dataset.actionInput) return;
    var action = el.dataset.actionInput;
    switch (action) {
      case 'sanitizeMacroName':
        el.value = el.value.replace(/[^a-z0-9_]/g, '').toLowerCase();
        break;
    }
  });

});