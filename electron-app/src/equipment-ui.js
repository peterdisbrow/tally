/**
 * Equipment UI — Unified rendering engine for the equipment tab.
 * Depends on device-registry.js (loaded first) and renderer.js helpers.
 */

/* eslint-disable no-unused-vars */
/* globals DEVICE_REGISTRY, DEVICE_CATEGORIES, ENCODER_OPTIONS, ENCODER_API_TYPES,
   ENCODER_RTMP_TYPES, ENCODER_DEFAULTS, SCAN_TO_DEVICE, ENCODER_DISPLAY_NAMES,
   escapeHtml, setEquipDot, api */

// ─── STATE ──────────────────────────────────────────────────────────────────

const deviceState = {
  atem:          { ip: '' },
  companion:     { host: '', port: '8888' },
  encoder:       [],  // [{ encoderType, host, port, password, label, statusUrl, source }]
  propresenter:  { host: '', port: '1025', configured: false },
  vmix:          { host: '', port: '8088', configured: false },
  resolume:      { host: '', port: '8080', configured: false },
  mixer:         { type: '', host: '', port: '' },
  'atem-recording': { autoRecord: false },
  hyperdeck:     [],  // [{ ip }]
  ptz:           [],  // [{ ip, name, protocol, port, username, password, profileToken }]
  videohub:      [],  // [{ ip, name }]
};

const expandedDevices = new Set();

/**
 * Reset all in-memory device state to defaults.
 * Called on factory reset, sign-out, and room switch to prevent stale data.
 */
function resetDeviceState() {
  deviceState.atem = { ip: '' };
  deviceState.companion = { host: '', port: '8888' };
  deviceState.encoder = [];
  deviceState.propresenter = { host: '', port: '1025', configured: false };
  deviceState.vmix = { host: '', port: '8088', configured: false };
  deviceState.resolume = { host: '', port: '8080', configured: false };
  deviceState.mixer = { type: '', host: '', port: '' };
  deviceState['atem-recording'] = { autoRecord: false };
  deviceState.hyperdeck = [];
  deviceState.ptz = [];
  deviceState.videohub = [];
  expandedDevices.clear();
  window._encoderConfig = { _type: '' };
}

// ─── ACTIVE DEVICES SUMMARY ─────────────────────────────────────────────────

function renderActiveSummary() {
  const container = document.getElementById('equip-active-summary');
  if (!container) return;

  const chips = [];

  const addChip = (deviceId, label, subLabel) => {
    chips.push(`<div class="equip-chip" onclick="scrollToDevice('${deviceId}')">
      <span class="equip-chip-dot" id="chip-dot-${deviceId}"></span>
      <span class="equip-chip-icon">${DEVICE_REGISTRY[deviceId]?.icon || ''}</span>
      <span class="equip-chip-name">${escapeHtml(label)}</span>
      ${subLabel ? `<span class="equip-chip-ip">${escapeHtml(subLabel)}</span>` : ''}
    </div>`);
  };

  if (deviceState.atem.ip) addChip('atem', 'ATEM', deviceState.atem.ip);
  deviceState.encoder.forEach((enc, i) => {
    if (enc.encoderType) {
      const encName = ENCODER_DISPLAY_NAMES[enc.encoderType] || 'Encoder';
      addChip('encoder', encName + (deviceState.encoder.length > 1 ? ` ${i + 1}` : ''), enc.host || '');
    }
  });
  if (deviceState.companion.host) addChip('companion', 'Companion', `${deviceState.companion.host}:${deviceState.companion.port || '8888'}`);
  deviceState.hyperdeck.forEach((h, i) => { if (h.ip) addChip('hyperdeck', `HD${i + 1}`, h.ip); });
  deviceState.ptz.forEach((c, i) => { if (c.ip) addChip('ptz', c.name || `PTZ${i + 1}`, c.ip); });
  if (deviceState.propresenter.configured) addChip('propresenter', 'ProPres', deviceState.propresenter.host || 'localhost');
  if (deviceState.vmix.configured) addChip('vmix', 'vMix', deviceState.vmix.host || 'localhost');
  if (deviceState.resolume.configured) addChip('resolume', 'Resolume', deviceState.resolume.host || 'localhost');
  deviceState.videohub.forEach((h, i) => { if (h.ip) addChip('videohub', h.name || `VHub${i + 1}`, h.ip); });
  if (deviceState.mixer.type) addChip('mixer', 'Mixer', deviceState.mixer.host || '');

  container.innerHTML = chips.length ? chips.join('') : '';
}

// ─── DEVICE CATALOG ─────────────────────────────────────────────────────────

function renderDeviceCatalog() {
  syncDomToState(); // capture any pending input changes before re-render
  const container = document.getElementById('equip-catalog');
  if (!container) return;

  let html = '';

  for (const cat of DEVICE_CATEGORIES) {
    const devices = Object.values(DEVICE_REGISTRY).filter(d => d.category === cat.id);
    if (!devices.length) continue;

    html += `<div class="equip-catalog-category">`;
    html += `<div class="equip-catalog-category-title">${escapeHtml(cat.name)}</div>`;

    for (const def of devices) {
      if (expandedDevices.has(def.id)) {
        // Render expanded config card(s)
        if (def.multi) {
          const entries = deviceState[def.id] || [];
          entries.forEach((_, idx) => {
            html += renderDeviceCard(def.id, idx);
          });
          if (entries.length < (def.maxInstances || 99)) {
            html += `<button class="btn-add" onclick="addDeviceInstance('${def.id}')">+ Add ${def.name}</button>`;
          }
        } else {
          html += renderDeviceCard(def.id);
        }
      } else {
        // Render collapsed catalog entry
        const isConfigured = _isDeviceConfigured(def.id);
        html += `<div class="equip-catalog-entry${isConfigured ? ' configured' : ''}" onclick="expandDeviceCard('${def.id}')">
          <span class="equip-catalog-entry-icon">${def.icon}</span>
          <div class="equip-catalog-entry-info">
            <div class="equip-catalog-entry-name">${escapeHtml(def.name)}</div>
            <div class="equip-catalog-entry-desc">${escapeHtml(def.description || '')}</div>
          </div>
          ${isConfigured ? '<span class="equip-catalog-entry-badge">Configured</span>' : ''}
          <button class="btn-add" onclick="event.stopPropagation(); expandDeviceCard('${def.id}')">Configure</button>
        </div>`;
      }
    }
    html += `</div>`;
  }

  container.innerHTML = html;
}

// ─── UNIFIED DEVICE CARD ────────────────────────────────────────────────────

function renderDeviceCard(deviceId, instanceIndex) {
  const def = DEVICE_REGISTRY[deviceId];
  if (!def) return '';

  const isMulti = def.multi && instanceIndex !== undefined;
  const state = isMulti ? (deviceState[deviceId][instanceIndex] || {}) : deviceState[deviceId];
  const cardId = isMulti ? `card-${deviceId}-${instanceIndex}` : `card-${deviceId}`;
  const dotId = isMulti ? `equip-dot-${deviceId}-${instanceIndex}` : `equip-dot-${deviceId}`;
  const detailId = isMulti ? `equip-${deviceId}-detail-${instanceIndex}` : `equip-${deviceId}-detail`;

  let instanceLabel;
  if (!isMulti) {
    instanceLabel = def.name;
  } else if (deviceId === 'encoder' && state.encoderType) {
    const encDisplayName = ENCODER_DISPLAY_NAMES[state.encoderType] || def.name;
    instanceLabel = `${encDisplayName}${state.label ? ' \u2014 ' + state.label : ''}`;
  } else {
    instanceLabel = `${def.name} ${instanceIndex + 1}${state.name ? ' \u2014 ' + state.name : ''}`;
  }

  const removeAction = isMulti
    ? `removeDeviceInstance('${deviceId}', ${instanceIndex})`
    : `collapseDeviceCard('${deviceId}')`;

  // Build fields HTML
  let fieldsHtml = '';
  const isAtemAudioType = deviceId === 'mixer'
    && (state.type === 'atem-direct' || state.type === 'atem-auto' || state.type === 'atem-none');

  if (def.subtype && deviceId === 'encoder') {
    fieldsHtml += renderEncoderCard(state, instanceIndex);
  } else {
    fieldsHtml += '<div class="equip-row">';
    for (const field of def.fields) {
      const val = state[field.key] || '';
      const dataAttrs = `data-field="${field.key}" data-device="${deviceId}"${isMulti ? ` data-idx="${instanceIndex}"` : ''}`;

      if (field.type === 'select') {
        const opts = (field.options || []).map(o =>
          `<option value="${escapeHtml(o.value)}"${val === o.value ? ' selected' : ''}>${escapeHtml(o.label)}</option>`
        ).join('');
        const onchangeAttr = (deviceId === 'mixer' && field.key === 'type') ? ' onchange="onMixerTypeChanged()"' : '';
        fieldsHtml += `<select ${dataAttrs}${onchangeAttr} style="${field.style || 'flex:1'}">${opts}</select>`;
      } else if (field.type === 'checkbox') {
        fieldsHtml += `<label style="display:flex; align-items:center; gap:6px; font-size:12px; color:var(--white); cursor:pointer; flex:1;">
          <input type="checkbox" ${dataAttrs}${val ? ' checked' : ''} style="margin:0;">
          ${escapeHtml(field.label)}
        </label>`;
      } else {
        // Hide mixer IP/port fields when type is an ATEM audio option
        const hideMixerField = deviceId === 'mixer' && (field.key === 'host' || field.key === 'port') && isAtemAudioType;
        fieldsHtml += `<input type="${field.type}" ${dataAttrs} value="${escapeHtml(val)}" placeholder="${field.placeholder || ''}" style="${field.style || ''}${hideMixerField ? ';display:none' : ''}">`;
      }
    }
    // Test button (hide for atem-direct mixer)
    if (def.testType && !(deviceId === 'mixer' && isAtemAudioType)) {
      const testAction = isMulti
        ? `testEquipIdx('${deviceId}', ${instanceIndex})`
        : `testEquip('${deviceId}')`;
      fieldsHtml += `<button class="btn-test" onclick="${testAction}">Test</button>`;
    }
    fieldsHtml += '</div>';
  }

  let detailHint = def.detailHint || def.description || '';
  if (deviceId === 'mixer' && state.type === 'atem-auto') {
    detailHint = 'Tally will auto-detect active audio inputs on the ATEM (XLR, RCA, etc.). If direct audio inputs are found, audio status will show OK automatically.';
  } else if (deviceId === 'mixer' && state.type === 'atem-direct') {
    detailHint = 'Audio via ATEM is forced ON \u2014 auto-detection is overridden. Use this if auto-detect doesn\u2019t pick up your setup.';
  } else if (deviceId === 'mixer' && state.type === 'atem-none') {
    detailHint = 'Audio via ATEM is forced OFF \u2014 auto-detection is overridden. Audio status will show \u201C\u2014\u201D unless an external mixer is connected.';
  }

  return `<div class="equip-card" id="${cardId}">
    <div class="equip-card-header">
      <span class="equip-card-header-icon">${def.icon}</span>
      <span class="equip-card-header-name">${escapeHtml(instanceLabel)}</span>
      <div class="equip-status" id="${dotId}"></div>
      <button class="btn-remove" onclick="${removeAction}">Remove</button>
    </div>
    <div class="equip-card-body">
      ${fieldsHtml}
      <div class="equip-detail" id="${detailId}">${detailHint}</div>
    </div>
  </div>`;
}

// ─── ENCODER CARD (special — has type dropdown + conditional fields) ────────

function renderEncoderCard(state, idx) {
  const encType = state.encoderType || '';
  const idxAttr = idx !== undefined ? ` data-idx="${idx}"` : '';
  const optsHtml = ENCODER_OPTIONS.map(o =>
    `<option value="${o.value}"${encType === o.value ? ' selected' : ''}>${escapeHtml(o.label)}</option>`
  ).join('');

  let html = `<div class="equip-row">
    <select data-field="encoderType" data-device="encoder"${idxAttr} onchange="onEncoderTypeChanged(${idx !== undefined ? idx : ''})" style="flex:1">${optsHtml}</select>
  </div>`;

  html += `<div id="encoder-config-fields-${idx !== undefined ? idx : 0}">${renderEncoderSubfields(encType, state, idx)}</div>`;

  return html;
}

function renderEncoderSubfields(type, saved, idx) {
  saved = saved || {};
  const idxAttr = idx !== undefined ? ` data-idx="${idx}"` : '';
  const testAction = idx !== undefined ? `testEquipIdx('encoder',${idx})` : `testEquip('encoder')`;

  if (!type) {
    return '<div class="equip-detail">No encoder selected. Select a type above to configure.</div>';
  }

  if (type === 'atem-streaming') {
    return `<div class="equip-detail" style="margin-top:8px;">
      The ATEM Mini handles streaming directly through its built-in encoder.<br>
      Stream status is monitored via the ATEM connection \u2014 no separate encoder configuration needed.
    </div>`;
  }

  if (type === 'ecamm') {
    return `<div class="equip-detail" style="margin-top:8px;">
      Ecamm Live runs locally on Mac. Uses HTTP remote control API (port auto-detected via Bonjour, fallback 65194).
    </div>
    <div class="equip-row" style="margin-top:4px;">
      <button class="btn-test" onclick="${testAction}">Test Connection</button>
    </div>`;
  }

  if (ENCODER_API_TYPES.includes(type)) {
    const d = ENCODER_DEFAULTS[type] || { host: '', port: '' };
    const useSaved = (saved.encoderType || saved._type || '') === type;
    const h = useSaved ? (saved.host || d.host) : d.host;
    const p = useSaved ? (saved.port || d.port) : d.port;

    let html = '';
    if (d.note) html += `<div class="equip-detail" style="margin-top:6px; font-size:10px; color:var(--dim);">${d.note}</div>`;
    html += `<div class="equip-row" style="margin-top:6px;">
      <input type="text" data-field="host" data-device="encoder"${idxAttr} placeholder="${d.host || 'IP address'}" value="${escapeHtml(h)}">
      <input type="text" data-field="port" data-device="encoder"${idxAttr} placeholder="${d.port}" value="${escapeHtml(p)}" style="max-width:80px;">
      <button class="btn-test" onclick="${testAction}">Test</button>
    </div>`;
    if (d.pw) {
      html += `<div class="equip-row" style="margin-top:4px;">
        <input type="password" data-field="password" data-device="encoder"${idxAttr} placeholder="Password (optional)" value="${escapeHtml(saved.password || '')}">
      </div>`;
    }
    if (d.statusUrl) {
      html += `<div class="equip-row" style="margin-top:4px;">
        <input type="text" data-field="statusUrl" data-device="encoder"${idxAttr} placeholder="Status endpoint path (e.g. /status)" value="${escapeHtml(saved.statusUrl || '/status')}">
      </div>
      <div class="equip-row" style="margin-top:4px;">
        <input type="text" data-field="label" data-device="encoder"${idxAttr} placeholder="Device label (optional)" value="${escapeHtml(saved.label || '')}">
      </div>`;
    } else if (d.source) {
      html += `<div class="equip-row" style="margin-top:4px;">
        <input type="text" data-field="source" data-device="encoder"${idxAttr} placeholder="NDI source name (optional)" value="${escapeHtml(saved.source || '')}">
      </div>
      <div class="equip-row" style="margin-top:4px;">
        <input type="text" data-field="label" data-device="encoder"${idxAttr} placeholder="Device label (optional)" value="${escapeHtml(saved.label || '')}">
      </div>`;
    }
    return html;
  }

  if (ENCODER_RTMP_TYPES.includes(type) || type === 'yolobox') {
    const h = saved.host || '';
    const p = saved.port || '80';
    return `<div class="equip-detail" style="margin-top:8px; padding:10px; background:var(--card); border:1px solid var(--border); border-radius:6px;">
      This device streams directly to your CDN (YouTube, Facebook, etc.).<br>
      <span style="font-size:10px; color:var(--dim);">No public control API. Optional host/port enables network reachability checks.</span>
    </div>
    <div class="equip-row" style="margin-top:6px;">
      <input type="text" data-field="host" data-device="encoder"${idxAttr} placeholder="Device IP (optional)" value="${escapeHtml(h)}">
      <input type="text" data-field="port" data-device="encoder"${idxAttr} placeholder="80" value="${escapeHtml(p)}" style="max-width:80px;">
      <button class="btn-test" onclick="${testAction}">Test</button>
    </div>
    <div class="equip-row" style="margin-top:4px;">
      <input type="text" data-field="label" data-device="encoder"${idxAttr} placeholder="Device label (optional)" value="${escapeHtml(saved.label || '')}">
    </div>`;
  }

  return '';
}

/** Called when encoder type dropdown changes — re-render that instance's conditional fields */
function onEncoderTypeChanged(idx) {
  syncDomToState();
  if (idx === undefined) idx = 0;
  const enc = deviceState.encoder[idx] || {};
  const type = enc.encoderType;
  const container = document.getElementById(`encoder-config-fields-${idx}`);
  const detailEl = document.getElementById(`equip-encoder-detail-${idx}`);
  if (container) container.innerHTML = renderEncoderSubfields(type, enc, idx);
  if (detailEl) detailEl.textContent = '';
}

function onMixerTypeChanged() {
  syncDomToState();
  // Re-render the mixer card so IP/port fields and detail hint update
  renderDeviceCatalog();
  renderActiveSummary();
}

// ─── EXPAND / COLLAPSE / ADD / REMOVE ───────────────────────────────────────

function expandDeviceCard(deviceId) {
  syncDomToState();
  expandedDevices.add(deviceId);
  const def = DEVICE_REGISTRY[deviceId];
  // For multi-instance devices, add first entry if empty
  if (def?.multi && (!deviceState[deviceId] || deviceState[deviceId].length === 0)) {
    addDeviceInstance(deviceId, true); // silent — don't re-render, we'll render below
  }
  // For optional single devices, mark configured
  if (!def?.multi && deviceState[deviceId] && 'configured' in deviceState[deviceId]) {
    deviceState[deviceId].configured = true;
  }
  renderDeviceCatalog();
  renderActiveSummary();
  // Scroll to the card
  setTimeout(() => scrollToDevice(deviceId), 50);
}

async function collapseDeviceCard(deviceId) {
  const def = DEVICE_REGISTRY[deviceId];
  const label = def?.name || deviceId;
  if (typeof asyncConfirm === 'function') {
    if (!(await asyncConfirm(`Remove ${label} from your equipment?`))) return;
  }
  syncDomToState();
  expandedDevices.delete(deviceId);
  // For optional single devices, mark unconfigured and clear fields
  if (!def?.multi && deviceState[deviceId] && 'configured' in deviceState[deviceId]) {
    deviceState[deviceId].configured = false;
    // Clear the field values
    for (const field of (def.fields || [])) {
      if (field.key in deviceState[deviceId]) {
        deviceState[deviceId][field.key] = (field.key === 'port') ? (field.placeholder || '') : '';
      }
    }
  }
  renderDeviceCatalog();
  renderActiveSummary();
}

function addDeviceInstance(deviceId, silent) {
  if (!silent) syncDomToState();
  const def = DEVICE_REGISTRY[deviceId];
  if (!def?.multi) return;
  if (!deviceState[deviceId]) deviceState[deviceId] = [];
  if (deviceState[deviceId].length >= (def.maxInstances || 99)) return;

  // Create empty entry from field definitions
  let entry = {};
  if (deviceId === 'encoder') {
    // Encoder has dynamic fields per subtype — create with all possible keys
    entry = { encoderType: '', host: '', port: '', password: '', label: '', statusUrl: '', source: '' };
  } else {
    for (const field of def.fields) {
      entry[field.key] = '';
    }
    // PTZ needs profileToken
    if (deviceId === 'ptz') entry.profileToken = '';
  }
  deviceState[deviceId].push(entry);

  if (!silent) {
    renderDeviceCatalog();
    renderActiveSummary();
  }
}

async function removeDeviceInstance(deviceId, idx) {
  const def = DEVICE_REGISTRY[deviceId];
  const entries = deviceState[deviceId];
  const entry = Array.isArray(entries) ? entries[idx] : null;
  const label = (entry?.name) || (entry?.label) || (def?.name ? `${def.name} ${idx + 1}` : `device #${idx + 1}`);
  if (typeof asyncConfirm === 'function') {
    if (!(await asyncConfirm(`Remove ${label}? You can add it back later.`))) return;
  }
  syncDomToState();
  if (deviceState[deviceId] && Array.isArray(deviceState[deviceId])) {
    deviceState[deviceId].splice(idx, 1);
    if (deviceState[deviceId].length === 0) {
      expandedDevices.delete(deviceId);
    }
  }
  renderDeviceCatalog();
  renderActiveSummary();
}

function scrollToDevice(deviceId) {
  // Try card first, then catalog entry
  const el = document.getElementById(`card-${deviceId}`) || document.getElementById(`card-${deviceId}-0`);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    el.style.transition = 'box-shadow 0.3s';
    el.style.boxShadow = '0 0 15px rgba(34,197,94,0.4)';
    setTimeout(() => { el.style.boxShadow = ''; }, 1200);
  }
}

// ─── DOM → STATE SYNC ───────────────────────────────────────────────────────

function syncDomToState() {
  const inputs = document.querySelectorAll('#equip-catalog [data-field][data-device]');
  for (const el of inputs) {
    const deviceId = el.dataset.device;
    const fieldKey = el.dataset.field;
    const idx = el.dataset.idx;
    const val = el.type === 'checkbox' ? el.checked : el.value;

    if (idx !== undefined && idx !== '') {
      // Multi-instance
      const i = parseInt(idx);
      if (deviceState[deviceId] && deviceState[deviceId][i]) {
        deviceState[deviceId][i][fieldKey] = val;
      }
    } else {
      // Single-instance
      if (deviceState[deviceId]) {
        deviceState[deviceId][fieldKey] = val;
      }
    }
  }
}

// ─── HELPERS ────────────────────────────────────────────────────────────────

function _isDeviceConfigured(deviceId) {
  const state = deviceState[deviceId];
  if (!state) return false;
  const def = DEVICE_REGISTRY[deviceId];
  if (def?.multi) {
    if (!Array.isArray(state)) return false;
    if (deviceId === 'encoder') return state.some(e => e.encoderType);
    return state.some(entry => {
      const firstField = def.fields[0];
      return firstField && entry[firstField.key];
    });
  }
  if ('configured' in state) return state.configured;
  // Check if any field has a value
  return def?.fields?.some(f => state[f.key]) || false;
}

function closeScanPanel() {
  const panel = document.getElementById('equip-scan-panel');
  if (panel) panel.style.display = 'none';
}

// ─── SCAN INTEGRATION ───────────────────────────────────────────────────────

function addFromScan(scanType, data) {
  const deviceId = SCAN_TO_DEVICE[scanType];
  if (!deviceId) return;

  const def = DEVICE_REGISTRY[deviceId];
  if (!def) return;

  if (deviceId === 'encoder') {
    // Map scan type to encoder subtype — push new instance
    if (!deviceState.encoder) deviceState.encoder = [];
    if (deviceState.encoder.length >= (def.maxInstances || 4)) return;
    const typeMap = { obs: 'obs', tricaster: 'tricaster', birddog: 'birddog', blackmagic: 'blackmagic', 'tally-encoder': 'tally-encoder' };
    // Encoder entries from 'encoders' scan key carry their subtype in data.type
    const encoderType = typeMap[scanType] || (data.type && typeMap[data.type]) || '';
    const entry = { encoderType, host: data.ip || '', port: data.port ? String(data.port) : '', password: '', label: '', statusUrl: '', source: '' };
    deviceState.encoder.push(entry);
  } else if (def.multi) {
    // Add new instance (non-encoder multi devices)
    if (!deviceState[deviceId]) deviceState[deviceId] = [];
    if (deviceState[deviceId].length >= (def.maxInstances || 99)) return;
    const entry = {};
    for (const field of def.fields) entry[field.key] = '';
    if (deviceId === 'ptz') entry.profileToken = '';
    entry.ip = data.ip || '';
    if (data.name) entry.name = data.name;
    deviceState[deviceId].push(entry);
  } else if (deviceId === 'mixer') {
    deviceState.mixer.host = data.ip || '';
    if (data.mixerType) deviceState.mixer.type = data.mixerType;
  } else {
    // Single-instance devices
    const firstField = def.fields[0];
    if (firstField) {
      deviceState[deviceId][firstField.key] = data.ip || data.url || '';
    }
    if (data.port && deviceState[deviceId].port !== undefined) {
      deviceState[deviceId].port = String(data.port);
    }
    if ('configured' in deviceState[deviceId]) {
      deviceState[deviceId].configured = true;
    }
  }

  expandedDevices.add(deviceId);
  renderDeviceCatalog();
  renderActiveSummary();
}
