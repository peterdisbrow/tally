const { toInt } = require('./helpers');

async function propresenterNext(agent) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  await agent.proPresenter.nextSlide();
  if (agent.proPresenterBackup) agent.proPresenterBackup.nextSlide().catch(() => {});
  return 'Next slide';
}

async function propresenterPrevious(agent) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  await agent.proPresenter.previousSlide();
  if (agent.proPresenterBackup) agent.proPresenterBackup.previousSlide().catch(() => {});
  return 'Previous slide';
}

async function propresenterGoToSlide(agent, params) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  // Users provide 1-based slide numbers ("slide 5" = the 5th slide shown in PP).
  // The PP API uses 0-based indices, so subtract 1. Clamp to 0 to avoid negatives.
  const userSlide = params.index || 0;
  const apiIndex = Math.max(0, userSlide - 1);
  await agent.proPresenter.goToSlide(apiIndex);
  if (agent.proPresenterBackup) agent.proPresenterBackup.goToSlide(apiIndex).catch(() => {});
  return `Jumped to slide ${userSlide}`;
}

async function propresenterStatus(agent) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const slide = await agent.proPresenter.getCurrentSlide();

  if (!slide) {
    return '📺 ProPresenter — ❌ Offline\n\nProPresenter is not responding. Check that it is running.';
  }

  const pp = agent.proPresenter;
  const lines = [
    '📺 ProPresenter — ✅ Running',
    '',
    `🎬 Presentation: ${slide.presentationName || 'Untitled'}`,
    `📄 Slide: ${slide.slideIndex + 1} of ${slide.slideTotal}`,
  ];

  // Active look
  if (pp._activeLook) {
    lines.push(`🎨 Active Look: ${pp._activeLook.name}`);
  }

  // Running timers
  const running = (pp._activeTimers || []).filter(t => t.state === 'Running' || t.state === 'Overrun');
  if (running.length > 0) {
    lines.push('');
    lines.push('⏱️ Timers:');
    for (const t of running) {
      lines.push(`  ${t.name}: ${t.time}${t.state === 'Overrun' ? ' ⚠️ OVERRUN' : ''}`);
    }
  }

  // Audience screens
  if (pp._screenStatus) {
    lines.push(`📺 Audience Screen: ${pp._screenStatus.audience ? 'ON' : 'OFF'}`);
  }

  // Slide notes (truncated)
  if (slide.slideNotes) {
    const notes = slide.slideNotes.length > 200
      ? slide.slideNotes.substring(0, 200) + '...'
      : slide.slideNotes;
    lines.push('');
    lines.push(`📝 Notes: ${notes}`);
  }

  // Playlist position
  if (pp._playlistFocused?.name) {
    lines.push(`📋 Playlist: ${pp._playlistFocused.name}`);
  }

  // Backup status
  if (pp._backup) {
    lines.push(`🔄 Backup PP: ${pp._backup.connected ? '✅ Connected' : '❌ Disconnected'}`);
  }

  return lines.join('\n');
}

async function propresenterPlaylist(agent) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const items = await agent.proPresenter.getPlaylist();
  if (!items.length) return 'No playlist items found';
  return items.map(i => i.name).join('\n');
}

async function propresenterIsRunning(agent) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const running = await agent.proPresenter.isRunning();
  return running ? '📺 ProPresenter — ✅ Running' : '📺 ProPresenter — ❌ Not reachable';
}

async function propresenterClearAll(agent) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  await agent.proPresenter.clearAll();
  return 'All layers cleared';
}

async function propresenterClearSlide(agent) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  await agent.proPresenter.clearSlide();
  return 'Slide layer cleared';
}

async function propresenterStageMessage(agent, params) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  if (!params.name) throw new Error('Message name required');
  await agent.proPresenter.triggerMessage(params.name, params.tokens || []);
  return `Stage message "${params.name}" triggered`;
}

async function propresenterClearMessage(agent) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  await agent.proPresenter.clearMessages();
  return 'Stage messages cleared';
}

async function propresenterGetLooks(agent) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const looks = await agent.proPresenter.getLooks();
  if (!looks.length) return 'No looks found';
  return looks.map(l => l.name).join('\n');
}

async function propresenterSetLook(agent, params) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  if (!params.name) throw new Error('Look name required');
  const name = await agent.proPresenter.setLook(params.name);
  return `Look set to "${name}"`;
}

async function propresenterGetTimers(agent) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const timers = await agent.proPresenter.getTimers();
  if (!timers.length) return 'No timers found';
  return timers.map(t => `${t.name}${t.allows_overrun ? ' (overrun)' : ''}`).join('\n');
}

async function propresenterStartTimer(agent, params) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  if (!params.name) throw new Error('Timer name required');
  const name = await agent.proPresenter.startTimer(params.name);
  return `Timer "${name}" started`;
}

async function propresenterStopTimer(agent, params) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  if (!params.name) throw new Error('Timer name required');
  const name = await agent.proPresenter.stopTimer(params.name);
  return `Timer "${name}" stopped`;
}

async function propresenterVersion(agent) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const version = await agent.proPresenter.getVersion();
  if (!version) return 'ProPresenter version not available (not reachable)';
  return `ProPresenter ${version}`;
}

async function propresenterMessages(agent) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const messages = await agent.proPresenter.getMessages();
  if (!messages.length) return 'No messages found';
  return messages.map(m => `${m.name} (${m.id})`).join('\n');
}

// ─── NEW COMMANDS ──────────────────────────────────────────────────────

async function propresenterActiveLook(agent) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const look = await agent.proPresenter.getActiveLook();
  if (!look) return 'No active look (ProPresenter not responding)';
  return `🎨 Active Look: ${look.name}`;
}

async function propresenterTimerStatus(agent) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const timers = await agent.proPresenter.getTimerStatus();
  if (!timers.length) return 'No timers configured';
  return timers.map(t => {
    const icon = t.state === 'Running' ? '▶️' : t.state === 'Overrun' ? '⚠️' : '⏸️';
    return `${icon} ${t.name}: ${t.time} (${t.state})`;
  }).join('\n');
}

async function propresenterScreenStatus(agent) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const screens = await agent.proPresenter.getAudienceScreenStatus();
  if (!screens) return 'Screen status not available';
  return `📺 Audience: ${screens.audience ? 'ON' : 'OFF'}\n🖥️ Stage: ${screens.stage ? 'ON' : 'OFF'}`;
}

async function propresenterLibraries(agent) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const libs = await agent.proPresenter.getLibraries();
  if (!libs.length) return 'No libraries found';
  const lines = [];
  for (const lib of libs) {
    lines.push(`📁 ${lib.name} (${lib.presentations.length} items)`);
    for (const p of lib.presentations.slice(0, 10)) {
      lines.push(`   • ${p.name}`);
    }
    if (lib.presentations.length > 10) {
      lines.push(`   ... and ${lib.presentations.length - 10} more`);
    }
  }
  return lines.join('\n');
}

async function propresenterLastSlide(agent) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const slide = await agent.proPresenter.getCurrentSlide();
  if (!slide || !slide.slideTotal) throw new Error('Could not determine slide count from ProPresenter');
  const lastIndex = Math.max(0, slide.slideTotal - 1); // 0-based API index of last slide
  await agent.proPresenter.goToSlide(lastIndex);
  if (agent.proPresenterBackup) agent.proPresenterBackup.goToSlide(lastIndex).catch(() => {});
  return `Jumped to last slide (slide ${slide.slideTotal})`;
}

async function propresenterAudienceScreens(agent, params) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  if (params.on === undefined && params.state === undefined) {
    throw new Error('Specify on: true/false');
  }
  const on = params.on ?? params.state ?? true;
  const result = await agent.proPresenter.setAudienceScreens(on);
  return result;
}

// ─── COMPANION PARITY: Trigger Presentation ───────────────────────────

async function propresenterTriggerPresentation(agent, params) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const name = String(params.name || params.uuid || '').trim();
  if (!name) throw new Error('presentation name or UUID required');
  const result = await agent.proPresenter.triggerPresentation(name);
  return `Triggered presentation "${result}"`;
}

async function propresenterTriggerPlaylistItem(agent, params) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const playlist = String(params.playlist || '').trim();
  if (!playlist) throw new Error('playlist name required');
  const index = params.index != null ? toInt(params.index, 'index') : 0;
  const result = await agent.proPresenter.triggerPlaylistItem(playlist, index);
  return `Triggered playlist "${result}" item ${index}`;
}

// ─── COMPANION PARITY: Props ──────────────────────────────────────────

async function propresenterGetProps(agent) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const props = await agent.proPresenter.getProps();
  if (!props.length) return 'No props found';
  return props.map(p => p.name).join('\n');
}

async function propresenterTriggerProp(agent, params) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const name = String(params.name || '').trim();
  if (!name) throw new Error('prop name required');
  const result = await agent.proPresenter.triggerProp(name);
  return `Prop "${result}" triggered`;
}

async function propresenterClearProps(agent) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  await agent.proPresenter.clearProps();
  return 'Props layer cleared';
}

// ─── COMPANION PARITY: Timer Reset & Create ───────────────────────────

async function propresenterResetTimer(agent, params) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  if (!params.name) throw new Error('Timer name required');
  const name = await agent.proPresenter.resetTimer(params.name);
  return `Timer "${name}" reset`;
}

async function propresenterCreateTimer(agent, params) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  if (!params.name) throw new Error('Timer name required');
  const name = await agent.proPresenter.createTimer(params.name, {
    allowsOverrun: params.allowsOverrun || false,
    countdownDuration: params.duration || null,
  });
  return `Timer "${name}" created`;
}

// ─── COMPANION PARITY: Groups ─────────────────────────────────────────

async function propresenterGetGroups(agent) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const groups = await agent.proPresenter.getGroups();
  if (!groups.length) return 'No groups found';
  return groups.map(g => g.name).join('\n');
}

async function propresenterTriggerGroup(agent, params) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const name = String(params.name || '').trim();
  if (!name) throw new Error('group name required');
  const result = await agent.proPresenter.triggerGroup(name);
  return `Group "${result}" triggered`;
}

// ─── COMPANION PARITY: Announcements ──────────────────────────────────

async function propresenterNextAnnouncement(agent) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  await agent.proPresenter.nextAnnouncement();
  return 'Next announcement slide';
}

async function propresenterPreviousAnnouncement(agent) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  await agent.proPresenter.previousAnnouncement();
  return 'Previous announcement slide';
}

async function propresenterAnnouncementStatus(agent) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const status = await agent.proPresenter.getAnnouncementStatus();
  if (!status) return 'No active announcement';
  return `Announcement: ${status.presentationName || 'Unknown'} — slide ${status.slideIndex + 1} of ${status.slideCount}`;
}

// ─── COMPANION PARITY: Macros ─────────────────────────────────────────

async function propresenterGetMacros(agent) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const macros = await agent.proPresenter.getMacros();
  if (!macros.length) return 'No macros found';
  return macros.map(m => m.name).join('\n');
}

async function propresenterTriggerMacro(agent, params) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const name = String(params.name || '').trim();
  if (!name) throw new Error('macro name required');
  const result = await agent.proPresenter.triggerMacro(name);
  return `Macro "${result}" triggered`;
}

// ─── COMPANION PARITY: Stage Layouts ──────────────────────────────────

async function propresenterGetStageLayouts(agent) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const layouts = await agent.proPresenter.getStageLayouts();
  if (!layouts.length) return 'No stage layouts found';
  return layouts.map(l => l.name).join('\n');
}

async function propresenterSetStageLayout(agent, params) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const name = String(params.name || '').trim();
  if (!name) throw new Error('layout name required');
  const screen = params.screen != null ? toInt(params.screen, 'screen') : 0;
  const result = await agent.proPresenter.setStageLayout(name, screen);
  return `Stage layout set to "${result}"`;
}

// ─── COMPANION PARITY: Clear Specific Layers ──────────────────────────

async function propresenterClearMedia(agent) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  await agent.proPresenter.clearMedia();
  return 'Media layer cleared';
}

async function propresenterClearAudio(agent) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  await agent.proPresenter.clearAudio();
  return 'Audio layer cleared';
}

// ─── COMPANION PARITY: Video Input ────────────────────────────────────

async function propresenterTriggerVideoInput(agent, params) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const name = String(params.name || '').trim();
  if (!name) throw new Error('video input name required');
  await agent.proPresenter.triggerVideoInput(name);
  return `Video input "${name}" triggered`;
}

module.exports = {
  'propresenter.next': propresenterNext,
  'propresenter.previous': propresenterPrevious,
  'propresenter.goToSlide': propresenterGoToSlide,
  'propresenter.status': propresenterStatus,
  'propresenter.playlist': propresenterPlaylist,
  'propresenter.isRunning': propresenterIsRunning,
  'propresenter.clearAll': propresenterClearAll,
  'propresenter.clearSlide': propresenterClearSlide,
  'propresenter.stageMessage': propresenterStageMessage,
  'propresenter.clearMessage': propresenterClearMessage,
  'propresenter.getLooks': propresenterGetLooks,
  'propresenter.setLook': propresenterSetLook,
  'propresenter.getTimers': propresenterGetTimers,
  'propresenter.startTimer': propresenterStartTimer,
  'propresenter.stopTimer': propresenterStopTimer,
  'propresenter.version': propresenterVersion,
  'propresenter.messages': propresenterMessages,
  'propresenter.lastSlide': propresenterLastSlide,
  'propresenter.activeLook': propresenterActiveLook,
  'propresenter.timerStatus': propresenterTimerStatus,
  'propresenter.screenStatus': propresenterScreenStatus,
  'propresenter.libraries': propresenterLibraries,
  'propresenter.audienceScreens': propresenterAudienceScreens,

  // Companion parity: presentation & playlist triggers
  'propresenter.triggerPresentation': propresenterTriggerPresentation,
  'propresenter.triggerPlaylistItem': propresenterTriggerPlaylistItem,

  // Companion parity: props
  'propresenter.getProps': propresenterGetProps,
  'propresenter.triggerProp': propresenterTriggerProp,
  'propresenter.clearProps': propresenterClearProps,

  // Companion parity: timer management
  'propresenter.resetTimer': propresenterResetTimer,
  'propresenter.createTimer': propresenterCreateTimer,

  // Companion parity: groups
  'propresenter.getGroups': propresenterGetGroups,
  'propresenter.triggerGroup': propresenterTriggerGroup,

  // Companion parity: announcements
  'propresenter.nextAnnouncement': propresenterNextAnnouncement,
  'propresenter.previousAnnouncement': propresenterPreviousAnnouncement,
  'propresenter.announcementStatus': propresenterAnnouncementStatus,

  // Companion parity: macros
  'propresenter.getMacros': propresenterGetMacros,
  'propresenter.triggerMacro': propresenterTriggerMacro,

  // Companion parity: stage layouts
  'propresenter.getStageLayouts': propresenterGetStageLayouts,
  'propresenter.setStageLayout': propresenterSetStageLayout,

  // Companion parity: clear individual layers
  'propresenter.clearMedia': propresenterClearMedia,
  'propresenter.clearAudio': propresenterClearAudio,

  // Companion parity: video input
  'propresenter.triggerVideoInput': propresenterTriggerVideoInput,
};
