import { combineRgb, type CompanionFeedbackDefinitions } from '@companion-module/base'
import type { TallyConnectInstance } from './main.js'

/**
 * All feedbacks reference real fields from the church-client status object.
 * @see church-client/src/index.js lines 328-390 (this.status initialization)
 *
 * Status field paths used:
 *   status.atem.programInput       — current program input number
 *   status.atem.previewInput       — current preview input number
 *   status.atem.connected          — ATEM connection state
 *   status.atem.streaming          — ATEM streaming state
 *   status.atem.recording          — ATEM recording state
 *   status.atem.inTransition       — mid-transition flag
 *   status.obs.connected           — OBS connection state
 *   status.obs.streaming           — OBS streaming state
 *   status.obs.recording           — OBS recording state
 *   status.encoder.connected       — encoder connection state
 *   status.encoder.live            — encoder live state
 *   status.proPresenter.connected  — ProPresenter connection state
 *   status.vmix.connected          — vMix connection state
 *   status.vmix.streaming          — vMix streaming state
 *   status.vmix.recording          — vMix recording state
 *   status.mixer.connected         — mixer connection state
 *   status.mixer.mainMuted         — mixer main mute state
 *   status.companion.connected     — Companion connection state
 *   status.resolume.connected      — Resolume connection state
 *   status.audio.silenceDetected   — audio silence detection
 */
export function getFeedbacks(self: TallyConnectInstance): CompanionFeedbackDefinitions {
	return {
		// ── Tally ─────────────────────────────────────────────────────────────────

		tally_program: {
			type: 'boolean',
			name: 'Tally: Input on Program',
			description: 'True when the specified input is the current program (live) source',
			defaultStyle: {
				bgcolor: combineRgb(255, 0, 0),
				color: combineRgb(255, 255, 255),
			},
			options: [
				{ id: 'input', type: 'number', label: 'Input Number', default: 1, min: 0, max: 99 },
			],
			callback: (feedback) => {
				return self.tallyState.programInput === Number(feedback.options.input)
			},
		},

		tally_preview: {
			type: 'boolean',
			name: 'Tally: Input on Preview',
			description: 'True when the specified input is the current preview source',
			defaultStyle: {
				bgcolor: combineRgb(0, 255, 0),
				color: combineRgb(0, 0, 0),
			},
			options: [
				{ id: 'input', type: 'number', label: 'Input Number', default: 1, min: 0, max: 99 },
			],
			callback: (feedback) => {
				return self.tallyState.previewInput === Number(feedback.options.input)
			},
		},

		in_transition: {
			type: 'boolean',
			name: 'Tally: In Transition',
			description: 'True when the ATEM is currently mid-transition',
			defaultStyle: {
				bgcolor: combineRgb(255, 191, 0),
				color: combineRgb(0, 0, 0),
			},
			options: [],
			callback: () => {
				return self.tallyState.inTransition === true
			},
		},

		// ── Streaming ─────────────────────────────────────────────────────────────

		stream_live: {
			type: 'boolean',
			name: 'Stream: Live',
			description: 'True when any source is streaming (ATEM, OBS, encoder, or vMix)',
			defaultStyle: {
				bgcolor: combineRgb(255, 0, 0),
				color: combineRgb(255, 255, 255),
			},
			options: [],
			callback: () => {
				const s = self.tallyState
				return s.atemStreaming || s.obsStreaming || s.encoderLive || s.vmixStreaming
			},
		},

		stream_offline: {
			type: 'boolean',
			name: 'Stream: Offline',
			description: 'True when no source is streaming',
			defaultStyle: {
				bgcolor: combineRgb(64, 64, 64),
				color: combineRgb(180, 180, 180),
			},
			options: [],
			callback: () => {
				const s = self.tallyState
				return !s.atemStreaming && !s.obsStreaming && !s.encoderLive && !s.vmixStreaming
			},
		},

		// ── Recording ─────────────────────────────────────────────────────────────

		recording_active: {
			type: 'boolean',
			name: 'Recording: Active',
			description: 'True when any source is recording (ATEM, OBS, or vMix)',
			defaultStyle: {
				bgcolor: combineRgb(255, 0, 0),
				color: combineRgb(255, 255, 255),
			},
			options: [],
			callback: () => {
				const s = self.tallyState
				return s.atemRecording || s.obsRecording || s.vmixRecording
			},
		},

		// ── Device Connection ─────────────────────────────────────────────────────

		device_connected: {
			type: 'boolean',
			name: 'Device: Connected',
			description: 'True when the specified device type is connected',
			defaultStyle: {
				bgcolor: combineRgb(0, 204, 0),
				color: combineRgb(0, 0, 0),
			},
			options: [
				{
					id: 'device',
					type: 'dropdown',
					label: 'Device',
					default: 'atem',
					choices: [
						{ id: 'atem', label: 'ATEM' },
						{ id: 'obs', label: 'OBS' },
						{ id: 'encoder', label: 'Encoder' },
						{ id: 'proPresenter', label: 'ProPresenter' },
						{ id: 'vmix', label: 'vMix' },
						{ id: 'mixer', label: 'Audio Mixer' },
						{ id: 'companion', label: 'Companion' },
						{ id: 'resolume', label: 'Resolume' },
					],
				},
			],
			callback: (feedback) => {
				const device = String(feedback.options.device)
				return self.tallyState.deviceConnected[device] === true
			},
		},

		device_disconnected: {
			type: 'boolean',
			name: 'Device: Disconnected',
			description: 'True when the specified device type is NOT connected',
			defaultStyle: {
				bgcolor: combineRgb(255, 0, 0),
				color: combineRgb(255, 255, 255),
			},
			options: [
				{
					id: 'device',
					type: 'dropdown',
					label: 'Device',
					default: 'atem',
					choices: [
						{ id: 'atem', label: 'ATEM' },
						{ id: 'obs', label: 'OBS' },
						{ id: 'encoder', label: 'Encoder' },
						{ id: 'proPresenter', label: 'ProPresenter' },
						{ id: 'vmix', label: 'vMix' },
						{ id: 'mixer', label: 'Audio Mixer' },
						{ id: 'companion', label: 'Companion' },
						{ id: 'resolume', label: 'Resolume' },
					],
				},
			],
			callback: (feedback) => {
				const device = String(feedback.options.device)
				return self.tallyState.deviceConnected[device] !== true
			},
		},

		// ── Audio ─────────────────────────────────────────────────────────────────

		audio_muted: {
			type: 'boolean',
			name: 'Audio: Main Muted',
			description: 'True when the mixer main output is muted (status.mixer.mainMuted)',
			defaultStyle: {
				bgcolor: combineRgb(255, 0, 0),
				color: combineRgb(255, 255, 255),
			},
			options: [],
			callback: () => {
				return self.tallyState.mixerMainMuted === true
			},
		},

		audio_silence: {
			type: 'boolean',
			name: 'Audio: Silence Detected',
			description: 'True when audio silence is detected (status.audio.silenceDetected)',
			defaultStyle: {
				bgcolor: combineRgb(255, 191, 0),
				color: combineRgb(0, 0, 0),
			},
			options: [],
			callback: () => {
				return self.tallyState.audioSilence === true
			},
		},

		// ── Stream Protection ────────────────────────────────────────────────────

		stream_protection_active: {
			type: 'boolean',
			name: 'Stream Protection: Active',
			description: 'True when stream protection is enabled and actively protecting a live stream',
			defaultStyle: {
				bgcolor: combineRgb(0, 128, 0),
				color: combineRgb(255, 255, 255),
			},
			options: [],
			callback: () => {
				return self.tallyState.streamProtectionEnabled === true && self.tallyState.streamProtectionState === 'protecting'
			},
		},

		stream_protection_alert: {
			type: 'boolean',
			name: 'Stream Protection: Alert',
			description: 'True when stream protection has detected an issue (encoder down, alert sent, CDN issue)',
			defaultStyle: {
				bgcolor: combineRgb(255, 191, 0),
				color: combineRgb(0, 0, 0),
			},
			options: [],
			callback: () => {
				const st = self.tallyState.streamProtectionState
				return st === 'encoder_disconnected' || st === 'alert_sent' || st === 'restarting' || st === 'cdn_mismatch'
			},
		},

		cdn_health_ok: {
			type: 'boolean',
			name: 'CDN Health: Healthy',
			description: 'True when CDN confirms the stream is reaching viewers',
			defaultStyle: {
				bgcolor: combineRgb(0, 128, 0),
				color: combineRgb(255, 255, 255),
			},
			options: [],
			callback: () => {
				return self.tallyState.streamProtectionCdnHealth === 'healthy'
			},
		},

		cdn_health_mismatch: {
			type: 'boolean',
			name: 'CDN Health: Mismatch',
			description: 'True when CDN reports the stream is NOT reaching viewers despite encoder being active',
			defaultStyle: {
				bgcolor: combineRgb(255, 191, 0),
				color: combineRgb(0, 0, 0),
			},
			options: [],
			callback: () => {
				return self.tallyState.streamProtectionCdnHealth === 'mismatch'
			},
		},

		// ── Rundown ───────────────────────────────────────────────────────────────
		// @see relay-server/src/liveRundown.js

		rundown_active: {
			type: 'boolean',
			name: 'Rundown: Session Active',
			description: 'True when a live rundown session is currently active',
			defaultStyle: {
				bgcolor: combineRgb(0, 204, 0),
				color: combineRgb(0, 0, 0),
			},
			options: [],
			callback: () => {
				return self.rundownState.active === true
			},
		},

		rundown_warning: {
			type: 'boolean',
			name: 'Rundown: Warning',
			description: 'True when the current item has 30 seconds or less remaining',
			defaultStyle: {
				bgcolor: combineRgb(255, 191, 0),
				color: combineRgb(0, 0, 0),
			},
			options: [],
			callback: () => {
				return self.rundownState.isWarning === true
			},
		},

		rundown_overtime: {
			type: 'boolean',
			name: 'Rundown: Overtime',
			description: 'True when the current item has exceeded its planned duration',
			defaultStyle: {
				bgcolor: combineRgb(255, 0, 0),
				color: combineRgb(255, 255, 255),
			},
			options: [],
			callback: () => {
				return self.rundownState.isOvertime === true
			},
		},

		rundown_ahead: {
			type: 'boolean',
			name: 'Rundown: Ahead of Schedule',
			description: 'True when the service is running ahead of the planned schedule',
			defaultStyle: {
				bgcolor: combineRgb(0, 102, 204),
				color: combineRgb(255, 255, 255),
			},
			options: [],
			callback: () => {
				return self.rundownState.isAhead === true
			},
		},

		rundown_behind: {
			type: 'boolean',
			name: 'Rundown: Behind Schedule',
			description: 'True when the service is running behind the planned schedule',
			defaultStyle: {
				bgcolor: combineRgb(255, 0, 0),
				color: combineRgb(255, 255, 255),
			},
			options: [],
			callback: () => {
				return self.rundownState.isBehind === true
			},
		},

		rundown_on_time: {
			type: 'boolean',
			name: 'Rundown: On Time',
			description: 'True when the service is within 15 seconds of the planned schedule',
			defaultStyle: {
				bgcolor: combineRgb(0, 204, 0),
				color: combineRgb(0, 0, 0),
			},
			options: [],
			callback: () => {
				return self.rundownState.isOnTime === true
			},
		},
	}
}
