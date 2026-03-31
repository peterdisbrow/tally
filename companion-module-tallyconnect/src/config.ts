import type { SomeCompanionConfigField } from '@companion-module/base'

export interface TallyConnectConfig {
	relay_url: string
	api_key: string
	church_id: string
	room_id: string
	reconnect_interval: number
}

export function getConfigFields(): SomeCompanionConfigField[] {
	return [
		{
			type: 'static-text',
			id: 'info',
			label: 'Information',
			width: 12,
			value:
				'This module connects to your Tally Connect relay server as a controller. ' +
				'You need the relay URL, admin API key, and your church ID to connect.',
		},
		{
			type: 'textinput',
			id: 'relay_url',
			label: 'Relay Server URL',
			width: 8,
			default: 'https://api.tallyconnect.app',
			tooltip: 'The Tally Connect relay server URL (e.g. https://api.tallyconnect.app)',
		},
		{
			type: 'textinput',
			id: 'api_key',
			label: 'Admin API Key',
			width: 8,
			default: '',
			tooltip: 'The admin API key for your Tally Connect relay server',
		},
		{
			type: 'textinput',
			id: 'church_id',
			label: 'Church ID',
			width: 8,
			default: '',
			tooltip: 'Your church ID from the Tally Connect admin panel',
		},
		{
			type: 'textinput',
			id: 'room_id',
			label: 'Room ID (optional)',
			width: 8,
			default: '',
			tooltip: 'Filter to a specific room. Leave blank to receive all rooms.',
		},
		{
			type: 'number',
			id: 'reconnect_interval',
			label: 'Reconnect Interval (ms)',
			width: 4,
			default: 5000,
			min: 1000,
			max: 60000,
			tooltip: 'Time to wait before reconnecting after a disconnect',
		},
	]
}
