import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IHttpRequestMethods,
	IHttpRequestOptions,
	NodeConnectionType,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

// Mirrors server/src/routes/apiV1*.js exactly - one resource per route
// file, one operation per router.VERB(...) call. See
// crm-integration-guide.md / mcp-server for the same surface wrapped as
// MCP tools instead of n8n operations.
async function wasiRequest(
	this: IExecuteFunctions,
	method: IHttpRequestMethods,
	path: string,
	body?: IDataObject,
	qs?: IDataObject,
): Promise<any> {
	const credentials = await this.getCredentials('wasiApi');
	const baseUrl = String(credentials.baseUrl || '').replace(/\/+$/, '');
	if (!baseUrl) {
		throw new NodeOperationError(this.getNode(), 'Wasi API credential is missing Base URL');
	}

	const options: IHttpRequestOptions = {
		method,
		url: `${baseUrl}${path}`,
		json: true,
		body,
		qs,
	};

	try {
		return await this.helpers.httpRequestWithAuthentication.call(this, 'wasiApi', options);
	} catch (error) {
		// Wasi's /api/v1/* error shape is always { error: { code, message, ... } }
		// (server/src/utils/apiError.js) - surface that message instead of a
		// generic "request failed" when it's present.
		const apiError = (error as { response?: { body?: { error?: { message?: string } } } })
			?.response?.body?.error;
		if (apiError?.message) {
			throw new NodeApiError(this.getNode(), error as any, { message: apiError.message });
		}
		throw error;
	}
}

function parseJsonParam(this: IExecuteFunctions, raw: unknown, fieldName: string, itemIndex: number): any {
	if (raw === undefined || raw === null || raw === '') return undefined;
	if (typeof raw !== 'string') return raw;
	try {
		return JSON.parse(raw);
	} catch (err) {
		throw new NodeOperationError(this.getNode(), `${fieldName} must be valid JSON`, { itemIndex });
	}
}

export class Wasi implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Wasi',
		name: 'wasi',
		icon: 'file:wasi.svg',
		group: ['output'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: "Send WhatsApp messages and manage templates/contacts via Wasi's Hub API",
		defaults: { name: 'Wasi' },
		inputs: ['main'] as NodeConnectionType[],
		outputs: ['main'] as NodeConnectionType[],
		credentials: [{ name: 'wasiApi', required: true }],
		requestDefaults: { baseURL: '={{$credentials.baseUrl}}' },
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Account', value: 'account' },
					{ name: 'Contact', value: 'contact' },
					{ name: 'Conversation', value: 'conversation' },
					{ name: 'Message', value: 'message' },
					{ name: 'Template', value: 'template' },
					{ name: 'Webhook Subscription', value: 'subscription' },
				],
				default: 'message',
			},

			// ---------------------------------------------------------------- Account
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['account'] } },
				options: [
					{
						name: 'Get Status',
						value: 'getStatus',
						description: 'Get this client\'s WABA connection status',
						action: 'Get account status',
					},
					{
						name: 'Get Rate Limit',
						value: 'getRateLimit',
						description: 'Get the Hub API rate-limit ceiling',
						action: 'Get rate limit status',
					},
				],
				default: 'getStatus',
			},

			// ---------------------------------------------------------------- Contact
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['contact'] } },
				options: [
					{
						name: 'Search',
						value: 'search',
						description: 'Search contacts by name/phone substring, or look up an exact phone',
						action: 'Search contacts',
					},
				],
				default: 'search',
			},
			{
				displayName: 'Phone (Exact Match)',
				name: 'phone',
				type: 'string',
				default: '',
				description: 'Exact phone match. Leave empty to use Query instead.',
				displayOptions: { show: { resource: ['contact'], operation: ['search'] } },
			},
			{
				displayName: 'Query',
				name: 'q',
				type: 'string',
				default: '',
				description: 'Substring match over contact name/phone. Ignored if Phone is set.',
				displayOptions: { show: { resource: ['contact'], operation: ['search'] } },
			},
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				description: 'Max number of results to return',
				default: 50,
				typeOptions: { minValue: 1 },
				displayOptions: { show: { resource: ['contact'], operation: ['search'] } },
			},

			// ------------------------------------------------------------ Conversation
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['conversation'] } },
				options: [
					{
						name: 'List',
						value: 'list',
						description: 'List conversations (chats)',
						action: 'List conversations',
					},
					{
						name: 'Get Messages',
						value: 'getMessages',
						description: 'Get recent messages in one conversation, oldest first',
						action: 'Get conversation messages',
					},
				],
				default: 'list',
			},
			{
				displayName: 'Conversation ID',
				name: 'conversationId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['conversation'], operation: ['getMessages'] } },
			},
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				description: 'Max number of results to return',
				default: 50,
				typeOptions: { minValue: 1 },
				displayOptions: { show: { resource: ['conversation'], operation: ['list'] } },
			},
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				description: 'Max number of results to return',
				default: 50,
				typeOptions: { minValue: 1 },
				displayOptions: { show: { resource: ['conversation'], operation: ['getMessages'] } },
			},

			// ----------------------------------------------------------------- Message
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['message'] } },
				options: [
					{
						name: 'Send',
						value: 'send',
						description: 'Send a text, template, or interactive WhatsApp message',
						action: 'Send a message',
					},
					{
						name: 'Get Status',
						value: 'getStatus',
						description: 'Get delivery status for a message this app sent',
						action: 'Get message status',
					},
				],
				default: 'send',
			},
			{
				displayName: 'Message ID',
				name: 'messageId',
				type: 'string',
				default: '',
				required: true,
				description: 'Wasi\'s own message row ID, returned by Send',
				displayOptions: { show: { resource: ['message'], operation: ['getStatus'] } },
			},
			{
				displayName: 'To (Phone, E.164 or Local)',
				name: 'to',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['message'], operation: ['send'] } },
			},
			{
				displayName: 'Message Type',
				name: 'messageType',
				type: 'options',
				options: [
					{ name: 'Text', value: 'text' },
					{ name: 'Template', value: 'template' },
					{ name: 'Interactive', value: 'interactive' },
				],
				default: 'text',
				displayOptions: { show: { resource: ['message'], operation: ['send'] } },
			},
			{
				displayName: 'Body',
				name: 'body',
				type: 'string',
				typeOptions: { rows: 3 },
				default: '',
				required: true,
				description: 'The message text (Text type), or the body shown above the buttons/list (Interactive type)',
				displayOptions: { show: { resource: ['message'], operation: ['send'], messageType: ['text', 'interactive'] } },
			},
			{
				displayName: 'Template Name',
				name: 'template',
				type: 'string',
				default: '',
				required: true,
				description: 'Must already be synced locally (POST /api/templates/sync) so its approved language can be resolved',
				displayOptions: { show: { resource: ['message'], operation: ['send'], messageType: ['template'] } },
			},
			{
				displayName: 'Template Params (JSON)',
				name: 'params',
				type: 'json',
				default: '{}',
				description:
					'Named body parameters, e.g. {"name": "Priya", "amount": "499"}. For an Authentication template, exactly one key/value holding the one-time code.',
				displayOptions: { show: { resource: ['message'], operation: ['send'], messageType: ['template'] } },
			},
			{
				displayName: 'Interactive Subtype',
				name: 'interactiveType',
				type: 'options',
				options: [
					{ name: 'Reply Buttons (up to 3)', value: 'buttons' },
					{ name: 'List Message', value: 'list' },
				],
				default: 'buttons',
				displayOptions: { show: { resource: ['message'], operation: ['send'], messageType: ['interactive'] } },
			},
			{
				displayName: 'Buttons',
				name: 'buttons',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true, sortable: true },
				default: {},
				placeholder: 'Add Button',
				displayOptions: {
					show: { resource: ['message'], operation: ['send'], messageType: ['interactive'], interactiveType: ['buttons'] },
				},
				options: [
					{
						name: 'button',
						displayName: 'Button',
						values: [
							{ displayName: 'ID', name: 'id', type: 'string', default: '' },
							{ displayName: 'Title', name: 'title', type: 'string', default: '', description: 'Up to 20 characters' },
						],
					},
				],
			},
			{
				displayName: 'List Button Label',
				name: 'button',
				type: 'string',
				default: '',
				description: 'Label on the button that opens the list (up to 20 characters)',
				displayOptions: {
					show: { resource: ['message'], operation: ['send'], messageType: ['interactive'], interactiveType: ['list'] },
				},
			},
			{
				displayName: 'Sections (JSON)',
				name: 'sections',
				type: 'json',
				default: '[{"title": "Options", "rows": [{"id": "row_1", "title": "Option 1"}]}]',
				description: "Meta's list-message sections shape: up to 10 sections, up to 10 rows total",
				displayOptions: {
					show: { resource: ['message'], operation: ['send'], messageType: ['interactive'], interactiveType: ['list'] },
				},
			},
			{
				displayName: 'Header/Footer (Interactive Only)',
				name: 'interactiveHeaderFooter',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: { show: { resource: ['message'], operation: ['send'], messageType: ['interactive'] } },
				options: [
					{ displayName: 'Header', name: 'header', type: 'string', default: '', description: 'Up to 60 characters' },
					{ displayName: 'Footer', name: 'footer', type: 'string', default: '', description: 'Up to 60 characters' },
				],
			},
			{
				displayName: 'Header Media URL',
				name: 'headerMediaUrl',
				type: 'string',
				default: '',
				description: "An https:// URL to this send's media-header template image/video/document, if the template has a media header",
				displayOptions: { show: { resource: ['message'], operation: ['send'], messageType: ['template'] } },
			},

			// ---------------------------------------------------------------- Template
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['template'] } },
				options: [
					{ name: 'List', value: 'list', description: 'List this client\'s templates', action: 'List templates' },
					{ name: 'Get', value: 'get', description: 'Get one template\'s full stored shape', action: 'Get a template' },
					{ name: 'Create', value: 'create', description: 'Create and submit a template to Meta', action: 'Create a template' },
				],
				default: 'list',
			},
			{
				displayName: 'Template ID',
				name: 'templateId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['template'], operation: ['get'] } },
			},
			{
				displayName: 'Name',
				name: 'name',
				type: 'string',
				default: '',
				required: true,
				description: 'Lowercase letters, numbers, and underscores only',
				displayOptions: { show: { resource: ['template'], operation: ['create'] } },
			},
			{
				displayName: 'Category',
				name: 'category',
				type: 'options',
				options: [
					{ name: 'Marketing', value: 'Marketing' },
					{ name: 'Utility', value: 'Utility' },
					{ name: 'Authentication', value: 'Authentication' },
				],
				default: 'Utility',
				required: true,
				displayOptions: { show: { resource: ['template'], operation: ['create'] } },
			},
			{
				displayName: 'Language',
				name: 'language',
				type: 'string',
				default: 'en_US',
				displayOptions: { show: { resource: ['template'], operation: ['create'] } },
			},
			{
				displayName: 'Body',
				name: 'templateBody',
				type: 'string',
				typeOptions: { rows: 3 },
				default: '',
				description: 'Required unless Category is Authentication (Meta generates that text automatically)',
				displayOptions: { show: { resource: ['template'], operation: ['create'], category: ['Marketing', 'Utility'] } },
			},
			{
				displayName: 'Additional Fields',
				name: 'additionalFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: { show: { resource: ['template'], operation: ['create'] } },
				options: [
					{
						displayName: 'Add Security Disclaimer (Authentication)',
						name: 'addSecurityDisclaimer',
						type: 'boolean',
						default: true,
					},
					{
						displayName: 'Body Param Examples (JSON)',
						name: 'bodyParamExamples',
						type: 'json',
						default: '{}',
						description: 'A real example per named {{parameter}} in the body, e.g. {"name": "Priya"}',
					},
					{
						displayName: 'Buttons (JSON)',
						name: 'buttonsJson',
						type: 'json',
						default: '[]',
						description: 'Array of button objects matching Meta\'s template button shape, up to 10',
					},
					{
						displayName: 'Code Expiration Minutes (Authentication)',
						name: 'codeExpirationMinutes',
						type: 'number',
						default: 10,
						typeOptions: { minValue: 1, maxValue: 90 },
					},
					{
						displayName: 'Footer',
						name: 'footer',
						type: 'string',
						default: '',
						description: 'Up to 60 characters',
					},
					{
						displayName: 'Header Text',
						name: 'headerText',
						type: 'string',
						default: '',
						description: 'Required when Header Type is Text. Up to 60 characters.',
					},
					{
						displayName: 'Header Type',
						name: 'headerType',
						type: 'options',
						options: [
							{ name: 'Document', value: 'DOCUMENT' },
							{ name: 'Image', value: 'IMAGE' },
							{ name: 'None', value: 'NONE' },
							{ name: 'Text', value: 'TEXT' },
							{ name: 'Video', value: 'VIDEO' },
						],
						default: 'NONE',
					},
				],
			},

			// ------------------------------------------------------- Webhook Subscription
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['subscription'] } },
				options: [
					{
						name: 'Subscribe',
						value: 'subscribe',
						description: 'Register a URL to receive message.received events',
						action: 'Subscribe to events',
					},
					{
						name: 'Unsubscribe',
						value: 'unsubscribe',
						description: 'Remove a webhook subscription',
						action: 'Unsubscribe from events',
					},
				],
				default: 'subscribe',
			},
			{
				displayName: 'Target URL',
				name: 'targetUrl',
				type: 'string',
				default: '',
				required: true,
				description: 'Where Wasi will POST each event (your n8n Webhook node URL)',
				displayOptions: { show: { resource: ['subscription'], operation: ['subscribe'] } },
			},
			{
				displayName: 'Subscription ID',
				name: 'subscriptionId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['subscription'], operation: ['unsubscribe'] } },
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;

		for (let i = 0; i < items.length; i++) {
			try {
				let responseData: any;

				if (resource === 'account') {
					if (operation === 'getStatus') {
						responseData = await wasiRequest.call(this, 'GET', '/api/v1/account');
					} else if (operation === 'getRateLimit') {
						responseData = await wasiRequest.call(this, 'GET', '/api/v1/account/rate-limit');
					}
				} else if (resource === 'contact') {
					if (operation === 'search') {
						const phone = this.getNodeParameter('phone', i) as string;
						const q = this.getNodeParameter('q', i) as string;
						const limit = this.getNodeParameter('limit', i) as number;
						const qs: IDataObject = { limit };
						if (phone) qs.phone = phone;
						else if (q) qs.q = q;
						responseData = await wasiRequest.call(this, 'GET', '/api/v1/contacts', undefined, qs);
					}
				} else if (resource === 'conversation') {
					if (operation === 'list') {
						const limit = this.getNodeParameter('limit', i) as number;
						responseData = await wasiRequest.call(this, 'GET', '/api/v1/conversations', undefined, { limit });
					} else if (operation === 'getMessages') {
						const conversationId = this.getNodeParameter('conversationId', i) as string;
						const limit = this.getNodeParameter('limit', i) as number;
						responseData = await wasiRequest.call(
							this,
							'GET',
							`/api/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
							undefined,
							{ limit },
						);
					}
				} else if (resource === 'message') {
					if (operation === 'getStatus') {
						const messageId = this.getNodeParameter('messageId', i) as string;
						responseData = await wasiRequest.call(this, 'GET', `/api/v1/messages/${encodeURIComponent(messageId)}/status`);
					} else if (operation === 'send') {
						const credentials = await this.getCredentials('wasiApi');
						const clientId = String(credentials.clientId || '');
						if (!clientId) {
							throw new NodeOperationError(
								this.getNode(),
								'This credential has no Client ID set - open the Wasi API credential and fill it in (also returned by Account > Get Status)',
								{ itemIndex: i },
							);
						}

						const to = this.getNodeParameter('to', i) as string;
						const messageType = this.getNodeParameter('messageType', i) as 'text' | 'template' | 'interactive';
						const body: IDataObject = { client_id: clientId, to, type: messageType };

						if (messageType === 'text') {
							body.body = this.getNodeParameter('body', i) as string;
						} else if (messageType === 'template') {
							body.template = this.getNodeParameter('template', i) as string;
							const params = parseJsonParam.call(this, this.getNodeParameter('params', i), 'Template Params', i);
							if (params) body.params = params;
							const headerMediaUrl = this.getNodeParameter('headerMediaUrl', i) as string;
							if (headerMediaUrl) body.headerMediaUrl = headerMediaUrl;
						} else {
							body.body = this.getNodeParameter('body', i) as string;
							const headerFooter = this.getNodeParameter('interactiveHeaderFooter', i) as IDataObject;
							if (headerFooter?.header) body.header = headerFooter.header;
							if (headerFooter?.footer) body.footer = headerFooter.footer;

							const interactiveType = this.getNodeParameter('interactiveType', i) as 'buttons' | 'list';
							if (interactiveType === 'buttons') {
								const buttonsCollection = this.getNodeParameter('buttons', i) as IDataObject;
								const list = (buttonsCollection?.button as IDataObject[]) || [];
								body.buttons = list.map((b) => ({ id: b.id, title: b.title }));
							} else {
								body.button = this.getNodeParameter('button', i) as string;
								body.sections = parseJsonParam.call(this, this.getNodeParameter('sections', i), 'Sections', i);
							}
						}

						responseData = await wasiRequest.call(this, 'POST', '/api/v1/messages', body);
					}
				} else if (resource === 'template') {
					if (operation === 'list') {
						responseData = await wasiRequest.call(this, 'GET', '/api/v1/templates');
					} else if (operation === 'get') {
						const templateId = this.getNodeParameter('templateId', i) as string;
						responseData = await wasiRequest.call(this, 'GET', `/api/v1/templates/${encodeURIComponent(templateId)}`);
					} else if (operation === 'create') {
						const name = this.getNodeParameter('name', i) as string;
						const category = this.getNodeParameter('category', i) as string;
						const language = this.getNodeParameter('language', i) as string;
						const additional = this.getNodeParameter('additionalFields', i) as IDataObject;

						const body: IDataObject = { name, category, language };
						if (category !== 'Authentication') {
							body.body = this.getNodeParameter('templateBody', i) as string;
						}
						if (additional.bodyParamExamples) {
							body.bodyParamExamples = parseJsonParam.call(this, additional.bodyParamExamples, 'Body Param Examples', i);
						}
						if (additional.footer) body.footer = additional.footer;
						if (additional.headerType) {
							body.header = { type: additional.headerType, text: additional.headerText || undefined };
						}
						if (additional.buttonsJson) {
							body.buttons = parseJsonParam.call(this, additional.buttonsJson, 'Buttons', i);
						}
						if (category === 'Authentication') {
							if (additional.codeExpirationMinutes) body.codeExpirationMinutes = additional.codeExpirationMinutes;
							if (additional.addSecurityDisclaimer !== undefined) body.addSecurityDisclaimer = additional.addSecurityDisclaimer;
						}

						responseData = await wasiRequest.call(this, 'POST', '/api/v1/templates', body);
					}
				} else if (resource === 'subscription') {
					if (operation === 'subscribe') {
						const targetUrl = this.getNodeParameter('targetUrl', i) as string;
						responseData = await wasiRequest.call(this, 'POST', '/api/v1/subscriptions', {
							target_url: targetUrl,
							event: 'message.received',
						});
					} else if (operation === 'unsubscribe') {
						const subscriptionId = this.getNodeParameter('subscriptionId', i) as string;
						responseData = await wasiRequest.call(
							this,
							'DELETE',
							`/api/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
						);
					}
				}

				const executionData = this.helpers.constructExecutionMetaData(
					this.helpers.returnJsonArray(responseData as IDataObject),
					{ itemData: { item: i } },
				);
				returnData.push(...executionData);
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
					continue;
				}
				throw error;
			}
		}

		return [returnData];
	}
}
