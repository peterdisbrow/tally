const { toInt } = require('./helpers');

function resolveHyperDeckIndex(params = {}) {
  const raw = Number.parseInt(params.hyperdeck ?? params.index ?? 0, 10);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw - 1;
}

function getHyperDeckLabel(indexZeroBased) {
  return Number(indexZeroBased) + 1;
}

function getDirectHyperDeck(agent, indexZeroBased) {
  return Array.isArray(agent.hyperdecks) ? agent.hyperdecks[indexZeroBased] || null : null;
}

async function runHyperDeckDirectOrAtem(agent, params, options) {
  const index = resolveHyperDeckIndex(params);
  const direct = getDirectHyperDeck(agent, index);

  if (direct) {
    try {
      if (!direct.connected && typeof direct.connect === 'function') {
        await direct.connect();
      }
      if (direct.connected) {
        await options.direct(direct, index);
        if (typeof agent._updateHyperDeckStatus === 'function') agent._updateHyperDeckStatus();
        if (typeof agent.sendStatus === 'function') agent.sendStatus();
        return { mode: 'direct', index };
      }
    } catch {
      // Keep legacy ATEM fallback when direct HyperDeck is unreachable.
    }
  }

  await agent.atemCommand(() => {
    if (typeof agent.atem?.[options.atemMethod] !== 'function') {
      throw new Error('HyperDeck control is not available (configure HyperDeck IPs or use an ATEM model with HyperDeck bridge)');
    }
    return agent.atem[options.atemMethod](index);
  });
  return { mode: 'atem', index };
}

async function hyperdeckPlay(agent, params) {
  const result = await runHyperDeckDirectOrAtem(agent, params, {
    direct: (deck) => deck.play(),
    atemMethod: 'setHyperDeckPlay',
  });
  return `HyperDeck ${getHyperDeckLabel(result.index)} playing`;
}

async function hyperdeckStop(agent, params) {
  const result = await runHyperDeckDirectOrAtem(agent, params, {
    direct: (deck) => deck.stop(),
    atemMethod: 'setHyperDeckStop',
  });
  return `HyperDeck ${getHyperDeckLabel(result.index)} stopped`;
}

async function hyperdeckRecord(agent, params) {
  const result = await runHyperDeckDirectOrAtem(agent, params, {
    direct: (deck) => deck.record(),
    atemMethod: 'setHyperDeckRecord',
  });
  return `HyperDeck ${getHyperDeckLabel(result.index)} recording`;
}

async function hyperdeckStopRecord(agent, params) {
  const result = await runHyperDeckDirectOrAtem(agent, params, {
    direct: (deck) => deck.stop(),
    atemMethod: 'setHyperDeckStop',
  });
  return `HyperDeck ${getHyperDeckLabel(result.index)} recording stopped`;
}

async function hyperdeckNextClip(agent, params) {
  const result = await runHyperDeckDirectOrAtem(agent, params, {
    direct: (deck) => deck.nextClip(),
    atemMethod: 'setHyperDeckNextClip',
  });
  return `HyperDeck ${getHyperDeckLabel(result.index)} next clip`;
}

async function hyperdeckPrevClip(agent, params) {
  const result = await runHyperDeckDirectOrAtem(agent, params, {
    direct: (deck) => deck.prevClip(),
    atemMethod: 'setHyperDeckPrevClip',
  });
  return `HyperDeck ${getHyperDeckLabel(result.index)} previous clip`;
}

async function hyperdeckStatus(agent, params) {
  const index = resolveHyperDeckIndex(params);
  const direct = getDirectHyperDeck(agent, index);
  if (!direct) throw new Error(`HyperDeck ${getHyperDeckLabel(index)} not configured`);
  const status = await direct.refreshStatus();
  const label = status.name || `HyperDeck ${getHyperDeckLabel(index)}`;
  const modelInfo = [status.model, status.protocolVersion ? `v${status.protocolVersion}` : null].filter(Boolean).join(' · ');

  if (!status.connected) {
    return `🎬 ${label} — ❌ Offline\n\nHyperDeck is not responding. Check power and network connection.`;
  }

  const transportLabel = (status.transport || 'unknown').replace(/([a-z])([A-Z])/g, '$1 $2');
  const lines = [
    `🎬 ${label} — ✅ Connected`,
    modelInfo ? `📦 ${modelInfo}` : null,
    '',
    status.recording
      ? '⏺️  Recording: Active'
      : '⚫ Recording: Off',
    `🔄 Transport: ${transportLabel.charAt(0).toUpperCase() + transportLabel.slice(1)}`,
    status.clipId != null ? `🎞️  Clip: ${status.clipId}` : null,
    status.slotId != null ? `💾 Slot: ${status.slotId}` : null,
  ].filter(l => l != null);

  return lines.join('\n');
}

async function hyperdeckSelectSlot(agent, params) {
  const index = resolveHyperDeckIndex(params);
  const deck = getDirectHyperDeck(agent, index);
  if (!deck || !deck.connected) throw new Error(`HyperDeck ${getHyperDeckLabel(index)} not connected`);
  const slot = toInt(params.slot, 'slot');
  await deck._sendAndWait(`slot select: slot id: ${slot}`, [200]);
  return `HyperDeck ${getHyperDeckLabel(index)} slot ${slot} selected`;
}

async function hyperdeckSetPlaySpeed(agent, params) {
  const index = resolveHyperDeckIndex(params);
  const deck = getDirectHyperDeck(agent, index);
  if (!deck || !deck.connected) throw new Error(`HyperDeck ${getHyperDeckLabel(index)} not connected`);
  const speed = params.speed != null ? Number(params.speed) : 100;
  await deck._sendAndWait(`play: speed: ${speed}`, [200]);
  return `HyperDeck ${getHyperDeckLabel(index)} playing at ${speed}% speed`;
}

async function hyperdeckGoToClip(agent, params) {
  const index = resolveHyperDeckIndex(params);
  const deck = getDirectHyperDeck(agent, index);
  if (!deck || !deck.connected) throw new Error(`HyperDeck ${getHyperDeckLabel(index)} not connected`);
  const clipId = toInt(params.clip || params.clipId, 'clip');
  await deck._sendAndWait(`goto: clip id: ${clipId}`, [200]);
  return `HyperDeck ${getHyperDeckLabel(index)} went to clip ${clipId}`;
}

async function hyperdeckGoToTimecode(agent, params) {
  const index = resolveHyperDeckIndex(params);
  const deck = getDirectHyperDeck(agent, index);
  if (!deck || !deck.connected) throw new Error(`HyperDeck ${getHyperDeckLabel(index)} not connected`);
  const tc = String(params.timecode || '00:00:00:00').trim();
  await deck._sendAndWait(`goto: timecode: ${tc}`, [200]);
  return `HyperDeck ${getHyperDeckLabel(index)} jumped to ${tc}`;
}

async function hyperdeckJog(agent, params) {
  const index = resolveHyperDeckIndex(params);
  const deck = getDirectHyperDeck(agent, index);
  if (!deck || !deck.connected) throw new Error(`HyperDeck ${getHyperDeckLabel(index)} not connected`);
  const tc = String(params.timecode || '00:00:01:00').trim();
  await deck._sendAndWait(`jog: timecode: ${tc}`, [200]);
  return `HyperDeck ${getHyperDeckLabel(index)} jogged to ${tc}`;
}

module.exports = {
  'hyperdeck.play': hyperdeckPlay,
  'hyperdeck.stop': hyperdeckStop,
  'hyperdeck.record': hyperdeckRecord,
  'hyperdeck.stopRecord': hyperdeckStopRecord,
  'hyperdeck.nextClip': hyperdeckNextClip,
  'hyperdeck.prevClip': hyperdeckPrevClip,
  'hyperdeck.status': hyperdeckStatus,
  'hyperdeck.selectSlot': hyperdeckSelectSlot,
  'hyperdeck.setPlaySpeed': hyperdeckSetPlaySpeed,
  'hyperdeck.goToClip': hyperdeckGoToClip,
  'hyperdeck.goToTimecode': hyperdeckGoToTimecode,
  'hyperdeck.jog': hyperdeckJog,
};
