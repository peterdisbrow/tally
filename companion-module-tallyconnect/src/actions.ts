import type { CompanionActionDefinitions } from '@companion-module/base'
import type { TallyConnectInstance } from './main.js'

/**
 * All action IDs map to real command strings in church-client/src/commands/.
 * The sendCommand() method wraps them in the controller WebSocket message format:
 *   { type: 'command', churchId, command, params, instance? }
 *
 * @see relay-server/src/websocketRouter.js handleControllerMessage()
 */
export function getActions(self: TallyConnectInstance): CompanionActionDefinitions {
	return {
		// ── Switcher (ATEM / multi-switcher) ──────────────────────────────────────

		switch_program: {
			name: 'Set Program Input',
			description: 'Switch the program (live) input on the ATEM or active switcher',
			options: [
				{ id: 'input', type: 'number', label: 'Input Number', default: 1, min: 0, max: 99 },
				{ id: 'me', type: 'number', label: 'M/E Bus', default: 0, min: 0, max: 3 },
				{ id: 'switcherId', type: 'textinput', label: 'Switcher ID (optional)', default: '' },
			],
			callback: async (action) => {
				const switcherId = String(action.options.switcherId || '').trim()
				if (switcherId) {
					self.sendCommand('switcher.setProgram', {
						input: Number(action.options.input),
						me: Number(action.options.me),
						switcherId,
					})
				} else {
					self.sendCommand('atem.setProgram', {
						input: Number(action.options.input),
						me: Number(action.options.me),
					})
				}
			},
		},

		switch_preview: {
			name: 'Set Preview Input',
			description: 'Switch the preview input on the ATEM or active switcher',
			options: [
				{ id: 'input', type: 'number', label: 'Input Number', default: 1, min: 0, max: 99 },
				{ id: 'me', type: 'number', label: 'M/E Bus', default: 0, min: 0, max: 3 },
				{ id: 'switcherId', type: 'textinput', label: 'Switcher ID (optional)', default: '' },
			],
			callback: async (action) => {
				const switcherId = String(action.options.switcherId || '').trim()
				if (switcherId) {
					self.sendCommand('switcher.setPreview', {
						input: Number(action.options.input),
						me: Number(action.options.me),
						switcherId,
					})
				} else {
					self.sendCommand('atem.setPreview', {
						input: Number(action.options.input),
						me: Number(action.options.me),
					})
				}
			},
		},

		cut: {
			name: 'Cut',
			description: 'Hard cut between preview and program',
			options: [
				{ id: 'me', type: 'number', label: 'M/E Bus', default: 0, min: 0, max: 3 },
				{ id: 'switcherId', type: 'textinput', label: 'Switcher ID (optional)', default: '' },
			],
			callback: async (action) => {
				const switcherId = String(action.options.switcherId || '').trim()
				if (switcherId) {
					self.sendCommand('switcher.cut', { me: Number(action.options.me), switcherId })
				} else {
					self.sendCommand('atem.cut', { me: Number(action.options.me) })
				}
			},
		},

		auto_transition: {
			name: 'Auto Transition',
			description: 'Execute auto transition on the ATEM',
			options: [
				{ id: 'me', type: 'number', label: 'M/E Bus', default: 0, min: 0, max: 3 },
				{ id: 'switcherId', type: 'textinput', label: 'Switcher ID (optional)', default: '' },
			],
			callback: async (action) => {
				const switcherId = String(action.options.switcherId || '').trim()
				if (switcherId) {
					self.sendCommand('switcher.auto', { me: Number(action.options.me), switcherId })
				} else {
					self.sendCommand('atem.auto', { me: Number(action.options.me) })
				}
			},
		},

		fade_to_black: {
			name: 'Fade to Black',
			description: 'Toggle Fade to Black on the ATEM',
			options: [
				{ id: 'me', type: 'number', label: 'M/E Bus', default: 0, min: 0, max: 3 },
			],
			callback: async (action) => {
				self.sendCommand('atem.fadeToBlack', { me: Number(action.options.me) })
			},
		},

		set_aux: {
			name: 'Set AUX Output',
			description: 'Route an input to an AUX output on the ATEM',
			options: [
				{ id: 'output', type: 'number', label: 'AUX Output', default: 0, min: 0, max: 23 },
				{ id: 'input', type: 'number', label: 'Input Source', default: 1, min: 0, max: 99 },
				{ id: 'switcherId', type: 'textinput', label: 'Switcher ID (optional)', default: '' },
			],
			callback: async (action) => {
				self.sendCommand('atem.setAux', {
					output: Number(action.options.output),
					input: Number(action.options.input),
					switcherId: String(action.options.switcherId || '').trim() || undefined,
				})
			},
		},

		set_usk_on_air: {
			name: 'Set USK On Air',
			description: 'Toggle an upstream key on/off air',
			options: [
				{ id: 'key', type: 'number', label: 'Key Index', default: 0, min: 0, max: 3 },
				{ id: 'onAir', type: 'checkbox', label: 'On Air', default: true },
				{ id: 'me', type: 'number', label: 'M/E Bus', default: 0, min: 0, max: 3 },
			],
			callback: async (action) => {
				self.sendCommand('atem.setUskOnAir', {
					key: Number(action.options.key),
					onAir: !!action.options.onAir,
					me: Number(action.options.me),
				})
			},
		},

		set_dsk_on_air: {
			name: 'Set DSK On Air',
			description: 'Toggle a downstream key on/off air',
			options: [
				{ id: 'key', type: 'number', label: 'DSK Index', default: 0, min: 0, max: 3 },
				{ id: 'onAir', type: 'checkbox', label: 'On Air', default: true },
			],
			callback: async (action) => {
				self.sendCommand('atem.setDskOnAir', {
					key: Number(action.options.key),
					onAir: !!action.options.onAir,
				})
			},
		},

		run_macro: {
			name: 'Run ATEM Macro',
			description: 'Run a macro by ID on the ATEM',
			options: [
				{ id: 'id', type: 'number', label: 'Macro ID', default: 0, min: 0, max: 99 },
			],
			callback: async (action) => {
				self.sendCommand('atem.runMacro', { id: Number(action.options.id) })
			},
		},

		// ── Stream / Record ───────────────────────────────────────────────────────

		atem_start_stream: {
			name: 'ATEM: Start Streaming',
			description: 'Start streaming on the ATEM',
			options: [],
			callback: async () => {
				self.sendCommand('atem.startStreaming', {})
			},
		},

		atem_stop_stream: {
			name: 'ATEM: Stop Streaming',
			description: 'Stop streaming on the ATEM',
			options: [],
			callback: async () => {
				self.sendCommand('atem.stopStreaming', {})
			},
		},

		atem_start_recording: {
			name: 'ATEM: Start Recording',
			description: 'Start recording on the ATEM',
			options: [],
			callback: async () => {
				self.sendCommand('atem.startRecording', {})
			},
		},

		atem_stop_recording: {
			name: 'ATEM: Stop Recording',
			description: 'Stop recording on the ATEM',
			options: [],
			callback: async () => {
				self.sendCommand('atem.stopRecording', {})
			},
		},

		obs_start_stream: {
			name: 'OBS: Start Streaming',
			description: 'Start streaming via OBS',
			options: [],
			callback: async () => {
				self.sendCommand('obs.startStream', {})
			},
		},

		obs_stop_stream: {
			name: 'OBS: Stop Streaming',
			description: 'Stop streaming via OBS',
			options: [],
			callback: async () => {
				self.sendCommand('obs.stopStream', {})
			},
		},

		obs_toggle_stream: {
			name: 'OBS: Toggle Stream',
			description: 'Toggle streaming on/off via OBS',
			options: [],
			callback: async () => {
				self.sendCommand('obs.toggleStream', {})
			},
		},

		obs_start_recording: {
			name: 'OBS: Start Recording',
			description: 'Start recording via OBS',
			options: [],
			callback: async () => {
				self.sendCommand('obs.startRecording', {})
			},
		},

		obs_stop_recording: {
			name: 'OBS: Stop Recording',
			description: 'Stop recording via OBS',
			options: [],
			callback: async () => {
				self.sendCommand('obs.stopRecording', {})
			},
		},

		encoder_start_stream: {
			name: 'Encoder: Start Streaming',
			description: 'Start streaming on the configured encoder',
			options: [],
			callback: async () => {
				self.sendCommand('encoder.startStream', {})
			},
		},

		encoder_stop_stream: {
			name: 'Encoder: Stop Streaming',
			description: 'Stop streaming on the configured encoder',
			options: [],
			callback: async () => {
				self.sendCommand('encoder.stopStream', {})
			},
		},

		encoder_start_recording: {
			name: 'Encoder: Start Recording',
			description: 'Start recording on the configured encoder',
			options: [],
			callback: async () => {
				self.sendCommand('encoder.startRecording', {})
			},
		},

		encoder_stop_recording: {
			name: 'Encoder: Stop Recording',
			description: 'Stop recording on the configured encoder',
			options: [],
			callback: async () => {
				self.sendCommand('encoder.stopRecording', {})
			},
		},

		// ── ProPresenter ──────────────────────────────────────────────────────────

		pp_next: {
			name: 'ProPresenter: Next Slide',
			description: 'Advance to the next slide in ProPresenter',
			options: [],
			callback: async () => {
				self.sendCommand('propresenter.next', {})
			},
		},

		pp_previous: {
			name: 'ProPresenter: Previous Slide',
			description: 'Go back to the previous slide in ProPresenter',
			options: [],
			callback: async () => {
				self.sendCommand('propresenter.previous', {})
			},
		},

		pp_goto_slide: {
			name: 'ProPresenter: Go To Slide',
			description: 'Jump to a specific slide index in ProPresenter',
			options: [
				{ id: 'index', type: 'number', label: 'Slide Index', default: 0, min: 0, max: 999 },
			],
			callback: async (action) => {
				self.sendCommand('propresenter.goToSlide', { index: Number(action.options.index) })
			},
		},

		pp_trigger_presentation: {
			name: 'ProPresenter: Trigger Presentation',
			description: 'Trigger a presentation by name or UUID',
			options: [
				{ id: 'name', type: 'textinput', label: 'Presentation Name', default: '', useVariables: true },
			],
			callback: async (action, context) => {
				const name = await context.parseVariablesInString(String(action.options.name))
				self.sendCommand('propresenter.triggerPresentation', { name })
			},
		},

		pp_clear_all: {
			name: 'ProPresenter: Clear All',
			description: 'Clear all layers in ProPresenter',
			options: [],
			callback: async () => {
				self.sendCommand('propresenter.clearAll', {})
			},
		},

		pp_clear_slide: {
			name: 'ProPresenter: Clear Slide',
			description: 'Clear the slide layer in ProPresenter',
			options: [],
			callback: async () => {
				self.sendCommand('propresenter.clearSlide', {})
			},
		},

		pp_clear_media: {
			name: 'ProPresenter: Clear Media',
			description: 'Clear the media layer in ProPresenter',
			options: [],
			callback: async () => {
				self.sendCommand('propresenter.clearMedia', {})
			},
		},

		pp_start_timer: {
			name: 'ProPresenter: Start Timer',
			description: 'Start a timer by name in ProPresenter',
			options: [
				{ id: 'name', type: 'textinput', label: 'Timer Name', default: '', useVariables: true },
			],
			callback: async (action, context) => {
				const name = await context.parseVariablesInString(String(action.options.name))
				self.sendCommand('propresenter.startTimer', { name })
			},
		},

		pp_stop_timer: {
			name: 'ProPresenter: Stop Timer',
			description: 'Stop a timer by name in ProPresenter',
			options: [
				{ id: 'name', type: 'textinput', label: 'Timer Name', default: '', useVariables: true },
			],
			callback: async (action, context) => {
				const name = await context.parseVariablesInString(String(action.options.name))
				self.sendCommand('propresenter.stopTimer', { name })
			},
		},

		pp_trigger_macro: {
			name: 'ProPresenter: Trigger Macro',
			description: 'Trigger a macro by name in ProPresenter',
			options: [
				{ id: 'name', type: 'textinput', label: 'Macro Name', default: '', useVariables: true },
			],
			callback: async (action, context) => {
				const name = await context.parseVariablesInString(String(action.options.name))
				self.sendCommand('propresenter.triggerMacro', { name })
			},
		},

		pp_set_look: {
			name: 'ProPresenter: Set Look',
			description: 'Activate a look by name in ProPresenter',
			options: [
				{ id: 'name', type: 'textinput', label: 'Look Name', default: '', useVariables: true },
			],
			callback: async (action, context) => {
				const name = await context.parseVariablesInString(String(action.options.name))
				self.sendCommand('propresenter.setLook', { name })
			},
		},

		// ── Audio Mixer ───────────────────────────────────────────────────────────

		mixer_mute: {
			name: 'Mixer: Mute Channel',
			description: 'Mute a channel on the audio mixer',
			options: [
				{ id: 'channel', type: 'textinput', label: 'Channel (e.g. lr, 1, aux1)', default: 'lr' },
			],
			callback: async (action) => {
				self.sendCommand('mixer.mute', { channel: String(action.options.channel) })
			},
		},

		mixer_unmute: {
			name: 'Mixer: Unmute Channel',
			description: 'Unmute a channel on the audio mixer',
			options: [
				{ id: 'channel', type: 'textinput', label: 'Channel (e.g. lr, 1, aux1)', default: 'lr' },
			],
			callback: async (action) => {
				self.sendCommand('mixer.unmute', { channel: String(action.options.channel) })
			},
		},

		mixer_set_fader: {
			name: 'Mixer: Set Fader Level',
			description: 'Set the fader level for a mixer channel',
			options: [
				{ id: 'channel', type: 'textinput', label: 'Channel', default: 'lr' },
				{ id: 'level', type: 'number', label: 'Level (0-100)', default: 75, min: 0, max: 100 },
			],
			callback: async (action) => {
				self.sendCommand('mixer.setFader', {
					channel: String(action.options.channel),
					level: Number(action.options.level),
				})
			},
		},

		mixer_recall_scene: {
			name: 'Mixer: Recall Scene',
			description: 'Recall a scene/snapshot on the audio mixer',
			options: [
				{ id: 'scene', type: 'textinput', label: 'Scene Name or Number', default: '', useVariables: true },
			],
			callback: async (action, context) => {
				const scene = await context.parseVariablesInString(String(action.options.scene))
				self.sendCommand('mixer.recallScene', { scene })
			},
		},

		// ── OBS Scene Switching ───────────────────────────────────────────────────

		obs_set_preview_scene: {
			name: 'OBS: Set Preview Scene',
			description: 'Set the preview scene in OBS Studio Mode',
			options: [
				{ id: 'scene', type: 'textinput', label: 'Scene Name', default: '', useVariables: true },
			],
			callback: async (action, context) => {
				const scene = await context.parseVariablesInString(String(action.options.scene))
				self.sendCommand('obs.setPreviewScene', { scene })
			},
		},

		obs_trigger_transition: {
			name: 'OBS: Trigger Transition',
			description: 'Trigger the current transition in OBS',
			options: [],
			callback: async () => {
				self.sendCommand('obs.triggerTransition', {})
			},
		},

		obs_toggle_input_mute: {
			name: 'OBS: Toggle Input Mute',
			description: 'Toggle mute for an OBS audio input',
			options: [
				{ id: 'name', type: 'textinput', label: 'Input Name', default: '', useVariables: true },
			],
			callback: async (action, context) => {
				const name = await context.parseVariablesInString(String(action.options.name))
				self.sendCommand('obs.toggleInputMute', { name })
			},
		},

		// ── vMix ──────────────────────────────────────────────────────────────────

		vmix_cut: {
			name: 'vMix: Cut',
			description: 'Hard cut in vMix',
			options: [],
			callback: async () => {
				self.sendCommand('vmix.cut', {})
			},
		},

		vmix_fade_to_black: {
			name: 'vMix: Fade to Black',
			description: 'Fade to black in vMix',
			options: [],
			callback: async () => {
				self.sendCommand('vmix.fadeToBlack', {})
			},
		},

		vmix_set_program: {
			name: 'vMix: Set Program',
			description: 'Set the program input in vMix',
			options: [
				{ id: 'input', type: 'textinput', label: 'Input (number or name)', default: '1' },
			],
			callback: async (action) => {
				self.sendCommand('vmix.setProgram', { input: String(action.options.input) })
			},
		},

		vmix_set_preview: {
			name: 'vMix: Set Preview',
			description: 'Set the preview input in vMix',
			options: [
				{ id: 'input', type: 'textinput', label: 'Input (number or name)', default: '1' },
			],
			callback: async (action) => {
				self.sendCommand('vmix.setPreview', { input: String(action.options.input) })
			},
		},

		// ── PTZ Cameras ───────────────────────────────────────────────────────────

		ptz_preset: {
			name: 'PTZ: Recall Preset',
			description: 'Recall a PTZ camera preset',
			options: [
				{ id: 'camera', type: 'number', label: 'Camera Index', default: 0, min: 0, max: 15 },
				{ id: 'preset', type: 'number', label: 'Preset Number', default: 1, min: 0, max: 255 },
			],
			callback: async (action) => {
				self.sendCommand('ptz.preset', {
					camera: Number(action.options.camera),
					preset: Number(action.options.preset),
				})
			},
		},

		ptz_home: {
			name: 'PTZ: Home Position',
			description: 'Move PTZ camera to home position',
			options: [
				{ id: 'camera', type: 'number', label: 'Camera Index', default: 0, min: 0, max: 15 },
			],
			callback: async (action) => {
				self.sendCommand('ptz.home', { camera: Number(action.options.camera) })
			},
		},

		// ── Companion Bridge ──────────────────────────────────────────────────────

		companion_press: {
			name: 'Companion: Press Button',
			description: 'Press a button on the remote Companion instance via Tally Connect',
			options: [
				{ id: 'page', type: 'number', label: 'Page', default: 1, min: 1, max: 99 },
				{ id: 'row', type: 'number', label: 'Row', default: 0, min: 0, max: 31 },
				{ id: 'col', type: 'number', label: 'Column', default: 0, min: 0, max: 31 },
			],
			callback: async (action) => {
				self.sendCommand('companion.press', {
					page: Number(action.options.page),
					row: Number(action.options.row),
					col: Number(action.options.col),
				})
			},
		},

		companion_press_named: {
			name: 'Companion: Press Named Button',
			description: 'Press a Companion button by its label text',
			options: [
				{ id: 'name', type: 'textinput', label: 'Button Label', default: '', useVariables: true },
			],
			callback: async (action, context) => {
				const name = await context.parseVariablesInString(String(action.options.name))
				self.sendCommand('companion.pressNamed', { name })
			},
		},

		// ── Recovery ──────────────────────────────────────────────────────────────

		recovery_restart_stream: {
			name: 'Recovery: Restart Stream',
			description: 'Stop and restart the active stream',
			options: [
				{
					id: 'source',
					type: 'dropdown',
					label: 'Source',
					default: '',
					choices: [
						{ id: '', label: 'Auto-detect' },
						{ id: 'atem', label: 'ATEM' },
						{ id: 'obs', label: 'OBS' },
						{ id: 'encoder', label: 'Encoder' },
					],
				},
			],
			callback: async (action) => {
				self.sendCommand('recovery.restartStream', {
					source: String(action.options.source || ''),
				})
			},
		},

		recovery_restart_recording: {
			name: 'Recovery: Restart Recording',
			description: 'Stop and restart recording',
			options: [
				{
					id: 'source',
					type: 'dropdown',
					label: 'Source',
					default: '',
					choices: [
						{ id: '', label: 'Auto-detect' },
						{ id: 'atem', label: 'ATEM' },
						{ id: 'obs', label: 'OBS' },
						{ id: 'encoder', label: 'Encoder' },
					],
				},
			],
			callback: async (action) => {
				self.sendCommand('recovery.restartRecording', {
					source: String(action.options.source || ''),
				})
			},
		},

		recovery_reconnect_device: {
			name: 'Recovery: Reconnect Device',
			description: 'Force reconnect a specific device',
			options: [
				{
					id: 'deviceId',
					type: 'dropdown',
					label: 'Device',
					default: 'atem',
					choices: [
						{ id: 'atem', label: 'ATEM' },
						{ id: 'obs', label: 'OBS' },
						{ id: 'encoder', label: 'Encoder' },
						{ id: 'companion', label: 'Companion' },
						{ id: 'proPresenter', label: 'ProPresenter' },
						{ id: 'vmix', label: 'vMix' },
						{ id: 'mixer', label: 'Audio Mixer' },
						{ id: 'resolume', label: 'Resolume' },
					],
				},
			],
			callback: async (action) => {
				self.sendCommand('recovery.reconnectDevice', { deviceId: String(action.options.deviceId) })
			},
		},

		// ── Failover ──────────────────────────────────────────────────────────────

		failover_to_backup: {
			name: 'Failover: Switch to Backup Encoder',
			description: 'Switch streaming to the backup encoder',
			options: [],
			callback: async () => {
				self.sendCommand('failover.switchToBackupEncoder', {})
			},
		},

		failover_to_primary: {
			name: 'Failover: Switch to Primary Encoder',
			description: 'Switch streaming back to the primary encoder',
			options: [],
			callback: async () => {
				self.sendCommand('failover.switchToPrimaryEncoder', {})
			},
		},

		// ── Smart Plugs (Shelly) ──────────────────────────────────────────────────

		shelly_power_cycle: {
			name: 'Smart Plug: Power Cycle',
			description: 'Power cycle a Shelly smart plug (off then on)',
			options: [
				{ id: 'plugId', type: 'textinput', label: 'Plug ID', default: '' },
				{ id: 'delayMs', type: 'number', label: 'Off Duration (ms)', default: 5000, min: 1000, max: 30000 },
			],
			callback: async (action) => {
				self.sendCommand('shelly.powerCycle', {
					plugId: String(action.options.plugId),
					delayMs: Number(action.options.delayMs),
				})
			},
		},

		// ── HyperDeck ─────────────────────────────────────────────────────────────

		hyperdeck_record: {
			name: 'HyperDeck: Record',
			description: 'Start recording on a HyperDeck',
			options: [
				{ id: 'index', type: 'number', label: 'HyperDeck Index', default: 0, min: 0, max: 7 },
			],
			callback: async (action) => {
				self.sendCommand('hyperdeck.record', { index: Number(action.options.index) })
			},
		},

		hyperdeck_stop: {
			name: 'HyperDeck: Stop',
			description: 'Stop a HyperDeck',
			options: [
				{ id: 'index', type: 'number', label: 'HyperDeck Index', default: 0, min: 0, max: 7 },
			],
			callback: async (action) => {
				self.sendCommand('hyperdeck.stop', { index: Number(action.options.index) })
			},
		},

		hyperdeck_play: {
			name: 'HyperDeck: Play',
			description: 'Start playback on a HyperDeck',
			options: [
				{ id: 'index', type: 'number', label: 'HyperDeck Index', default: 0, min: 0, max: 7 },
			],
			callback: async (action) => {
				self.sendCommand('hyperdeck.play', { index: Number(action.options.index) })
			},
		},

		// ── Presets (Tally Connect scene presets) ─────────────────────────────────

		preset_recall: {
			name: 'Recall Tally Preset',
			description: 'Recall a saved Tally Connect preset by name',
			options: [
				{ id: 'name', type: 'textinput', label: 'Preset Name', default: '', useVariables: true },
			],
			callback: async (action, context) => {
				const name = await context.parseVariablesInString(String(action.options.name))
				self.sendCommand('preset.recall', { name })
			},
		},

		// ── Freeform Command ──────────────────────────────────────────────────────

		send_command: {
			name: 'Send Raw Command',
			description: 'Send any Tally Connect command string with JSON params',
			options: [
				{ id: 'command', type: 'textinput', label: 'Command (e.g. atem.cut)', default: '', useVariables: true },
				{ id: 'params', type: 'textinput', label: 'Params JSON (optional)', default: '{}', useVariables: true },
			],
			callback: async (action, context) => {
				const command = await context.parseVariablesInString(String(action.options.command))
				const paramsStr = await context.parseVariablesInString(String(action.options.params || '{}'))
				let params = {}
				try {
					params = JSON.parse(paramsStr)
				} catch {
					self.log('warn', `Invalid JSON params for command "${command}": ${paramsStr}`)
				}
				self.sendCommand(command, params)
			},
		},
	}
}
