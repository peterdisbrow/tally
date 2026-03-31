import { combineRgb, type CompanionPresetDefinitions } from '@companion-module/base'

/**
 * Pre-built button configurations for common Tally Connect operations.
 * All actionId values reference real action IDs from actions.ts.
 * All feedbackId values reference real feedback IDs from feedbacks.ts.
 * All variable references use real variableIds from variables.ts.
 */
export function getPresets(): CompanionPresetDefinitions {
	const presets: CompanionPresetDefinitions = {}

	// ── Camera Switching: Program (CAM 1-8) ───────────────────────────────────
	for (let i = 1; i <= 8; i++) {
		presets[`cam_pgm_${i}`] = {
			type: 'button',
			category: 'Camera Switching',
			name: `CAM ${i} Program`,
			style: {
				text: `CAM ${i}`,
				size: 'auto',
				color: combineRgb(255, 255, 255),
				bgcolor: combineRgb(0, 0, 0),
			},
			steps: [
				{
					down: [{ actionId: 'switch_program', options: { input: i, me: 0, switcherId: '' } }],
					up: [],
				},
			],
			feedbacks: [
				{
					feedbackId: 'tally_program',
					options: { input: i },
					style: { bgcolor: combineRgb(255, 0, 0), color: combineRgb(255, 255, 255) },
				},
				{
					feedbackId: 'tally_preview',
					options: { input: i },
					style: { bgcolor: combineRgb(0, 255, 0), color: combineRgb(0, 0, 0) },
				},
			],
		}
	}

	// ── Camera Switching: Preview (PVW 1-8) ───────────────────────────────────
	for (let i = 1; i <= 8; i++) {
		presets[`cam_pvw_${i}`] = {
			type: 'button',
			category: 'Camera Switching',
			name: `PVW ${i}`,
			style: {
				text: `PVW ${i}`,
				size: 'auto',
				color: combineRgb(255, 255, 255),
				bgcolor: combineRgb(0, 0, 0),
			},
			steps: [
				{
					down: [{ actionId: 'switch_preview', options: { input: i, me: 0, switcherId: '' } }],
					up: [],
				},
			],
			feedbacks: [
				{
					feedbackId: 'tally_preview',
					options: { input: i },
					style: { bgcolor: combineRgb(0, 255, 0), color: combineRgb(0, 0, 0) },
				},
			],
		}
	}

	// ── Transport ─────────────────────────────────────────────────────────────

	presets['cut'] = {
		type: 'button',
		category: 'Transport',
		name: 'CUT',
		style: {
			text: 'CUT',
			size: 'auto',
			color: combineRgb(255, 255, 255),
			bgcolor: combineRgb(0, 0, 0),
		},
		steps: [{ down: [{ actionId: 'cut', options: { me: 0, switcherId: '' } }], up: [] }],
		feedbacks: [
			{
				feedbackId: 'in_transition',
				options: {},
				style: { bgcolor: combineRgb(255, 191, 0) },
			},
		],
	}

	presets['auto'] = {
		type: 'button',
		category: 'Transport',
		name: 'AUTO',
		style: {
			text: 'AUTO',
			size: 'auto',
			color: combineRgb(255, 255, 255),
			bgcolor: combineRgb(0, 0, 0),
		},
		steps: [{ down: [{ actionId: 'auto_transition', options: { me: 0, switcherId: '' } }], up: [] }],
		feedbacks: [
			{
				feedbackId: 'in_transition',
				options: {},
				style: { bgcolor: combineRgb(255, 191, 0) },
			},
		],
	}

	presets['ftb'] = {
		type: 'button',
		category: 'Transport',
		name: 'FTB',
		style: {
			text: 'FTB',
			size: 'auto',
			color: combineRgb(255, 255, 255),
			bgcolor: combineRgb(51, 51, 51),
		},
		steps: [{ down: [{ actionId: 'fade_to_black', options: { me: 0 } }], up: [] }],
		feedbacks: [],
	}

	// ── Streaming ─────────────────────────────────────────────────────────────

	presets['go_live'] = {
		type: 'button',
		category: 'Streaming',
		name: 'GO LIVE',
		style: {
			text: 'GO\\nLIVE',
			size: 'auto',
			color: combineRgb(255, 255, 255),
			bgcolor: combineRgb(0, 0, 0),
		},
		steps: [{ down: [{ actionId: 'encoder_start_stream', options: {} }], up: [] }],
		feedbacks: [
			{
				feedbackId: 'stream_live',
				options: {},
				style: { bgcolor: combineRgb(255, 0, 0), color: combineRgb(255, 255, 255) },
			},
		],
	}

	presets['stop_stream'] = {
		type: 'button',
		category: 'Streaming',
		name: 'STOP STREAM',
		style: {
			text: 'STOP\\nSTREAM',
			size: 'auto',
			color: combineRgb(255, 255, 255),
			bgcolor: combineRgb(51, 51, 51),
		},
		steps: [{ down: [{ actionId: 'encoder_stop_stream', options: {} }], up: [] }],
		feedbacks: [
			{
				feedbackId: 'stream_offline',
				options: {},
				style: { bgcolor: combineRgb(64, 64, 64) },
			},
		],
	}

	presets['stream_status'] = {
		type: 'button',
		category: 'Streaming',
		name: 'Stream Status',
		style: {
			text: '$(tallyconnect:stream_status)\\n$(tallyconnect:stream_bitrate)k',
			size: 'auto',
			color: combineRgb(255, 255, 255),
			bgcolor: combineRgb(0, 0, 0),
		},
		steps: [],
		feedbacks: [
			{
				feedbackId: 'stream_live',
				options: {},
				style: { bgcolor: combineRgb(255, 0, 0) },
			},
		],
	}

	presets['viewers'] = {
		type: 'button',
		category: 'Streaming',
		name: 'Viewers',
		style: {
			text: 'VIEWERS\\n$(tallyconnect:viewer_count)',
			size: 'auto',
			color: combineRgb(255, 255, 255),
			bgcolor: combineRgb(0, 0, 0),
		},
		steps: [],
		feedbacks: [],
	}

	// ── Recording ─────────────────────────────────────────────────────────────

	presets['record'] = {
		type: 'button',
		category: 'Recording',
		name: 'Record',
		style: {
			text: 'REC\\n$(tallyconnect:record_status)',
			size: 'auto',
			color: combineRgb(255, 255, 255),
			bgcolor: combineRgb(0, 0, 0),
		},
		steps: [{ down: [{ actionId: 'atem_start_recording', options: {} }], up: [] }],
		feedbacks: [
			{
				feedbackId: 'recording_active',
				options: {},
				style: { bgcolor: combineRgb(255, 0, 0), color: combineRgb(255, 255, 255) },
			},
		],
	}

	// ── ProPresenter ──────────────────────────────────────────────────────────

	presets['pp_next'] = {
		type: 'button',
		category: 'ProPresenter',
		name: 'Next Slide',
		style: {
			text: 'NEXT\\n$(tallyconnect:pp_slide_index)/$(tallyconnect:pp_slide_total)',
			size: 'auto',
			color: combineRgb(255, 255, 255),
			bgcolor: combineRgb(0, 51, 102),
		},
		steps: [{ down: [{ actionId: 'pp_next', options: {} }], up: [] }],
		feedbacks: [],
	}

	presets['pp_prev'] = {
		type: 'button',
		category: 'ProPresenter',
		name: 'Previous Slide',
		style: {
			text: 'PREV',
			size: 'auto',
			color: combineRgb(255, 255, 255),
			bgcolor: combineRgb(0, 51, 102),
		},
		steps: [{ down: [{ actionId: 'pp_previous', options: {} }], up: [] }],
		feedbacks: [],
	}

	presets['pp_clear'] = {
		type: 'button',
		category: 'ProPresenter',
		name: 'Clear All',
		style: {
			text: 'CLEAR\\nALL',
			size: 'auto',
			color: combineRgb(255, 255, 255),
			bgcolor: combineRgb(102, 0, 0),
		},
		steps: [{ down: [{ actionId: 'pp_clear_all', options: {} }], up: [] }],
		feedbacks: [],
	}

	// ── Device Status ─────────────────────────────────────────────────────────

	presets['atem_status'] = {
		type: 'button',
		category: 'Device Status',
		name: 'ATEM Status',
		style: {
			text: 'ATEM\\n$(tallyconnect:atem_model)',
			size: 'auto',
			color: combineRgb(255, 255, 255),
			bgcolor: combineRgb(0, 0, 0),
		},
		steps: [],
		feedbacks: [
			{
				feedbackId: 'device_connected',
				options: { device: 'atem' },
				style: { bgcolor: combineRgb(0, 153, 0) },
			},
			{
				feedbackId: 'device_disconnected',
				options: { device: 'atem' },
				style: { bgcolor: combineRgb(153, 0, 0) },
			},
		],
	}

	presets['obs_status'] = {
		type: 'button',
		category: 'Device Status',
		name: 'OBS Status',
		style: {
			text: 'OBS',
			size: 'auto',
			color: combineRgb(255, 255, 255),
			bgcolor: combineRgb(0, 0, 0),
		},
		steps: [],
		feedbacks: [
			{
				feedbackId: 'device_connected',
				options: { device: 'obs' },
				style: { bgcolor: combineRgb(0, 153, 0) },
			},
			{
				feedbackId: 'device_disconnected',
				options: { device: 'obs' },
				style: { bgcolor: combineRgb(153, 0, 0) },
			},
		],
	}

	presets['pp_status'] = {
		type: 'button',
		category: 'Device Status',
		name: 'ProPresenter Status',
		style: {
			text: 'ProP',
			size: 'auto',
			color: combineRgb(255, 255, 255),
			bgcolor: combineRgb(0, 0, 0),
		},
		steps: [],
		feedbacks: [
			{
				feedbackId: 'device_connected',
				options: { device: 'proPresenter' },
				style: { bgcolor: combineRgb(0, 153, 0) },
			},
			{
				feedbackId: 'device_disconnected',
				options: { device: 'proPresenter' },
				style: { bgcolor: combineRgb(153, 0, 0) },
			},
		],
	}

	// ── Audio ─────────────────────────────────────────────────────────────────

	presets['mixer_mute'] = {
		type: 'button',
		category: 'Audio',
		name: 'Mute Main',
		style: {
			text: 'MUTE\\nMAIN',
			size: 'auto',
			color: combineRgb(255, 255, 255),
			bgcolor: combineRgb(0, 0, 0),
		},
		steps: [{ down: [{ actionId: 'mixer_mute', options: { channel: 'lr' } }], up: [] }],
		feedbacks: [
			{
				feedbackId: 'audio_muted',
				options: {},
				style: { bgcolor: combineRgb(255, 0, 0), color: combineRgb(255, 255, 255) },
			},
		],
	}

	presets['mixer_unmute'] = {
		type: 'button',
		category: 'Audio',
		name: 'Unmute Main',
		style: {
			text: 'UNMUTE\\nMAIN',
			size: 'auto',
			color: combineRgb(255, 255, 255),
			bgcolor: combineRgb(51, 51, 51),
		},
		steps: [{ down: [{ actionId: 'mixer_unmute', options: { channel: 'lr' } }], up: [] }],
		feedbacks: [],
	}

	// ── Safety / Recovery ─────────────────────────────────────────────────────

	presets['failover_backup'] = {
		type: 'button',
		category: 'Safety',
		name: 'Failover to Backup',
		style: {
			text: 'FAIL\\nOVER',
			size: 'auto',
			color: combineRgb(255, 255, 255),
			bgcolor: combineRgb(153, 0, 0),
		},
		steps: [{ down: [{ actionId: 'failover_to_backup', options: {} }], up: [] }],
		feedbacks: [],
	}

	presets['restart_stream'] = {
		type: 'button',
		category: 'Safety',
		name: 'Restart Stream',
		style: {
			text: 'RESTART\\nSTREAM',
			size: 'auto',
			color: combineRgb(255, 255, 255),
			bgcolor: combineRgb(153, 102, 0),
		},
		steps: [{ down: [{ actionId: 'recovery_restart_stream', options: { source: '' } }], up: [] }],
		feedbacks: [],
	}

	return presets
}
