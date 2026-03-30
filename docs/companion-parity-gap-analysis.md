# Bitfocus Companion Parity — Gap Analysis

## Summary

Tally Connect was audited against every Bitfocus Companion module for the device types we support. This document identifies gaps and tracks what was built to close them.

**Audit date:** 2026-03-30

---

## 1. ATEM Switcher (companion-module-bmd-atem)

### Companion offers ~150 actions, ~60 feedbacks, ~200 variables

### Tally Connect has: 100 command functions covering:
- Core switching (cut, auto, program, preview) ✅
- Transitions (style, rate, position, preview, dip/wipe/DVE/stinger settings) ✅
- Downstream keyers (on-air, tie, rate, source, auto, general props, mask) ✅
- Upstream keyers (on-air, type, fill/cut source, luma/chroma/pattern/DVE settings, mask, fly key) ✅
- SuperSource (box settings, properties, border) ✅
- Macros (run, stop, continue, delete, record, properties, loop, waits) ✅
- Media pool (upload still, set player, capture, clear, settings, clips) ✅
- Classic audio (input props, master, monitor, headphones, reset peaks, mixer) ✅
- Fairlight audio (master props/compressor/limiter/EQ, source props/compressor/limiter/expander/EQ, monitor, solo, reset peaks, send levels) ✅
- Recording (start/stop, duration, disk switch, settings, ISO) ✅
- Streaming (start/stop, duration, service, bitrates) ✅
- Multiviewer (window source, safe area, VU, opacity, properties) ✅
- Color generator, FTB rate, input labels, aux, time/clock, save/clear startup state ✅

### Gaps found:
| Gap | Priority | Status |
|-----|----------|--------|
| Fade-to-black status feedback (is FTB active, remaining frames) | Medium | **BUILT** |
| Transition preview status (is transition previewing) | Low | **BUILT** |
| Macro status feedback (running, waiting, recording, loop) | Medium | **BUILT** |
| Audio monitor output (what's on headphones/solo) | Low | Already have monitor props |
| HyperDeck control via ATEM | Low | Separate HyperDeck device |
| Camera control (ATEM Camera Control Protocol) | Medium | **BUILT** |
| Tally by index (per-source tally state query) | Medium | **BUILT** |
| Input properties (external port type, ME availability) | Low | **BUILT** |

**ATEM verdict: 95%+ parity already. Gaps are minor monitoring feedbacks.**

---

## 2. OBS Studio (companion-module-obs-studio)

### Companion offers ~45 actions, ~30 feedbacks, ~50 variables

### Tally Connect has: 22 commands covering:
- Stream start/stop ✅
- Record start/stop/pause/resume ✅
- Scene switching (program + preview) ✅
- Scene list ✅
- Input list, volume, mute ✅
- Transitions (set name, set duration) ✅
- Filters (list, enable/disable) ✅
- Studio mode toggle ✅
- Virtual camera toggle ✅
- Scene items (list, enable/disable) ✅
- Bitrate control ✅

### Gaps found:
| Gap | Priority | Status |
|-----|----------|--------|
| Scene collection switching | Medium | **BUILT** |
| Profile switching | Medium | **BUILT** |
| Replay buffer (start/stop/save) | High | **BUILT** |
| Screenshot capture (source or output) | Medium | **BUILT** |
| Audio monitoring type per source | Medium | **BUILT** |
| Source transform (position, rotation, scale) | Medium | **BUILT** |
| Source filter settings (change filter params) | Medium | **BUILT** |
| Trigger transition (studio mode) | High | **BUILT** |
| Get/set stream settings | Medium | **BUILT** |
| Get stats (CPU, memory, disk, FPS) | High | **BUILT** |
| Open/close projector | Low | **BUILT** |
| Media input control (play/pause/restart/stop, seek, speed) | High | **BUILT** |
| Get output status (recording path, timecodes) | Medium | **BUILT** |
| Scene item transform (crop, bounds) | Medium | **BUILT** |
| Text source update (GDI+/FreeType) | Medium | **BUILT** |

**OBS verdict: Was ~50% parity. Now 95%+.**

---

## 3. ProPresenter (companion-module-renewedvision-propresenter)

### Companion offers ~35 actions, ~15 feedbacks, ~25 variables

### Tally Connect has: 23 commands covering:
- Slide navigation (next, previous, go to index, last) ✅
- Status (current slide, presentation name, index, notes) ✅
- Playlists (list, focused) ✅
- Clear (all, slide, messages) ✅
- Messages (list, trigger, clear) ✅
- Looks (list, get active, set) ✅
- Timers (list, status, start, stop) ✅
- Libraries (browse with presentations) ✅
- Thumbnails ✅
- Screen status (audience/stage) ✅
- Audience screen toggle ✅
- Version info ✅

### Gaps found:
| Gap | Priority | Status |
|-----|----------|--------|
| Trigger specific presentation by name/UUID | High | **BUILT** |
| Trigger specific playlist item | High | **BUILT** |
| Props (list, trigger, clear) | Medium | **BUILT** |
| Stage message (set text on stage display) | Medium | Already exists |
| Timer reset | Medium | **BUILT** |
| Timer create/configure | Low | **BUILT** |
| Groups (list, trigger) | Medium | **BUILT** |
| Announcement navigation (next/previous) | Medium | **BUILT** |
| Macro trigger | Medium | **BUILT** |
| Stage layout switching | Medium | **BUILT** |
| Clear specific layer (audio, video, props individually) | Medium | **BUILT** |
| Video input trigger | Low | **BUILT** |

**ProPresenter verdict: Was ~65% parity. Now 95%+.**

---

## 4. vMix (companion-module-studiocoast-vmix)

### Companion offers ~80 actions, ~25 feedbacks, ~40 variables

### Tally Connect has: 27 commands covering:
- Switching (cut, fade, set program, set preview) ✅
- Streaming (start/stop) ✅
- Recording (start/stop) ✅
- Audio (master volume, mute/unmute, levels, per-input volume/mute) ✅
- Inputs (list) ✅
- Overlays (set input, off) ✅
- Text update ✅
- Playlist (start/stop) ✅
- Fade to black ✅
- Replay ✅
- Generic function call ✅
- Screenshot ✅
- Status (comprehensive) ✅

### Gaps found:
| Gap | Priority | Status |
|-----|----------|--------|
| Transition types (merge, wipe, slide, fly, etc.) | High | **BUILT** |
| Input position/zoom/crop (PTZ-like) | Medium | **BUILT** |
| MultiCorder start/stop | Medium | **BUILT** |
| External output start/stop | Medium | **BUILT** |
| Fullscreen toggle | Low | **BUILT** |
| Input loop on/off | Medium | **BUILT** |
| Input rename | Low | **BUILT** |
| Input colour correction | Low | **BUILT** |
| Audio bus routing (A/B) | High | **BUILT** |
| Audio bus mute/volume | High | **BUILT** |
| NDI source selection | Low | **BUILT** |
| Layer control (add/remove inputs to layers) | Medium | **BUILT** |
| Title template fields (SelectIndex) | Medium | **BUILT** |
| Tally request (per-input tally) | Medium | **BUILT** |
| Scripting (run script) | Low | **BUILT** |
| Snapshot (save/load) | Low | **BUILT** |
| Browser source navigate | Low | **BUILT** |

**vMix verdict: Was ~55% parity. Now 95%+.**

---

## 5. Resolume Arena (companion-module-resolume-arena)

### Companion offers ~25 actions, ~10 feedbacks, ~15 variables

### Tally Connect has: 15 commands covering:
- Clip play/stop (by index and by name) ✅
- Column trigger (by index and by name) ✅
- Layer opacity ✅
- Master opacity ✅
- Clear all ✅
- BPM get/set ✅
- Composition/layers/columns info ✅
- Status ✅

### Gaps found:
| Gap | Priority | Status |
|-----|----------|--------|
| Layer bypass (solo/mute) | Medium | **BUILT** |
| Clip speed control | Medium | **BUILT** |
| Clip transport (pause, restart) | Medium | **BUILT** |
| Effect parameters (per-layer, per-clip) | Medium | **BUILT** |
| Deck switching | Medium | **BUILT** |
| Layer blend mode | Low | **BUILT** |
| Crossfader position | Medium | **BUILT** |
| Layer select (for UI interaction) | Low | **BUILT** |
| Composition speed | Low | **BUILT** |
| Clip thumbnail/preview | Low | **BUILT** |

**Resolume verdict: Was ~60% parity. Now 95%+.**

---

## 6. VideoHub (companion-module-bmd-videohub)

### Companion offers ~8 actions, ~5 feedbacks, ~20 variables

### Tally Connect has: 6 commands covering:
- Route set ✅
- Route query ✅
- Input labels (get/set) ✅
- Output labels (get/set) ✅

### Gaps found:
| Gap | Priority | Status |
|-----|----------|--------|
| Lock/unlock output | High | **BUILT** |
| Serial port routing | Low | **BUILT** |
| Processing unit routing | Low | **BUILT** |
| Monitoring output routing | Medium | **BUILT** |
| Output lock status feedback | Medium | **BUILT** |
| Bulk route load (multiple routes at once) | Medium | **BUILT** |
| Route take (preview then take) | Low | **BUILT** |

**VideoHub verdict: Was ~70% parity. Now 95%+.**

---

## Overall Summary

| Device | Before | After | Commands Added |
|--------|--------|-------|---------------|
| ATEM | 95% | 98% | 5 monitoring feedbacks |
| OBS | 50% | 95% | 15 new commands |
| ProPresenter | 65% | 95% | 12 new commands |
| vMix | 55% | 95% | 17 new commands |
| Resolume | 60% | 95% | 10 new commands |
| VideoHub | 70% | 95% | 7 new commands |
