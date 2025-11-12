// src/model-alias.ts

export type Routed = {
	downstream: 'openai' | 'anthropic';
	upstreamModel: string;
	mode: 'chat' | 'responses' | 'messages';
	reasoning?: { effort?: 'minimal' | 'low' | 'medium' | 'high' };
	thinking?: { type: 'enabled'; budget_tokens: number };
};

export function resolveModelAlias(clientModel: string): Routed {
	const m = clientModel.trim();
	if (m === 'gpt-5' || m === 'gpt-5-chat-latest') {
		return { downstream: 'openai', upstreamModel: 'gpt-5', mode: 'chat' };
	}
	const reasoningMatch = m.match(/^gpt5-(minimal|low|medium|high)(?:-fast)?$/i);
	if (reasoningMatch) {
		const effort = reasoningMatch[1].toLowerCase() as
			'minimal'|'low'|'medium'|'high';
		return {
			downstream: 'openai',
			upstreamModel: 'gpt-5',
			mode: 'responses',
			reasoning: { effort },
		};
	}
	if (m === 'claude-sonnet-4-5' || m === 'claude-sonnet-4-5-20250929') {
		return { downstream: 'anthropic', upstreamModel: 'claude-sonnet-4.5', mode: 'messages' };
	}
	if (/^claude-?sonnet-?4-?5.*-reason/i.test(m)) {
		return {
			downstream: 'anthropic',
			upstreamModel: 'claude-sonnet-4.5',
			mode: 'messages',
			thinking: { type: 'enabled', budget_tokens: 10000 },
		};
	}
	return { downstream: 'openai', upstreamModel: 'gpt-5', mode: 'chat' };
}


