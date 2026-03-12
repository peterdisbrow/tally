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
  await agent.proPresenter.goToSlide(params.index);
  if (agent.proPresenterBackup) agent.proPresenterBackup.goToSlide(params.index).catch(() => {});
  return `Jumped to slide ${params.index}`;
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

async function propresenterAudienceScreens(agent, params) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  if (params.on === undefined && params.state === undefined) {
    throw new Error('Specify on: true/false');
  }
  const on = params.on ?? params.state ?? true;
  const result = await agent.proPresenter.setAudienceScreens(on);
  return result;
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
  // New commands
  'propresenter.activeLook': propresenterActiveLook,
  'propresenter.timerStatus': propresenterTimerStatus,
  'propresenter.screenStatus': propresenterScreenStatus,
  'propresenter.libraries': propresenterLibraries,
  'propresenter.audienceScreens': propresenterAudienceScreens,
};
