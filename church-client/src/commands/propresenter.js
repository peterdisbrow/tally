/** ProPresenter's API has no read-back for these actions: say so instead of claiming success. */
const UNCONFIRMED = ' — accepted by ProPresenter (not confirmed: ProPresenter does not report this back)';
const { toInt } = require('./helpers');

const where = (si) => (si && si.index != null ? ` — now slide ${si.index + 1}${si.name ? ` of "${si.name}"` : ''}` : '');

async function propresenterNext(agent) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const si = await agent.proPresenter.nextSlide();
  return `Next slide${where(si)}`;
}

async function propresenterPrevious(agent) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const si = await agent.proPresenter.previousSlide();
  return `Previous slide${where(si)}`;
}

async function propresenterGoToSlide(agent, params) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  // Users give 1-based slide numbers ("slide 5" = the 5th slide in PP); the API is 0-based.
  const userSlide = Number(params.index ?? params.slide);
  if (!Number.isInteger(userSlide) || userSlide < 1) throw new Error(`Invalid slide "${params.index ?? params.slide ?? ''}" (1 = first slide)`);
  const si = await agent.proPresenter.goToSlide(userSlide - 1);
  return `Jumped to slide ${userSlide}${si?.name ? ` of "${si.name}"` : ''}`;
}

async function propresenterStatus(agent) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const pp = agent.proPresenter;
  const slide = pp.connected ? await pp.getCurrentSlide() : null;

  if (!slide) {
    return '📺 ProPresenter — ❌ Offline\n\nProPresenter is not responding. Check that it is running.';
  }

  const lines = ['📺 ProPresenter — ✅ Running', ''];
  if (slide.onScreen === false || slide.slideIndex == null) {
    lines.push('🎬 Nothing on screen (slide layer clear)');
  } else {
    lines.push(`🎬 Presentation: ${slide.presentationName || 'Untitled'}`);
    lines.push(`📄 Slide: ${slide.slideIndex + 1}${slide.slideTotal ? ` of ${slide.slideTotal}` : ''}`);
  }

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
    lines.push(`📺 Audience Screen: ${pp._screenStatus.audience == null ? 'unknown' : pp._screenStatus.audience ? 'ON' : 'OFF'}`);
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
    lines.push(`🔄 Backup PP: ${pp._backup.connected ? '✅ Connected' : '❌ Disconnected'}${pp.lastMirror && !pp.lastMirror.ok ? ` — last command did not reach it (${pp.lastMirror.error})` : ''}`);
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
  return running ? '📺 ProPresenter — ✅ Running' : '📺 ProPresenter — ❌ Not reachable (no ProPresenter answer on its API port)';
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
  const name = await agent.proPresenter.triggerMessage(params.name, params.tokens || []);
  return `Message "${name}" showing`;
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
  if (!screens) throw new Error('ProPresenter did not report its screen state (not reachable?)');
  const f = (v) => (v == null ? 'unknown' : v ? 'ON' : 'OFF');
  return `📺 Audience: ${f(screens.audience)}\n🖥️ Stage: ${f(screens.stage)}`;
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
  if (!slide || !slide.slideTotal) throw new Error('Could not determine slide count from ProPresenter (nothing on screen, or not reachable)');
  await agent.proPresenter.goToSlide(slide.slideTotal - 1);
  return `Jumped to last slide (slide ${slide.slideTotal})`;
}

async function propresenterAudienceScreens(agent, params) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  if (params.on === undefined && params.state === undefined) {
    throw new Error('Specify on: true/false');
  }
  const raw = params.on ?? params.state;
  const on = raw === true || raw === 'true' || raw === 'on' || raw === 1 || raw === '1' ? true
    : raw === false || raw === 'false' || raw === 'off' || raw === 0 || raw === '0' ? false : null;
  if (on === null) throw new Error(`Invalid value "${raw}" (on or off)`);
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
  return `Timer "${name}" reset` + UNCONFIRMED;
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
  return 'Next announcement slide' + UNCONFIRMED;
}

async function propresenterPreviousAnnouncement(agent) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  await agent.proPresenter.previousAnnouncement();
  return 'Previous announcement slide' + UNCONFIRMED;
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
  return `Macro "${result}" accepted by ProPresenter (macros have no readable state — check the screen)`;
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
  await agent.proPresenter.triggerVideoInput(name);  // throws unless PP reports the video input layer active
  return `Video input "${name}" triggered`;
}

// ─── COMPANION PARITY: Audio Playlists ────────────────────────────────

async function propresenterGetAudioPlaylists(agent) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const playlists = await agent.proPresenter.getAudioPlaylists();
  if (!playlists.length) return 'No audio playlists found';
  return playlists.map(p => p.name).join('\n');
}

async function propresenterActiveAudioPlaylistTrigger(agent, params) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const action = String(params.action || 'next').trim();
  await agent.proPresenter.activeAudioPlaylistTrigger(action);
  return `Active audio playlist: ${action}` + UNCONFIRMED;
}

async function propresenterFocusedAudioPlaylistTrigger(agent, params) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const action = String(params.action || 'next').trim();
  await agent.proPresenter.focusedAudioPlaylistTrigger(action);
  return `Focused audio playlist: ${action}` + UNCONFIRMED;
}

async function propresenterAudioPlaylistFocus(agent, params) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const name = String(params.name || params.id || '').trim();
  if (!name) throw new Error('playlist name or ID required');
  const result = await agent.proPresenter.audioPlaylistFocus(name);
  return `Audio playlist "${result}" focused` + UNCONFIRMED;
}

async function propresenterAudioPlaylistTrigger(agent, params) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const name = String(params.name || params.id || '').trim();
  if (!name) throw new Error('playlist name or ID required');
  const result = await agent.proPresenter.audioPlaylistTrigger(name);
  return `Audio playlist "${result}" triggered` + UNCONFIRMED;
}

// ─── COMPANION PARITY: Media Playlists ────────────────────────────────

async function propresenterGetMediaPlaylists(agent) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const playlists = await agent.proPresenter.getMediaPlaylists();
  if (!playlists.length) return 'No media playlists found';
  return playlists.map(p => p.name).join('\n');
}

async function propresenterActiveMediaPlaylistTrigger(agent, params) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const action = String(params.action || 'next').trim();
  await agent.proPresenter.activeMediaPlaylistTrigger(action);
  return `Active media playlist: ${action}` + UNCONFIRMED;
}

async function propresenterFocusedMediaPlaylistTrigger(agent, params) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const action = String(params.action || 'next').trim();
  await agent.proPresenter.focusedMediaPlaylistTrigger(action);
  return `Focused media playlist: ${action}` + UNCONFIRMED;
}

async function propresenterMediaPlaylistFocus(agent, params) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const name = String(params.name || params.id || '').trim();
  if (!name) throw new Error('playlist name or ID required');
  const result = await agent.proPresenter.mediaPlaylistFocus(name);
  return `Media playlist "${result}" focused` + UNCONFIRMED;
}

async function propresenterMediaPlaylistTrigger(agent, params) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const name = String(params.name || params.id || '').trim();
  if (!name) throw new Error('playlist name or ID required');
  const result = await agent.proPresenter.mediaPlaylistTrigger(name);
  return `Media playlist "${result}" triggered` + UNCONFIRMED;
}

// ─── COMPANION PARITY: Transport Layer Control ────────────────────────

async function propresenterTransportPlay(agent, params) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const layer = String(params.layer || 'presentation').trim();
  await agent.proPresenter.transportPlay(layer);
  return `Transport play (${layer})`;
}

async function propresenterTransportPause(agent, params) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const layer = String(params.layer || 'presentation').trim();
  await agent.proPresenter.transportPause(layer);
  return `Transport paused (${layer})`;
}

async function propresenterTransportSkipForward(agent, params) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const layer = String(params.layer || 'presentation').trim();
  const seconds = toInt(params.seconds || 10, 'seconds');
  await agent.proPresenter.transportSkipForward(layer, seconds);
  return `Transport skip forward ${seconds}s (${layer})` + UNCONFIRMED;
}

async function propresenterTransportSkipBackward(agent, params) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const layer = String(params.layer || 'presentation').trim();
  const seconds = toInt(params.seconds || 10, 'seconds');
  await agent.proPresenter.transportSkipBackward(layer, seconds);
  return `Transport skip backward ${seconds}s (${layer})` + UNCONFIRMED;
}

async function propresenterTransportGoToTime(agent, params) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const layer = String(params.layer || 'presentation').trim();
  const time = params.time || 0;
  await agent.proPresenter.transportGoToTime(layer, time);
  return `Transport go to time ${time} (${layer})`;
}

async function propresenterTransportGoToEnd(agent, params) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const layer = String(params.layer || 'presentation').trim();
  await agent.proPresenter.transportGoToEnd(layer);
  return `Transport go to end (${layer})` + UNCONFIRMED;
}

// ─── COMPANION PARITY: Timeline ───────────────────────────────────────

async function propresenterTimelinePlay(agent) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  await agent.proPresenter.timelinePlay();
  return 'Timeline playing' + UNCONFIRMED;
}

async function propresenterTimelinePause(agent) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  await agent.proPresenter.timelinePause();
  return 'Timeline paused' + UNCONFIRMED;
}

async function propresenterTimelineRewind(agent) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  await agent.proPresenter.timelineRewind();
  return 'Timeline rewound' + UNCONFIRMED;
}

// ─── COMPANION PARITY: Capture ────────────────────────────────────────

async function propresenterCaptureStart(agent) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  await agent.proPresenter.captureStart();
  return 'Capture started';
}

async function propresenterCaptureStop(agent) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  await agent.proPresenter.captureStop();
  return 'Capture stopped';
}

// ─── COMPANION PARITY: Timer Enhancements ─────────────────────────────

async function propresenterIncrementTimer(agent, params) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  if (!params.name) throw new Error('Timer name required');
  const seconds = toInt(params.seconds || 30, 'seconds');
  const name = await agent.proPresenter.incrementTimer(params.name, seconds);
  return `Timer "${name}" incremented by ${seconds}s` + UNCONFIRMED;
}

async function propresenterSetTimerValue(agent, params) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  if (!params.name) throw new Error('Timer name required');
  const name = await agent.proPresenter.setTimerValue(params.name, {
    type: params.type || null,
    duration: params.duration || null,
    overrun: params.overrun,
    name: params.newName || null,
  });
  return `Timer "${name}" updated` + UNCONFIRMED;
}

// ─── COMPANION PARITY: Toggles ───────────────────────────────────────

async function propresenterToggleProp(agent, params) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const name = String(params.name || '').trim();
  if (!name) throw new Error('prop name required');
  const result = await agent.proPresenter.toggleProp(name);
  return `Prop "${result}" toggled`;
}

async function propresenterToggleStageMessage(agent, params) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const name = String(params.name || '').trim();
  if (!name) throw new Error('message name required');
  return agent.proPresenter.toggleStageMessage(name);
}

async function propresenterToggleAudienceScreens(agent) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const result = await agent.proPresenter.toggleAudienceScreens();
  return result;
}

async function propresenterToggleStageScreens(agent) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const result = await agent.proPresenter.toggleStageScreens();
  return result;
}

// ─── COMPANION PARITY: Library Cue Trigger ────────────────────────────

async function propresenterTriggerLibraryCue(agent, params) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const libraryId = String(params.libraryId || '').trim();
  const presentationId = String(params.presentationId || '').trim();
  if (!libraryId) throw new Error('libraryId required');
  if (!presentationId) throw new Error('presentationId required');
  const cueIndex = toInt(params.cueIndex || 0, 'cueIndex');
  await agent.proPresenter.triggerLibraryCue(libraryId, presentationId, cueIndex);
  return `Library cue triggered (library: ${libraryId}, presentation: ${presentationId}, cue: ${cueIndex})`;
}

// ─── COMPANION PARITY: Clear Announcements ────────────────────────────

async function propresenterClearAnnouncements(agent) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  await agent.proPresenter.clearAnnouncements();
  return 'Announcements cleared';
}

const handlers = {
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

  // Companion parity: audio playlists
  'propresenter.getAudioPlaylists': propresenterGetAudioPlaylists,
  'propresenter.activeAudioPlaylistTrigger': propresenterActiveAudioPlaylistTrigger,
  'propresenter.focusedAudioPlaylistTrigger': propresenterFocusedAudioPlaylistTrigger,
  'propresenter.audioPlaylistFocus': propresenterAudioPlaylistFocus,
  'propresenter.audioPlaylistTrigger': propresenterAudioPlaylistTrigger,

  // Companion parity: media playlists
  'propresenter.getMediaPlaylists': propresenterGetMediaPlaylists,
  'propresenter.activeMediaPlaylistTrigger': propresenterActiveMediaPlaylistTrigger,
  'propresenter.focusedMediaPlaylistTrigger': propresenterFocusedMediaPlaylistTrigger,
  'propresenter.mediaPlaylistFocus': propresenterMediaPlaylistFocus,
  'propresenter.mediaPlaylistTrigger': propresenterMediaPlaylistTrigger,

  // Companion parity: transport layer control
  'propresenter.transportPlay': propresenterTransportPlay,
  'propresenter.transportPause': propresenterTransportPause,
  'propresenter.transportSkipForward': propresenterTransportSkipForward,
  'propresenter.transportSkipBackward': propresenterTransportSkipBackward,
  'propresenter.transportGoToTime': propresenterTransportGoToTime,
  'propresenter.transportGoToEnd': propresenterTransportGoToEnd,

  // Companion parity: timeline
  'propresenter.timelinePlay': propresenterTimelinePlay,
  'propresenter.timelinePause': propresenterTimelinePause,
  'propresenter.timelineRewind': propresenterTimelineRewind,

  // Companion parity: capture
  'propresenter.captureStart': propresenterCaptureStart,
  'propresenter.captureStop': propresenterCaptureStop,

  // Companion parity: timer enhancements
  'propresenter.incrementTimer': propresenterIncrementTimer,
  'propresenter.setTimerValue': propresenterSetTimerValue,

  // Companion parity: toggles
  'propresenter.toggleProp': propresenterToggleProp,
  'propresenter.toggleStageMessage': propresenterToggleStageMessage,
  'propresenter.toggleAudienceScreens': propresenterToggleAudienceScreens,
  'propresenter.toggleStageScreens': propresenterToggleStageScreens,

  // Companion parity: library cue trigger
  'propresenter.triggerLibraryCue': propresenterTriggerLibraryCue,

  // Companion parity: clear announcements
  'propresenter.clearAnnouncements': propresenterClearAnnouncements,
};

// Every command: when a backup ProPresenter is configured, say whether it followed.
function withBackupNote(fn) {
  return async (agent, params = {}) => {
    const pp = agent?.proPresenter;
    if (pp) pp.lastMirror = null;
    const result = await fn(agent, params);
    if (pp && pp._backup && pp.lastMirror && !pp.lastMirror.ok && typeof result === 'string') {
      return `${result}\n⚠️ Backup ProPresenter did not follow: ${pp.lastMirror.error}`;
    }
    return result;
  };
}

module.exports = Object.fromEntries(Object.entries(handlers).map(([k, fn]) => [k, withBackupNote(fn)]));
