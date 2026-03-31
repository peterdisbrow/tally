import { InstanceBase, InstanceStatus, runEntrypoint } from '@companion-module/base'
import WebSocket from 'ws'
import { type TallyConnectConfig, getConfigFields } from './config.js'
import { UpgradeScripts } from './upgrades.js'
import { getActions } from './actions.js'
import { getFeedbacks } from './feedbacks.js'
import { getVariableDefinitions, getVariableValues } from './variables.js'
import { getPresets } from './presets.js'

/**
 * Flattened state extracted from the Tally Connect status_update messages.
 * Every field here maps to a real field in the church-client status object
 * (church-client/src/index.js lines 328-408).
 */
export interface TallyState {
	// status.atem.*
	programInput: number | null
	previewInput: number | null
	inTransition: boolean
	atemStreaming: boolean
	atemRecording: boolean
	atemStreamingBitrate: number | null
	atemModel: string | null
	inputSources: Record<number, { longName: string; shortName: string; portType?: number }>

	// status.obs.*
	obsStreaming: boolean
	obsRecording: boolean
	obsBitrate: number | null
	obsFps: number | null

	// status.encoder.*
	encoderLive: boolean
	encoderBitrateKbps: number | null
	encoderFps: number | null

	// status.vmix.*
	vmixStreaming: boolean
	vmixRecording: boolean

	// status.mixer.*
	mixerMainMuted: boolean
	mixerType: string | null

	// status.proPresenter.*
	ppSlideIndex: number | null
	ppSlideTotal: number | null
	ppVersion: string | null

	// status.audio.*
	audioSilence: boolean

	// status.system.*
	roomName: string | null
	systemHostname: string | null
	systemUptime: number | null

	// status.health.relay.latencyMs
	relayLatencyMs: number | null

	// status.streamVerification.youtube/facebook.viewerCount
	ytViewers: number | null
	fbViewers: number | null

	// Composite: which devices are connected
	// Keys: atem, obs, encoder, proPresenter, vmix, mixer, companion, resolume
	deviceConnected: Record<string, boolean>
}

function createDefaultTallyState(): TallyState {
	return {
		programInput: null,
		previewInput: null,
		inTransition: false,
		atemStreaming: false,
		atemRecording: false,
		atemStreamingBitrate: null,
		atemModel: null,
		inputSources: {},
		obsStreaming: false,
		obsRecording: false,
		obsBitrate: null,
		obsFps: null,
		encoderLive: false,
		encoderBitrateKbps: null,
		encoderFps: null,
		vmixStreaming: false,
		vmixRecording: false,
		mixerMainMuted: false,
		mixerType: null,
		ppSlideIndex: null,
		ppSlideTotal: null,
		ppVersion: null,
		audioSilence: false,
		roomName: null,
		systemHostname: null,
		systemUptime: null,
		relayLatencyMs: null,
		ytViewers: null,
		fbViewers: null,
		deviceConnected: {},
	}
}

export class TallyConnectInstance extends InstanceBase<TallyConnectConfig> {
	config!: TallyConnectConfig
	tallyState: TallyState = createDefaultTallyState()
	connectionStatus: string = 'Disconnected'
	churchName: string = ''

	private ws: WebSocket | null = null
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null
	private destroyed = false

	constructor(internal: unknown) {
		super(internal)
	}

	/**
	 * Called by Companion after upgrade scripts run.
	 * IMPORTANT: Do not await long-running operations here (SDK requirement).
	 */
	async init(config: TallyConnectConfig): Promise<void> {
		this.config = config
		this.updateStatus(InstanceStatus.Disconnected)
		this.initModule()
		// Start connection asynchronously (do not await - SDK requirement)
		this.connectWebSocket()
	}

	async destroy(): Promise<void> {
		this.destroyed = true
		this.cleanupConnection()
	}

	async configUpdated(config: TallyConnectConfig): Promise<void> {
		this.config = config
		this.cleanupConnection()
		this.tallyState = createDefaultTallyState()
		this.initModule()
		this.connectWebSocket()
	}

	getConfigFields() {
		return getConfigFields()
	}

	// ── Module registration ───────────────────────────────────────────────────

	private initModule(): void {
		this.setActionDefinitions(getActions(this))
		this.setFeedbackDefinitions(getFeedbacks(this))
		this.setVariableDefinitions(getVariableDefinitions())
		this.setVariableValues(getVariableValues(this))
		this.setPresetDefinitions(getPresets())
	}

	// ── WebSocket connection ──────────────────────────────────────────────────
	// Connects as a controller to /controller?apikey=...
	// @see relay-server/src/websocketRouter.js handleControllerConnection()

	private connectWebSocket(): void {
		if (this.destroyed) return
		if (!this.config.relay_url || !this.config.api_key) {
			this.updateStatus(InstanceStatus.BadConfig, 'Relay URL and API Key are required')
			return
		}

		this.cleanupConnection()
		this.updateStatus(InstanceStatus.Connecting)
		this.connectionStatus = 'Connecting'
		this.setVariableValues({ connection_status: 'Connecting' })

		// Build WebSocket URL: convert https→wss, http→ws
		let wsUrl = this.config.relay_url.trim().replace(/\/$/, '')
		if (wsUrl.startsWith('https://')) {
			wsUrl = 'wss://' + wsUrl.slice(8)
		} else if (wsUrl.startsWith('http://')) {
			wsUrl = 'ws://' + wsUrl.slice(7)
		} else if (!wsUrl.startsWith('ws://') && !wsUrl.startsWith('wss://')) {
			wsUrl = 'wss://' + wsUrl
		}

		// Controller endpoint with apikey query param
		// @see websocketRouter.js line 620: url.searchParams.get('apikey')
		const url = `${wsUrl}/controller?apikey=${encodeURIComponent(this.config.api_key)}`

		try {
			this.ws = new WebSocket(url)
		} catch (e) {
			this.log('error', `WebSocket creation failed: ${e instanceof Error ? e.message : String(e)}`)
			this.updateStatus(InstanceStatus.ConnectionFailure)
			this.scheduleReconnect()
			return
		}

		this.ws.on('open', () => {
			this.log('info', `Connected to relay: ${this.config.relay_url}`)
			this.updateStatus(InstanceStatus.Ok)
			this.connectionStatus = 'Connected'
			this.setVariableValues({ connection_status: 'Connected' })
		})

		this.ws.on('message', (data: WebSocket.Data) => {
			try {
				const msg = JSON.parse(data.toString())
				this.handleRelayMessage(msg)
			} catch {
				// Malformed JSON — ignore silently (matches relay pattern)
			}
		})

		this.ws.on('close', (code: number, reason: Buffer) => {
			const reasonStr = reason.toString()
			this.log('warn', `WebSocket closed: code=${code} reason="${reasonStr}"`)

			if (code === 1008 && reasonStr === 'invalid api key') {
				this.updateStatus(InstanceStatus.AuthenticationFailure, 'Invalid API key')
				this.connectionStatus = 'Auth Failed'
			} else {
				this.updateStatus(InstanceStatus.Disconnected)
				this.connectionStatus = 'Disconnected'
			}
			this.setVariableValues({ connection_status: this.connectionStatus })

			this.ws = null
			if (!this.destroyed) {
				this.scheduleReconnect()
			}
		})

		this.ws.on('error', (err: Error) => {
			this.log('error', `WebSocket error: ${err.message}`)
			// The 'close' event always follows — reconnection is handled there
		})
	}

	private cleanupConnection(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer)
			this.reconnectTimer = null
		}
		if (this.ws) {
			this.ws.removeAllListeners()
			try {
				this.ws.close(1000, 'module shutdown')
			} catch {
				// Already closed
			}
			this.ws = null
		}
	}

	private scheduleReconnect(): void {
		if (this.destroyed || this.reconnectTimer) return
		const interval = this.config.reconnect_interval || 5000
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null
			this.connectWebSocket()
		}, interval)
	}

	// ── Message handling ──────────────────────────────────────────────────────
	// Message types from relay-server/src/websocketRouter.js:
	//   church_list    — initial payload on connect (line 638-645)
	//   status_update  — from handleChurchMessage (line 455-476)
	//   church_connected / church_disconnected — connection lifecycle
	//   alert          — from handleChurchMessage (line 494-507)
	//   command_result — from handleChurchMessage (line 563-573)

	private handleRelayMessage(msg: Record<string, unknown>): void {
		switch (msg.type) {
			case 'church_list':
				this.handleChurchList(msg)
				break
			case 'status_update':
				this.handleStatusUpdate(msg)
				break
			case 'church_connected':
				if (this.isOurChurch(msg)) {
					this.log('info', `Church connected: ${msg.name} (instance: ${msg.instance})`)
				}
				break
			case 'church_disconnected':
				if (this.isOurChurch(msg)) {
					this.log('warn', `Church disconnected: ${msg.name}`)
					this.tallyState = createDefaultTallyState()
					this.refreshState()
				}
				break
			case 'alert':
				if (this.isOurChurch(msg)) {
					this.log('info', `Alert [${msg.severity}]: ${msg.message}`)
				}
				break
			case 'command_result':
				if (this.isOurChurch(msg)) {
					if (msg.error) {
						this.log('warn', `Command failed: ${msg.error}`)
					}
				}
				break
		}
	}

	/**
	 * Process the initial church_list sent on controller connection.
	 * @see websocketRouter.js lines 638-645
	 * Format: { type: 'church_list', churches: [{ churchId, name, connected, status, instances }] }
	 */
	private handleChurchList(msg: Record<string, unknown>): void {
		const churches = msg.churches as Array<Record<string, unknown>> | undefined
		if (!Array.isArray(churches)) return

		const target = churches.find((c) => c.churchId === this.config.church_id)
		if (target) {
			this.churchName = String(target.name || '')
			if (target.connected && target.status) {
				this.extractStatus(target.status as Record<string, unknown>)
				this.refreshState()
			}
		} else if (this.config.church_id) {
			this.log('warn', `Church ID "${this.config.church_id}" not found in relay church list`)
		}
	}

	/**
	 * Process a status_update broadcast from the relay.
	 * @see websocketRouter.js lines 455-476
	 * Format: { type: 'status_update', churchId, name, status, instance,
	 *           instanceStatus, roomInstanceMap, timestamp, lastHeartbeat }
	 */
	private handleStatusUpdate(msg: Record<string, unknown>): void {
		if (!this.isOurChurch(msg)) return

		this.churchName = String(msg.name || this.churchName)

		// If room_id is configured, prefer instance-specific status from instanceStatus
		let status = msg.status as Record<string, unknown> | undefined
		if (this.config.room_id && msg.instanceStatus) {
			const instanceStatus = msg.instanceStatus as Record<string, Record<string, unknown>>
			const roomInstanceMap = (msg.roomInstanceMap || {}) as Record<string, string>
			const instanceName = roomInstanceMap[this.config.room_id]
			if (instanceName && instanceStatus[instanceName]) {
				status = instanceStatus[instanceName]
			}
		}

		if (status) {
			this.extractStatus(status)
			this.refreshState()
		}
	}

	/**
	 * Extract flat TallyState from the nested status object.
	 * All field paths verified against church-client/src/index.js lines 328-408.
	 */
	private extractStatus(status: Record<string, unknown>): void {
		const s = this.tallyState
		const atem = (status.atem || {}) as Record<string, unknown>
		const obs = (status.obs || {}) as Record<string, unknown>
		const encoder = (status.encoder || {}) as Record<string, unknown>
		const vmix = (status.vmix || {}) as Record<string, unknown>
		const mixer = (status.mixer || {}) as Record<string, unknown>
		const pp = (status.proPresenter || {}) as Record<string, unknown>
		const audio = (status.audio || {}) as Record<string, unknown>
		const system = (status.system || {}) as Record<string, unknown>
		const health = (status.health || {}) as Record<string, unknown>
		const relay = (health.relay || {}) as Record<string, unknown>
		const companion = (status.companion || {}) as Record<string, unknown>
		const resolume = (status.resolume || {}) as Record<string, unknown>
		const sv = (status.streamVerification || {}) as Record<string, unknown>

		// ATEM — status.atem.programInput, previewInput, etc.
		s.programInput = atem.programInput != null ? Number(atem.programInput) : null
		s.previewInput = atem.previewInput != null ? Number(atem.previewInput) : null
		s.inTransition = atem.inTransition === true
		s.atemStreaming = atem.streaming === true
		s.atemRecording = atem.recording === true
		s.atemStreamingBitrate = atem.streamingBitrate != null ? Number(atem.streamingBitrate) : null
		s.atemModel = atem.model != null ? String(atem.model) : null

		// Input sources map: status.atem.inputSources
		if (atem.inputSources && typeof atem.inputSources === 'object') {
			const sources: TallyState['inputSources'] = {}
			for (const [key, val] of Object.entries(atem.inputSources as Record<string, Record<string, unknown>>)) {
				const id = Number(key)
				if (!isNaN(id) && val) {
					sources[id] = {
						longName: String(val.longName || ''),
						shortName: String(val.shortName || ''),
						portType: val.portType != null ? Number(val.portType) : undefined,
					}
				}
			}
			s.inputSources = sources
		}

		// OBS — status.obs.streaming, recording, bitrate, fps
		s.obsStreaming = obs.streaming === true
		s.obsRecording = obs.recording === true
		s.obsBitrate = obs.bitrate != null ? Number(obs.bitrate) : null
		s.obsFps = obs.fps != null ? Number(obs.fps) : null

		// Encoder — status.encoder.live, bitrateKbps, fps
		s.encoderLive = encoder.live === true
		s.encoderBitrateKbps = encoder.bitrateKbps != null ? Number(encoder.bitrateKbps) : null
		s.encoderFps = encoder.fps != null ? Number(encoder.fps) : null

		// vMix — status.vmix.streaming, recording
		s.vmixStreaming = vmix.streaming === true
		s.vmixRecording = vmix.recording === true

		// Mixer — status.mixer.mainMuted, type
		s.mixerMainMuted = mixer.mainMuted === true
		s.mixerType = mixer.type != null ? String(mixer.type) : null

		// ProPresenter — status.proPresenter.slideIndex, slideTotal, version
		s.ppSlideIndex = pp.slideIndex != null ? Number(pp.slideIndex) : (pp.currentSlide != null ? Number(pp.currentSlide) : null)
		s.ppSlideTotal = pp.slideTotal != null ? Number(pp.slideTotal) : null
		s.ppVersion = pp.version != null ? String(pp.version) : null

		// Audio — status.audio.silenceDetected
		s.audioSilence = audio.silenceDetected === true

		// System — status.system.roomName, hostname, uptime
		s.roomName = system.roomName != null ? String(system.roomName) : null
		s.systemHostname = system.hostname != null ? String(system.hostname) : null
		s.systemUptime = system.uptime != null ? Number(system.uptime) : null

		// Health — status.health.relay.latencyMs
		s.relayLatencyMs = relay.latencyMs != null ? Number(relay.latencyMs) : null

		// Stream Verification — status.streamVerification.youtube/facebook
		const yt = (sv.youtube || {}) as Record<string, unknown>
		const fb = (sv.facebook || {}) as Record<string, unknown>
		s.ytViewers = yt.viewerCount != null ? Number(yt.viewerCount) : null
		s.fbViewers = fb.viewerCount != null ? Number(fb.viewerCount) : null

		// Device connection states
		s.deviceConnected = {
			atem: atem.connected === true,
			obs: obs.connected === true,
			encoder: encoder.connected === true,
			proPresenter: pp.connected === true,
			vmix: vmix.connected === true,
			mixer: mixer.connected === true,
			companion: companion.connected === true,
			resolume: resolume.connected === true,
		}
	}

	/**
	 * Push updated state to Companion (variables + feedbacks).
	 */
	private refreshState(): void {
		this.setVariableValues(getVariableValues(this))
		this.checkFeedbacks(
			'tally_program',
			'tally_preview',
			'in_transition',
			'stream_live',
			'stream_offline',
			'recording_active',
			'device_connected',
			'device_disconnected',
			'audio_muted',
			'audio_silence',
		)
	}

	// ── Command sending ───────────────────────────────────────────────────────

	/**
	 * Send a command to the church via the controller WebSocket.
	 * @see websocketRouter.js handleControllerMessage() lines 685-706
	 * Format: { type: 'command', churchId, command, params, instance? }
	 */
	sendCommand(command: string, params: Record<string, unknown>): void {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			this.log('warn', `Cannot send command "${command}" — not connected`)
			return
		}
		if (!this.config.church_id) {
			this.log('warn', `Cannot send command "${command}" — no church_id configured`)
			return
		}

		const msg: Record<string, unknown> = {
			type: 'command',
			churchId: this.config.church_id,
			command,
			params,
		}

		// If room_id is configured, the relay can route to a specific instance
		// @see websocketRouter.js line 696: if (msg.instance && church.sockets?.get(msg.instance))
		// We don't know the instance name directly, but the relay resolves
		// churchId + broadcasts to all instances by default (line 700).
		// For room-targeted commands, the instance name would need to be known.

		try {
			this.ws.send(JSON.stringify(msg))
		} catch (e) {
			this.log('error', `Failed to send command "${command}": ${e instanceof Error ? e.message : String(e)}`)
		}
	}

	// ── Helpers ───────────────────────────────────────────────────────────────

	private isOurChurch(msg: Record<string, unknown>): boolean {
		if (!this.config.church_id) return true // no filter — accept all
		return msg.churchId === this.config.church_id
	}
}

runEntrypoint(TallyConnectInstance, UpgradeScripts)
