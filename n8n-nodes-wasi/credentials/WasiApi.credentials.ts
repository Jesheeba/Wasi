import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

// Matches Wasi's Hub API auth: Authorization: Bearer <key>, resolved
// server-side to one client (middleware/requireApiKey.js). baseUrl has no
// built-in default - Wasi is deployed per-instance, same reasoning as the
// MCP server's WASI_API_BASE_URL (mcp-server/src/hubClient.js).
export class WasiApi implements ICredentialType {
	name = 'wasiApi';

	displayName = 'Wasi API';

	documentationUrl = 'https://github.com/sirahdigital/n8n-nodes-wasi';

	properties: INodeProperties[] = [
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: '',
			placeholder: 'https://your-wasi-domain.example',
			description: "Your Wasi instance's base URL, no trailing slash",
			required: true,
		},
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description: 'A Hub API key created in Wasi under Settings > Developer',
			required: true,
		},
		{
			displayName: 'Client ID',
			name: 'clientId',
			type: 'string',
			default: '',
			description:
				"Your Wasi client_id (shown alongside the API key in Settings > Developer). Required by the Send Message action as a defense-in-depth check against this API key's own client - get_account_status action also returns it.",
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/api/v1/account',
		},
	};
}
