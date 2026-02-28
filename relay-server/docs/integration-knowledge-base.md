# Tally by ATEM School — Integration Knowledge Base

> **247 commands** across **20 namespaces** controlling **14 equipment categories**

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [ATEM Switcher](#atem-switcher)
3. [HyperDeck Recorders](#hyperdeck-recorders)
4. [PTZ Cameras](#ptz-cameras)
5. [VideoHub Routers](#videohub-routers)
6. [ProPresenter](#propresenter)
7. [vMix](#vmix)
8. [Resolume Arena](#resolume-arena)
9. [Audio Consoles (Mixers)](#audio-consoles)
10. [Streaming Encoders](#streaming-encoders)
11. [Encoder-Specific Commands](#encoder-specific-commands)
12. [OBS Studio](#obs-studio)
13. [Bitfocus Companion](#bitfocus-companion)
14. [NDI](#ndi)
15. [System Commands](#system-commands)
16. [PTZ Auto-Detect Protocols](#ptz-auto-detect-protocols)
17. [Mixer Capability Matrix](#mixer-capability-matrix)
18. [Encoder Adapter Matrix](#encoder-adapter-matrix)
19. [Configuration Reference](#configuration-reference)
20. [Status Object Reference](#status-object-reference)

---

## Architecture Overview

```
Electron App (TD interface)
     |
     |  IPC + HTTP sync
     v
Church Client (agent runtime)
     |  ── ATEM SDK (UDP 9910)
     |  ── VISCA / ONVIF (PTZ cameras)
     |  ── TCP 9990 (VideoHub)
     |  ── TCP 9993 (HyperDeck)
     |  ── HTTP REST (ProPresenter, vMix, Resolume, encoders)
     |  ── OSC (Behringer, Allen & Heath, Yamaha CL/QL)
     |  ── TCP MIDI (Yamaha TF)
     |  ── WebSocket (OBS v5)
     |
     |  WebSocket relay (status + commands)
     v
Relay Server (Express.js + SQLite)
     |  ── SSE → Admin Dashboard
     |  ── SSE → Church Portal
     |  ── REST API → Electron App
```

---

## ATEM Switcher

**Protocol:** Blackmagic ATEM SDK (UDP port 9910)
**Config key:** `atemIp`
**Status path:** `status.atem`
**Commands:** 100

### Video Switching
| Command | Parameters | Description |
|---------|-----------|-------------|
| `atem.cut` | `me?`, `input?` | Cut transition (optionally set input first) |
| `atem.auto` | `me?`, `input?` | Auto transition |
| `atem.setProgram` | `me?`, `input` | Set program bus input |
| `atem.setPreview` | `me?`, `input` | Set preview bus input |
| `atem.fadeToBlack` | `me?` | Toggle fade to black |
| `atem.setFadeToBlackRate` | `me?`, `rate` | Set FTB rate (frames) |
| `atem.setAux` | `bus`, `input` | Set aux/clean feed source |
| `atem.setInputLabel` | `input`, `name`, `label?` | Rename an input |
| `atem.listVisibleInputs` | `me?` | List available inputs for an M/E |

### Transitions
| Command | Parameters | Description |
|---------|-----------|-------------|
| `atem.setTransitionStyle` | `me?`, `style` | mix, dip, wipe, dve, stinger |
| `atem.setTransitionRate` | `me?`, `rate` | Transition duration (frames) |
| `atem.setTransitionPosition` | `me?`, `position` | Manual T-bar (0-10000) |
| `atem.previewTransition` | `me?`, `enabled` | Enable/disable PREV TRANS |
| `atem.setDipTransitionSettings` | `me?`, `rate?`, `input?` | Dip source & rate |
| `atem.setWipeTransitionSettings` | `me?`, `pattern?`, `...` | Wipe pattern settings |
| `atem.setDVETransitionSettings` | `me?`, `style?`, `...` | DVE settings |
| `atem.setStingerTransitionSettings` | `me?`, `source?`, `...` | Stinger clip settings |

### Upstream Keyers (USK)
| Command | Parameters | Description |
|---------|-----------|-------------|
| `atem.setUskOnAir` | `me?`, `key`, `onAir` | Key on/off air |
| `atem.setUskFillSource` | `me?`, `key`, `source` | Fill source input |
| `atem.setUskCutSource` | `me?`, `key`, `source` | Key/cut source input |
| `atem.setUskType` | `me?`, `key`, `type` | luma/chroma/pattern/dve |
| `atem.setUskLumaSettings` | `me?`, `key`, `...` | Luma key parameters |
| `atem.setUskChromaSettings` | `me?`, `key`, `...` | Chroma key parameters |
| `atem.setUskPatternSettings` | `me?`, `key`, `...` | Pattern key parameters |
| `atem.setUskDVESettings` | `me?`, `key`, `...` | DVE key parameters |
| `atem.setUskMaskSettings` | `me?`, `key`, `...` | Mask settings |
| `atem.runUskFlyKeyTo` | `me?`, `key`, `position` | Fly key to position |
| `atem.runUskFlyKeyToInfinite` | `me?`, `key`, `direction` | Fly to infinite position |

### Downstream Keyers (DSK)
| Command | Parameters | Description |
|---------|-----------|-------------|
| `atem.setDskOnAir` | `key`, `onAir` | DSK on/off air |
| `atem.setDskTie` | `key`, `tie` | Tie to next transition |
| `atem.setDskRate` | `key`, `rate` | Auto-mix rate (frames) |
| `atem.setDskSource` | `key`, `fill`, `cut` | Fill and key sources |
| `atem.autoDsk` | `key` | Auto DSK transition |
| `atem.setDskGeneralProperties` | `key`, `...` | Pre-multiplied, clip, gain |
| `atem.setDskMaskSettings` | `key`, `...` | Mask enable/position |

### SuperSource
| Command | Parameters | Description |
|---------|-----------|-------------|
| `atem.setSuperSourceBoxSettings` | `box`, `...` | Box position, size, source, crop |
| `atem.setSuperSourceProperties` | `artFillSource?`, `...` | Art source and mode |
| `atem.setSuperSourceBorder` | `enabled?`, `...` | Border settings |

### Macros
| Command | Parameters | Description |
|---------|-----------|-------------|
| `atem.runMacro` | `index` | Run macro by index |
| `atem.stopMacro` | | Stop running macro |
| `atem.macroContinue` | | Continue paused macro |
| `atem.macroDelete` | `index` | Delete macro |
| `atem.macroStartRecord` | `index`, `name?`, `description?` | Start recording |
| `atem.macroStopRecord` | | Stop recording |
| `atem.macroUpdateProperties` | `index`, `name?`, `description?` | Edit name/desc |
| `atem.macroSetLoop` | `enabled` | Toggle loop mode |
| `atem.macroInsertUserWait` | | Insert user-wait pause |
| `atem.macroInsertTimedWait` | `frames` | Insert timed wait |

### Media Pool
| Command | Parameters | Description |
|---------|-----------|-------------|
| `atem.uploadStill` | `index?`, `data`, `name?`, `mimeType?` | Upload image (base64) |
| `atem.captureStill` | | Capture from output |
| `atem.clearStill` | `index` | Clear media slot |
| `atem.setMediaPlayer` | `player?`, `type`, `index` | Set player source |
| `atem.setMediaPlayerSettings` | `player?`, `loop?`, `playing?` | Player settings |
| `atem.setMediaClip` | `index`, `name?`, `frames?` | Configure clip slot |
| `atem.clearMediaPoolClip` | `index` | Clear clip slot |

### Classic Audio Mixer
| Command | Parameters | Description |
|---------|-----------|-------------|
| `atem.setClassicAudioInputProps` | `index`, `...` | Input gain, balance, mix option |
| `atem.setClassicAudioMasterProps` | `gain?`, `balance?`, `...` | Master output settings |
| `atem.setClassicAudioMonitorProps` | `enabled?`, `gain?`, `...` | Monitor output |
| `atem.setClassicAudioHeadphonesProps` | `gain?`, `...` | Headphone settings |
| `atem.setClassicAudioResetPeaks` | `all?`, `master?`, `input?` | Reset peak meters |
| `atem.setClassicAudioMixerProps` | `mode?` | Mixer mode |

### Fairlight Audio (Constellation / Mini Extreme)
| Command | Parameters | Description |
|---------|-----------|-------------|
| `atem.setFairlightAudioMasterProps` | `gain?`, `...` | Master output |
| `atem.setFairlightAudioMasterCompressorProps` | `...` | Master compressor |
| `atem.setFairlightAudioMasterLimiterProps` | `...` | Master limiter |
| `atem.setFairlightAudioMasterEqBandProps` | `band`, `...` | Master EQ per band |
| `atem.setFairlightAudioMasterEqReset` | | Reset master EQ |
| `atem.setFairlightAudioMasterDynamicsReset` | | Reset dynamics |
| `atem.setFairlightAudioResetPeaks` | `all?`, `master?`, `input?` | Reset peaks |
| `atem.startFairlightSendLevels` | | Start level metering |
| `atem.stopFairlightSendLevels` | | Stop level metering |
| `atem.setFairlightAudioMonitorProps` | `gain?`, `...` | Monitor output |
| `atem.setFairlightAudioMonitorSolo` | `input?`, `source?` | Solo input |
| `atem.setFairlightAudioInputProps` | `index`, `...` | Input properties |
| `atem.setFairlightAudioSourceProps` | `index`, `source?`, `...` | Per-source properties |
| `atem.setFairlightAudioSourceCompressorProps` | `index`, `source?`, `...` | Per-source compressor |
| `atem.setFairlightAudioSourceLimiterProps` | `index`, `source?`, `...` | Per-source limiter |
| `atem.setFairlightAudioSourceExpanderProps` | `index`, `source?`, `...` | Per-source expander |
| `atem.setFairlightAudioSourceEqBandProps` | `index`, `source?`, `band`, `...` | Per-source EQ |

### Streaming & Recording
| Command | Parameters | Description |
|---------|-----------|-------------|
| `atem.startStreaming` | | Start ATEM streaming output |
| `atem.stopStreaming` | | Stop ATEM streaming output |
| `atem.setStreamingService` | `name?`, `url?`, `key?` | Configure stream service |
| `atem.setStreamingAudioBitrates` | `lowBitrate?`, `highBitrate?` | Audio bitrate settings |
| `atem.requestStreamingDuration` | | Get uptime |
| `atem.startRecording` | | Start USB recording |
| `atem.stopRecording` | | Stop USB recording |
| `atem.requestRecordingDuration` | | Get recording duration |
| `atem.switchRecordingDisk` | | Switch active disk |
| `atem.setRecordingSettings` | `filename?`, `...` | Recording file settings |
| `atem.setEnableISORecording` | `enabled` | Enable ISO recording |

### Time & Clock
| Command | Parameters | Description |
|---------|-----------|-------------|
| `atem.setTime` | `hour`, `minute`, `second`, `frame` | Set timecode |
| `atem.requestTime` | | Get current timecode |
| `atem.setDisplayClockProperties` | `enabled?`, `size?`, `...` | Clock overlay settings |

### Multiviewer
| Command | Parameters | Description |
|---------|-----------|-------------|
| `atem.setMultiViewerWindowSource` | `mv?`, `window`, `source` | Set window source |
| `atem.setMultiViewerWindowSafeAreaEnabled` | `mv?`, `window`, `enabled` | Toggle safe area |
| `atem.setMultiViewerWindowVuEnabled` | `mv?`, `window`, `enabled` | Toggle VU meter |
| `atem.setMultiViewerVuOpacity` | `mv?`, `opacity` | VU meter opacity |
| `atem.setMultiViewerProperties` | `mv?`, `...` | Layout properties |

### Misc
| Command | Parameters | Description |
|---------|-----------|-------------|
| `atem.setColorGeneratorColour` | `index`, `hue`, `saturation`, `luminance` | Color gen |
| `atem.saveStartupState` | | Save current as startup |
| `atem.clearStartupState` | | Clear startup state |

---

## HyperDeck Recorders

**Protocol:** Blackmagic HyperDeck Ethernet Protocol (TCP port 9993)
**Config key:** `hyperdecks` (array)
**Status path:** `status.hyperdecks[]`
**Max instances:** 8
**Commands:** 7

| Command | Parameters | Description |
|---------|-----------|-------------|
| `hyperdeck.play` | `hyperdeck?` | Play (1-based index, default 1) |
| `hyperdeck.stop` | `hyperdeck?` | Stop transport |
| `hyperdeck.record` | `hyperdeck?` | Start recording |
| `hyperdeck.stopRecord` | `hyperdeck?` | Stop recording |
| `hyperdeck.nextClip` | `hyperdeck?` | Advance to next clip |
| `hyperdeck.prevClip` | `hyperdeck?` | Go to previous clip |
| `hyperdeck.status` | `hyperdeck?` | Full status (model, transport, recording, clip) |

**Fallback behavior:** If direct TCP connection fails, commands fall back to ATEM HyperDeck bridge (for ATEMs with HyperDeck control).

---

## PTZ Cameras

**Protocols:** ONVIF, VISCA TCP/UDP, PTZOptics, Sony VISCA
**Config key:** `ptz` (array of objects)
**Status path:** `status.ptz[]`
**Max instances:** 8
**Commands:** 7

| Command | Parameters | Description |
|---------|-----------|-------------|
| `ptz.pan` | `camera?`, `cameraName?`, `speed` | Pan (-1.0 left to 1.0 right) |
| `ptz.tilt` | `camera?`, `cameraName?`, `speed` | Tilt (-1.0 down to 1.0 up) |
| `ptz.zoom` | `camera?`, `cameraName?`, `speed` | Zoom (-1.0 wide to 1.0 tele) |
| `ptz.preset` | `camera?`, `cameraName?`, `preset` | Recall preset |
| `ptz.stop` | `camera?`, `cameraName?` | Stop all motion |
| `ptz.home` | `camera?`, `cameraName?` | Move to home position |
| `ptz.setPreset` | `camera?`, `cameraName?`, `preset` | Save current position as preset |

**Camera selection:** Use `camera` (1-based index) or `cameraName` (name match). Defaults to camera 1.

**Dual-path PTZ:** Network PTZ cameras (`ptzManager`) are tried first. Falls back to ATEM PTZ for cameras connected via ATEM SDI.

### Auto-Detect Protocol Order

When protocol is set to `auto`, the system tries these in order:

1. **ONVIF** (port 80) — most common, broadest compatibility
2. **PTZOptics ONVIF** (port 80) — PTZOptics-specific profile
3. **VISCA TCP** (port 5678) — generic TCP
4. **PTZOptics VISCA** (port 5678) — PTZOptics-specific commands
5. **VISCA UDP** (port 1259) — standard UDP
6. **Sony VISCA UDP** (port 52381) — Sony cameras

---

## VideoHub Routers

**Protocol:** Blackmagic Videohub Ethernet Protocol (TCP port 9990)
**Config key:** `videoHubs` (array)
**Status path:** `status.videoHubs[]`
**Max instances:** 4
**Commands:** 6

| Command | Parameters | Description |
|---------|-----------|-------------|
| `videohub.route` | `hubIndex?`, `output`, `input` | Route input to output |
| `videohub.getRoutes` | `hubIndex?` | Get current routing table |
| `videohub.setInputLabel` | `hubIndex?`, `index`, `label` | Rename input |
| `videohub.setOutputLabel` | `hubIndex?`, `index`, `label` | Rename output |
| `videohub.getInputLabels` | `hubIndex?` | List all input labels |
| `videohub.getOutputLabels` | `hubIndex?` | List all output labels |

---

## ProPresenter

**Protocol:** ProPresenter REST API (HTTP port 1025)
**Config key:** `proPresenter` (object with `host`, `port`)
**Status path:** `status.proPresenter`
**Commands:** 17

| Command | Parameters | Description |
|---------|-----------|-------------|
| `propresenter.next` | | Next slide |
| `propresenter.previous` | | Previous slide |
| `propresenter.goToSlide` | `index` | Jump to slide number |
| `propresenter.status` | | Current slide info |
| `propresenter.playlist` | | List playlist items |
| `propresenter.isRunning` | | Check reachability |
| `propresenter.clearAll` | | Clear all layers |
| `propresenter.clearSlide` | | Clear slide layer only |
| `propresenter.stageMessage` | `name`, `tokens?` | Trigger stage message |
| `propresenter.clearMessage` | | Clear all messages |
| `propresenter.getLooks` | | List available looks |
| `propresenter.setLook` | `name` | Switch to look |
| `propresenter.getTimers` | | List timers |
| `propresenter.startTimer` | `name` | Start timer |
| `propresenter.stopTimer` | `name` | Stop timer |
| `propresenter.version` | | Get ProPresenter version |
| `propresenter.messages` | | List available messages with UUIDs |

---

## vMix

**Protocol:** vMix HTTP API (port 8088)
**Config key:** `vmix` (object with `host`, `port`)
**Status path:** `status.vmix`
**Commands:** 19

| Command | Parameters | Description |
|---------|-----------|-------------|
| `vmix.status` | | Full status (edition, inputs, streaming, recording) |
| `vmix.cut` | | Cut to preview |
| `vmix.fade` | `duration?` | Fade transition (default 2000ms) |
| `vmix.setPreview` | `input` | Set preview input |
| `vmix.setProgram` | `input` | Set program input |
| `vmix.listInputs` | | List all inputs |
| `vmix.startStream` | | Start streaming |
| `vmix.stopStream` | | Stop streaming |
| `vmix.startRecording` | | Start recording |
| `vmix.stopRecording` | | Stop recording |
| `vmix.setVolume` | `value` | Set master volume (0-100) |
| `vmix.mute` | | Mute master |
| `vmix.unmute` | | Unmute master |
| `vmix.preview` | | Capture screenshot |
| `vmix.isRunning` | | Check reachability |
| `vmix.function` | `function`, `input?`, `value?` | Low-level vMix function |
| `vmix.startPlaylist` | | Start playlist |
| `vmix.stopPlaylist` | | Stop playlist |
| `vmix.audioLevels` | | Get master audio levels (volume, muted, L/R meters) |

---

## Resolume Arena

**Protocol:** Resolume REST API (HTTP port 8080, base path `/api/v1`)
**Config key:** `resolume` (object with `host`, `port`)
**Status path:** `status.resolume`
**Commands:** 13

| Command | Parameters | Description |
|---------|-----------|-------------|
| `resolume.status` | | Full status (playing clips, BPM, layers, columns) |
| `resolume.playClip` | `layer`, `clip` OR `name` | Play clip (by index or name) |
| `resolume.stopClip` | `layer`, `clip` | Stop clip |
| `resolume.triggerColumn` | `column` OR `name` | Trigger column (by index or name) |
| `resolume.clearAll` | | Stop all clips |
| `resolume.setLayerOpacity` | `layer`, `value` | Set layer opacity (0.0-1.0) |
| `resolume.setMasterOpacity` | `value` | Set master opacity (0.0-1.0) |
| `resolume.setBpm` | `bpm` | Set BPM (20-300) |
| `resolume.getLayers` | | List all layers |
| `resolume.getColumns` | | List all columns |
| `resolume.isRunning` | | Check reachability |
| `resolume.version` | | Get Resolume product/version |
| `resolume.getBpm` | | Get current BPM |

---

## Audio Consoles

**Protocols:** OSC (Behringer, Allen & Heath, Yamaha CL/QL), TCP MIDI (Yamaha TF)
**Config key:** `mixer` (object with `type`, `host`, `port`)
**Status path:** `status.mixer`
**Commands:** 17

### Commands

| Command | Parameters | Description |
|---------|-----------|-------------|
| `mixer.status` | | Console status (model, main fader, muted, scene) |
| `mixer.mute` | `channel?` | Mute channel or master |
| `mixer.unmute` | `channel?` | Unmute channel or master |
| `mixer.channelStatus` | `channel` | Channel fader level and mute |
| `mixer.recallScene` | `scene` | Recall scene/snapshot |
| `mixer.clearSolos` | | Clear all solo channels |
| `mixer.isOnline` | | Check reachability |
| `mixer.setFader` | `channel`, `level` | Set fader (0.0-1.0) |
| `mixer.setChannelName` | `channel`, `name` | Rename channel |
| `mixer.setHpf` | `channel`, `enabled?`, `frequency?` | High-pass filter |
| `mixer.setEq` | `channel`, `enabled?`, `bands?` | Parametric EQ |
| `mixer.setCompressor` | `channel`, `threshold?`, `ratio?`, `...` | Compressor |
| `mixer.setGate` | `channel`, `threshold?`, `range?`, `...` | Noise gate |
| `mixer.setFullChannelStrip` | `channel`, `name?`, `hpf?`, `eq?`, `...` | Batch channel setup |
| `mixer.saveScene` | `scene`, `name?` | Save scene/snapshot |
| `mixer.setupFromPatchList` | `channels[]`, `saveScene?`, `sceneName?` | AI batch setup |
| `mixer.capabilities` | | Show supported features for this model |

### ATEM Audio Modes (mixer type)

| Type | Behavior |
|------|----------|
| `atem-auto` | Auto-detect XLR/RCA inputs on ATEM, no external mixer needed |
| `atem-direct` | Force "audio via ATEM" (manual override) |
| `atem-none` | Force "no ATEM audio" (manual override) |

### Supported Console Models

| Type | Model | Protocol | Default Port |
|------|-------|----------|-------------|
| `x32` / `behringer` | Behringer X32, X-Air | OSC | 10023 |
| `midas` | Midas M32, M32R | OSC | 10023 |
| `allenheath` | Allen & Heath SQ, dLive | OSC | 51326 (SQ), 51327 (dLive) |
| `yamaha` | Yamaha CL, QL | OSC | 8765 |
| `yamaha` | Yamaha TF | TCP MIDI | 49280 |

---

## Streaming Encoders

**Config key:** `encoder` (object with `type`, `host`, `port`, `password?`)
**Status path:** `status.encoder`
**Commands:** 5 (generic) + 34 (device-specific)

### Generic Commands (work with all encoder types)

| Command | Parameters | Description |
|---------|-----------|-------------|
| `encoder.startStream` | | Start streaming |
| `encoder.stopStream` | | Stop streaming |
| `encoder.startRecording` | | Start recording |
| `encoder.stopRecording` | | Stop recording |
| `encoder.status` | | Get encoder status |

### Supported Encoder Types

| Type Key | Product | Protocol | Control API |
|----------|---------|----------|------------|
| `obs` | OBS Studio | WebSocket v5 | Full (scenes, sources, stream, record) |
| `vmix` | vMix | HTTP | Full (inputs, stream, record) |
| `ecamm` | Ecamm Live (Mac) | HTTP | Full (scenes, inputs, overlays) |
| `blackmagic` | Web Presenter / Streaming Bridge | REST | Full (platforms, formats, audio) |
| `aja` | AJA HELO | REST | Full (inputs, profiles, presets) |
| `epiphan` | Epiphan Pearl | REST v2 | Full (channels, publishers, layouts) |
| `teradek` | Teradek Cube / VidiU | CGI | Basic (stream start/stop, status) |
| `tricaster` | TriCaster | Shortcut API | Basic (stream, record) |
| `birddog` | BirdDog | HTTP | Basic (stream, record, NDI source) |
| `tally-encoder` | Tally Encoder | Proprietary | Basic (stream, record) |
| `ndi` | NDI Decoder | ffprobe/libndi | Monitor only (no control) |
| `atem-streaming` | ATEM Mini built-in | ATEM SDK | Monitor only (controlled via ATEM) |
| `yolobox` | YoloBox | RTMP push | Monitor only (no API) |
| `custom-rtmp` | Custom RTMP | RTMP push | Monitor only |
| `custom` | Custom HTTP | HTTP | Status endpoint only |

---

## Encoder-Specific Commands

These commands are **type-gated** — they only work when the encoder type matches. Calling a `blackmagic.*` command when the encoder is OBS will throw an error.

### Blackmagic Web Presenter (9 commands)

| Command | Parameters | Description |
|---------|-----------|-------------|
| `blackmagic.getActivePlatform` | | Get current streaming platform config |
| `blackmagic.setActivePlatform` | `config` | Set active platform |
| `blackmagic.getPlatforms` | | List available platforms |
| `blackmagic.getPlatformConfig` | `name` | Get platform config by name |
| `blackmagic.getVideoFormat` | | Get current video format |
| `blackmagic.setVideoFormat` | `format` | Set video format |
| `blackmagic.getSupportedVideoFormats` | | List supported formats |
| `blackmagic.getAudioSources` | | List audio sources |
| `blackmagic.setAudioSource` | `source` | Set active audio source |

### AJA HELO (6 commands)

| Command | Parameters | Description |
|---------|-----------|-------------|
| `aja.setVideoInput` | `source` | 0=SDI, 1=HDMI, 2=Test pattern |
| `aja.setAudioInput` | `source` | 0=SDI, 1=HDMI, 2=Analog, 4=None |
| `aja.setStreamProfile` | `profile` | Stream profile (0-9) |
| `aja.setRecordProfile` | `profile` | Record profile (0-9) |
| `aja.setMute` | `mute` | Mute/unmute audio |
| `aja.recallPreset` | `preset` | Recall device preset (1-20) |

### Epiphan Pearl (6 commands)

| Command | Parameters | Description |
|---------|-----------|-------------|
| `epiphan.startPublisher` | `channel`, `publisher` | Start publisher on channel |
| `epiphan.stopPublisher` | `channel`, `publisher` | Stop publisher |
| `epiphan.getLayouts` | `channel` | List layouts for channel |
| `epiphan.setActiveLayout` | `channel`, `layout` | Set active layout |
| `epiphan.getStreamingParams` | `channel`, `keys?` | Get streaming parameters |
| `epiphan.setStreamingParams` | `channel`, `params` | Set streaming parameters |

### Ecamm Live (10 commands)

| Command | Parameters | Description |
|---------|-----------|-------------|
| `ecamm.togglePause` | | Toggle pause state |
| `ecamm.getScenes` | | List available scenes |
| `ecamm.setScene` | `id` | Switch scene by UUID |
| `ecamm.nextScene` | | Next scene |
| `ecamm.prevScene` | | Previous scene |
| `ecamm.toggleMute` | | Toggle audio mute |
| `ecamm.getInputs` | | List available inputs |
| `ecamm.setInput` | `id` | Switch input by UUID |
| `ecamm.togglePIP` | | Toggle picture-in-picture |
| `ecamm.getOverlays` | | List overlay items |

### NDI (2 commands)

| Command | Parameters | Description |
|---------|-----------|-------------|
| `ndi.getSource` | | Get current NDI source name |
| `ndi.setSource` | `source` | Set NDI source name |

---

## OBS Studio

**Protocol:** OBS WebSocket v5 (port 4455)
**Config key:** `obsUrl` or `encoder.type = 'obs'`
**Status path:** `status.obs`
**Commands:** 7

| Command | Parameters | Description |
|---------|-----------|-------------|
| `obs.startStream` | | Start streaming |
| `obs.stopStream` | | Stop streaming |
| `obs.startRecording` | | Start recording |
| `obs.stopRecording` | | Stop recording |
| `obs.setScene` | `scene` | Switch to scene by name |
| `obs.configureMonitorStream` | `url?`, `key?` | Remote RTMP config |
| `obs.reduceBitrate` | `percent?` | Reduce bitrate by percentage |

---

## Bitfocus Companion

**Protocol:** Companion HTTP API (port 8888)
**Config key:** `companionUrl`
**Status path:** `status.companion`
**Commands:** 4

| Command | Parameters | Description |
|---------|-----------|-------------|
| `companion.press` | `page`, `bank` | Press button by page/bank |
| `companion.pressNamed` | `label` | Press button by label text |
| `companion.getGrid` | | Get button grid layout |
| `companion.connections` | | List configured connections |

---

## NDI

**Protocol:** NDI (Network Device Interface) via ffprobe
**Config key:** `ndi` (object)
**Status path:** embedded in encoder status
**Commands:** 2 (via encoder-specific)

NDI is primarily used as an encoder input source. The NDI encoder adapter monitors an NDI source for stream health (bitrate, resolution) but does not control the source.

---

## System Commands

| Command | Parameters | Description |
|---------|-----------|-------------|
| `status` | | Full system status (all devices) |
| `system.preServiceCheck` | | Pre-service go/no-go check |
| `system.setWatchdogMode` | `enabled` | Enable/disable watchdog |
| `system.getServiceWindow` | | Get scheduled service window |
| `preview.start` | `intervalMs?` | Start preview snapshots |
| `preview.stop` | | Stop preview snapshots |
| `preview.snap` | | Take single preview snapshot |

### Pre-Service Check

The `system.preServiceCheck` command runs a comprehensive equipment audit:

1. **ATEM** — Connected, program input active, not in fade-to-black
2. **OBS/Encoder** — Connected and streaming (or ready)
3. **Audio** — Audio monitoring active (or audio via ATEM detected)
4. **ProPresenter** — Running and reachable
5. **vMix** — Running and reachable, input count > 0
6. **Resolume** — Running, composition loaded
7. **PTZ Cameras** — All configured cameras connected

Returns `{ pass: boolean, checks: [{name, pass, detail}] }`.

---

## PTZ Auto-Detect Protocols

When a PTZ camera's protocol is set to `auto`, the system tries to connect using each protocol in sequence until one succeeds:

| Order | Protocol | Default Port | Best For |
|-------|----------|-------------|----------|
| 1 | ONVIF | 80 | Most IP cameras (broadest compatibility) |
| 2 | PTZOptics ONVIF | 80 | PTZOptics cameras (specific ONVIF profile) |
| 3 | VISCA TCP | 5678 | Generic VISCA over TCP |
| 4 | PTZOptics VISCA | 5678 | PTZOptics cameras (VISCA dialect) |
| 5 | VISCA UDP | 1259 | Standard VISCA over UDP |
| 6 | Sony VISCA UDP | 52381 | Sony SRG/BRC cameras |

**Protocol aliases:**
- `ptzoptics` → `ptzoptics-visca`
- `visca`, `tcp` → `visca-tcp`
- `udp` → `visca-udp`
- `sony-visca`, `visca-sony` → `sony-visca-udp`

---

## Mixer Capability Matrix

Features that are `false` will throw an explicit error: *"X is not supported on MODEL via its remote protocol — set this at the console directly"*

| Feature | X32/M32 | SQ/dLive | CL/QL | TF |
|---------|---------|----------|-------|----|
| Compressor | Full | Blocked | Blocked | Blocked |
| Gate | Full | Blocked | Blocked | Blocked |
| HPF | Full | Full | Blocked | Blocked |
| EQ (per-band) | Full (4 bands) | Partial (on/off only) | Blocked | Blocked |
| Fader | Full | Full | Partial (may warn) | Blocked |
| Channel Name | Full (12 char) | Full (8 char) | Blocked | Blocked |
| Mute Master | Full | Full | Partial (may warn) | Blocked |
| Mute Channel | Full | Full | Partial (may warn) | Partial (model-specific) |
| Recall Scene | Full | Full | Full | Full |
| Save Scene | Partial (FW-dependent) | Partial (may fail) | Blocked | Blocked |
| Clear Solos | Full | Blocked | Blocked | Blocked |
| Channel Strip | Full | Partial (skips comp/gate) | Partial (fader/mute only) | Blocked |

**Why keep Yamaha?** Scene recall works reliably on all models. The CL/QL can do basic fader/mute. Online detection supports the pre-service check.

---

## Encoder Adapter Matrix

| Feature | OBS | vMix | Ecamm | Blackmagic | AJA | Epiphan | Teradek | TriCaster | BirdDog | NDI | ATEM |
|---------|-----|------|-------|------------|-----|---------|---------|-----------|---------|-----|------|
| Start Stream | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | - | - |
| Stop Stream | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | - | - |
| Start Record | Yes | Yes | - | Yes | Yes | Yes | Yes | Yes | - | - | - |
| Stop Record | Yes | Yes | - | Yes | Yes | Yes | Yes | Yes | - | - | - |
| Get Status | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| Is Online | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| Device-Specific | Scenes | Inputs | Scenes, PIP | Platforms, Formats | Inputs, Presets | Layouts, Publishers | - | - | - | Source | - |

---

## Configuration Reference

### Equipment Config Keys

| Equipment | Config Key | Type | Example |
|-----------|-----------|------|---------|
| ATEM | `atemIp` | string | `"192.168.1.240"` |
| OBS | `obsUrl` | string | `"ws://192.168.1.100:4455"` |
| Encoder | `encoder` | object | `{type: "blackmagic", host: "192.168.1.50"}` |
| Companion | `companionUrl` | string | `"http://192.168.1.100:8888"` |
| VideoHubs | `videoHubs` | array | `[{ip: "192.168.1.30", name: "Main"}]` |
| HyperDecks | `hyperdecks` | array | `[{ip: "192.168.1.31"}]` |
| ProPresenter | `proPresenter` | object | `{host: "192.168.1.20", port: 1025}` |
| Resolume | `resolume` | object | `{host: "192.168.1.21", port: 8080}` |
| vMix | `vmix` | object | `{host: "192.168.1.22", port: 8088}` |
| Mixer | `mixer` | object | `{type: "x32", host: "192.168.1.60", port: 10023}` |
| PTZ Cameras | `ptz` | array | `[{ip: "192.168.1.40", protocol: "auto", name: "Cam 1"}]` |
| Audio via ATEM | `audioViaAtem` | 0/1 | `1` |
| ATEM Override | `audioViaAtemOverride` | string/null | `"on"`, `"off"`, or `null` (auto) |

### Mixer Type → Default Port

| Type | Port |
|------|------|
| `x32`, `behringer`, `midas` | 10023 |
| `allenheath` (SQ) | 51326 |
| `allenheath` (dLive) | 51327 |
| `yamaha` (CL/QL) | 8765 |
| `yamaha` (TF) | 49280 |

---

## Status Object Reference

```javascript
{
  atem: {
    connected: boolean,
    ip: string,
    model: string,                // e.g., "ATEM Mini Extreme ISO"
    programInput: number,
    previewInput: number,
    recording: boolean,
    streaming: boolean,
    atemAudioSources: [{          // Auto-detected audio inputs
      inputId: number,
      portType: string,           // "XLR", "RCA", "SDI", etc.
      mixOption: string,          // "On", "AFV"
    }],
  },
  audioViaAtem: boolean,          // Audio routed through ATEM
  audioViaAtemSource: string,     // "none" | "auto" | "manual"
  obs: {
    connected: boolean,
    streaming: boolean,
    recording: boolean,
    bitrate: number,
    fps: number,
  },
  encoder: {
    type: string,
    connected: boolean,
    live: boolean,
    bitrateKbps: number,
    fps: number,
    recording: boolean,
  },
  mixer: {
    connected: boolean,
    type: string,
    model: string,                // "X32", "SQ", "CL", "TF"
    mainMuted: boolean,
  },
  proPresenter: {
    connected: boolean,
    running: boolean,
  },
  vmix: {
    connected: boolean,
    streaming: boolean,
    recording: boolean,
  },
  resolume: {
    connected: boolean,
  },
  videoHubs: [{
    connected: boolean,
    inputCount: number,
    outputCount: number,
  }],
  hyperdecks: [{
    connected: boolean,
    recording: boolean,
    transport: string,            // "stop", "play", "record"
  }],
  ptz: [{
    ip: string,
    name: string,
    protocol: string,
    connected: boolean,
  }],
  audio: {
    monitoring: boolean,
    lastLevel: number,
    silenceDetected: boolean,
  },
}
```

---

*Generated from codebase analysis. 247 commands across 20 namespaces.*
*Last updated: February 2026*
