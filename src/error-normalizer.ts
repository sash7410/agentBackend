// src/error-normalizer.ts

export type Downstream = 'openai' | 'anthropic';

export interface DownstreamErrorInput {
	downstream: Downstream;
	downstreamStatus: number;
	downstreamBody: unknown; // parsed JSON when possible, otherwise a string
	downstreamRequestId?: string | null; // for Anthropic logging
}

export interface NormalizedError {
	status: number;
	body: {
		error: {
			message: string;
			type:
				| 'invalid_request_error'
				| 'authentication_error'
				| 'permission_error'
				| 'rate_limit_error'
				| 'server_error';
			param: string | null;
			code: string | null;
		};
	};
}

export function normalizeError(input: DownstreamErrorInput): NormalizedError {
	const { downstream, downstreamStatus } = input;
	const fallback: NormalizedError = {
		status: 502,
		body: {
			error: {
				message: 'An downstream error occurred and could not be normalized',
				type: 'server_error',
				param: null,
				code: 'normalization_failure',
			},
		},
	};
	try {
		if (downstream === 'openai') {
			const j = input.downstreamBody as any;
			const e = j?.error;
			if (e && typeof e.message === 'string') {
				return {
					status: coerceStatus(downstreamStatus),
					body: {
						error: {
							message: sanitizeMsg(e.message),
							type: mapTypeOpenAI(e.type),
							param: e.param ?? null,
							code: e.code ?? null,
						},
					},
				};
			}
			if (typeof input.downstreamBody === 'string') {
				return {
					status: coerceStatus(downstreamStatus),
					body: {
						error: {
							message: sanitizeMsg(input.downstreamBody),
							type: downstreamStatus >= 500 ? 'server_error' : 'invalid_request_error',
							param: null,
							code: null,
						},
					},
				};
			}
			return fallback;
		}
		const j = input.downstreamBody as any;
		const e = j?.error;
		if (j?.type === 'error' && e && typeof e.message === 'string') {
			const mapped = mapAnthropicType(e.type);
			return {
				status: mapAnthropicStatus(downstreamStatus, e.type),
				body: {
					error: {
						message: sanitizeMsg(e.message),
						type: mapped.type,
						param: null,
						code: mapped.code,
					},
				},
			};
		}
		if (typeof input.downstreamBody === 'string') {
			return {
				status: coerceStatus(downstreamStatus),
				body: {
					error: {
						message: sanitizeMsg(input.downstreamBody),
						type: downstreamStatus >= 500 ? 'server_error' : 'invalid_request_error',
						param: null,
						code: null,
					},
				},
			};
		}
		return fallback;
	} catch {
		return fallback;
	}
}

function sanitizeMsg(m: string): string {
	return m.replace(/[\u0000-\u001F\u007F]/g, '').slice(0, 2000);
}

function coerceStatus(s: number): number {
	if (s === 404 || s === 413) return 400;
	if (s === 529) return 503;
	if (s >= 500 && s !== 500 && s !== 503) return 502;
	return s;
}

function mapAnthropicStatus(status: number, anthropicType: string): number {
	if (status === 404) return 400;
	if (status === 413) return 400;
	if (status === 529 || anthropicType === 'overloaded_error') return 503;
	if (status >= 500 && status !== 500 && status !== 503) return 502;
	return status;
}

function mapTypeOpenAI(t: string):
	NormalizedError['body']['error']['type'] {
	switch (t) {
		case 'invalid_request_error': return 'invalid_request_error';
		case 'authentication_error':  return 'authentication_error';
		case 'permission_error':      return 'permission_error';
		case 'rate_limit_error':      return 'rate_limit_error';
		default:                      return 'server_error';
	}
}

function mapAnthropicType(t: string):
	{ type: NormalizedError['body']['error']['type']; code: string | null } {
	switch (t) {
		case 'invalid_request_error': return { type: 'invalid_request_error', code: null };
		case 'authentication_error':  return { type: 'authentication_error',  code: 'invalid_api_key' };
		case 'permission_error':      return { type: 'permission_error',      code: 'insufficient_permissions' };
		case 'not_found_error':       return { type: 'invalid_request_error', code: 'not_found' };
		case 'request_too_large':     return { type: 'invalid_request_error', code: 'request_too_large' };
		case 'rate_limit_error':      return { type: 'rate_limit_error',      code: 'rate_limit_exceeded' };
		case 'overloaded_error':      return { type: 'server_error',          code: 'overloaded_error' };
		case 'api_error':
		default:                      return { type: 'server_error',          code: 'api_error' };
	}
}

export function sseErrorFrame(normalized: NormalizedError['body']): string {
	return `data: ${JSON.stringify(normalized)}\n\n`;
}


