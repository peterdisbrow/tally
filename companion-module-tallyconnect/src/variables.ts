import type { CompanionVariableDefinition } from '@companion-module/base'
import type { TallyConnectInstance, TallyState } from './main.js'

/**
 * All variables map to real fields from the church-client status object.
 * @see church-client/src/index.js lines 328-408 (this.status + this.health)
 *
 * Variable values are set from handleStatusUpdate() in main.ts whenever
 * a status_update message arrives from the relay server.
 */
export function getVariableDefinitions(): CompanionVariableDefinition[] {
	return [
		// ── Switcher / Tally ──────────────────────────────────────────────────────
		{ variableId: 'program_input', name: 'Current Program Input Number' },
		{ variableId: 'program_label', name: 'Current Program Input Label' },
		{ variableId: 'preview_input', name: 'Current Preview Input Number' },
		{ variableId: 'preview_label', name: 'Current Preview Input Label' },
		{ variableId: 'atem_model', name: 'ATEM Model Name' },
		{ variableId: 'atem_connected', name: 'ATEM Connected (true/false)' },

		// ── Streaming ─────────────────────────────────────────────────────────────
		{ variableId: 'stream_status', name: 'Stream Status (LIVE/OFFLINE)' },
		{ variableId: 'stream_bitrate', name: 'Stream Bitrate (kbps)' },
		{ variableId: 'encoder_live', name: 'Encoder Live (true/false)' },
		{ variableId: 'encoder_bitrate', name: 'Encoder Bitrate (kbps)' },
		{ variableId: 'encoder_fps', name: 'Encoder FPS' },

		// ── Recording ─────────────────────────────────────────────────────────────
		{ variableId: 'record_status', name: 'Record Status (REC/STOP)' },

		// ── Viewer Counts ─────────────────────────────────────────────────────────
		// Sourced from status.streamVerification (set by relay stream_verification_result)
		{ variableId: 'yt_viewers', name: 'YouTube Viewer Count' },
		{ variableId: 'fb_viewers', name: 'Facebook Viewer Count' },
		{ variableId: 'viewer_count', name: 'Total Viewer Count (YT + FB)' },

		// ── ProPresenter ──────────────────────────────────────────────────────────
		// Sourced from status.proPresenter fields
		{ variableId: 'pp_connected', name: 'ProPresenter Connected (true/false)' },
		{ variableId: 'pp_slide_index', name: 'ProPresenter Current Slide Index' },
		{ variableId: 'pp_slide_total', name: 'ProPresenter Total Slides' },
		{ variableId: 'pp_version', name: 'ProPresenter Version' },

		// ── OBS ───────────────────────────────────────────────────────────────────
		{ variableId: 'obs_connected', name: 'OBS Connected (true/false)' },
		{ variableId: 'obs_streaming', name: 'OBS Streaming (true/false)' },
		{ variableId: 'obs_recording', name: 'OBS Recording (true/false)' },
		{ variableId: 'obs_bitrate', name: 'OBS Bitrate' },
		{ variableId: 'obs_fps', name: 'OBS FPS' },

		// ── vMix ──────────────────────────────────────────────────────────────────
		{ variableId: 'vmix_connected', name: 'vMix Connected (true/false)' },
		{ variableId: 'vmix_streaming', name: 'vMix Streaming (true/false)' },
		{ variableId: 'vmix_recording', name: 'vMix Recording (true/false)' },

		// ── Audio Mixer ───────────────────────────────────────────────────────────
		{ variableId: 'mixer_connected', name: 'Mixer Connected (true/false)' },
		{ variableId: 'mixer_type', name: 'Mixer Type' },
		{ variableId: 'mixer_muted', name: 'Mixer Main Muted (true/false)' },

		// ── System ────────────────────────────────────────────────────────────────
		// Sourced from status.system fields
		{ variableId: 'room_name', name: 'Room Name' },
		{ variableId: 'system_hostname', name: 'System Hostname' },
		{ variableId: 'system_uptime', name: 'System Uptime (seconds)' },

		// ── Health ────────────────────────────────────────────────────────────────
		// Sourced from status.health (included in status_update)
		{ variableId: 'relay_latency', name: 'Relay Latency (ms)' },

		// ── Stream Protection ─────────────────────────────────────────────────────
		{ variableId: 'sp_enabled', name: 'Stream Protection Enabled (true/false)' },
		{ variableId: 'sp_state', name: 'Stream Protection State' },
		{ variableId: 'sp_last_event', name: 'Stream Protection Last Event' },

		// ── Connection ────────────────────────────────────────────────────────────
		{ variableId: 'connection_status', name: 'Module Connection Status' },
		{ variableId: 'church_name', name: 'Church Name' },
	]
}

/**
 * Build the variable values object from the current tally state.
 * Called after every status_update to push new values to Companion.
 */
export function getVariableValues(self: TallyConnectInstance): Record<string, string | number | undefined> {
	const s: TallyState = self.tallyState

	// Resolve input labels from status.atem.inputSources
	const programLabel = s.inputSources[s.programInput ?? -1]?.longName ?? ''
	const previewLabel = s.inputSources[s.previewInput ?? -1]?.longName ?? ''

	// Determine composite streaming state across all sources
	const isLive = s.atemStreaming || s.obsStreaming || s.encoderLive || s.vmixStreaming
	const isRecording = s.atemRecording || s.obsRecording || s.vmixRecording

	// Best available bitrate (prefer encoder, fall back to ATEM, then OBS)
	const bitrate = s.encoderBitrateKbps ?? s.atemStreamingBitrate ?? s.obsBitrate ?? undefined

	// Viewer totals from streamVerification
	const ytViewers = s.ytViewers ?? 0
	const fbViewers = s.fbViewers ?? 0

	return {
		program_input: s.programInput ?? '',
		program_label: programLabel,
		preview_input: s.previewInput ?? '',
		preview_label: previewLabel,
		atem_model: s.atemModel ?? '',
		atem_connected: String(s.deviceConnected.atem ?? false),

		stream_status: isLive ? 'LIVE' : 'OFFLINE',
		stream_bitrate: bitrate ?? '',
		encoder_live: String(s.encoderLive ?? false),
		encoder_bitrate: s.encoderBitrateKbps ?? '',
		encoder_fps: s.encoderFps ?? '',

		record_status: isRecording ? 'REC' : 'STOP',

		yt_viewers: ytViewers,
		fb_viewers: fbViewers,
		viewer_count: ytViewers + fbViewers,

		pp_connected: String(s.deviceConnected.proPresenter ?? false),
		pp_slide_index: s.ppSlideIndex ?? '',
		pp_slide_total: s.ppSlideTotal ?? '',
		pp_version: s.ppVersion ?? '',

		obs_connected: String(s.deviceConnected.obs ?? false),
		obs_streaming: String(s.obsStreaming ?? false),
		obs_recording: String(s.obsRecording ?? false),
		obs_bitrate: s.obsBitrate ?? '',
		obs_fps: s.obsFps ?? '',

		vmix_connected: String(s.deviceConnected.vmix ?? false),
		vmix_streaming: String(s.vmixStreaming ?? false),
		vmix_recording: String(s.vmixRecording ?? false),

		mixer_connected: String(s.deviceConnected.mixer ?? false),
		mixer_type: s.mixerType ?? '',
		mixer_muted: String(s.mixerMainMuted ?? false),

		room_name: s.roomName ?? '',
		system_hostname: s.systemHostname ?? '',
		system_uptime: s.systemUptime ?? '',

		relay_latency: s.relayLatencyMs ?? '',

		sp_enabled: String(s.streamProtectionEnabled ?? false),
		sp_state: s.streamProtectionState ?? 'idle',
		sp_last_event: s.streamProtectionLastEvent ?? '',

		connection_status: self.connectionStatus,
		church_name: self.churchName,
	}
}
