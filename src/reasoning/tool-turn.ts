// ToolTurn: tracks previous_response_id and tool call ids across rounds
export type ToolCall = {
	call_id: string;
	name: string;
	arguments_json: string;
};

export class ToolTurn {
	private maxRounds: number;
	private rounds: number;
	private previousResponseId: string | null;
	private pendingCalls: ToolCall[];

	constructor(maxRounds = 4) {
		this.maxRounds = Math.max(1, maxRounds);
		this.rounds = 0;
		this.previousResponseId = null;
		this.pendingCalls = [];
	}

	get previous_response_id(): string | null {
		return this.previousResponseId;
	}

	setPreviousResponseId(id: string) {
		this.previousResponseId = id;
	}

	addToolCall(call: ToolCall) {
		this.pendingCalls.push(call);
	}

	nextCall(): ToolCall | null {
		return this.pendingCalls.shift() ?? null;
	}

	incrementRoundOrThrow() {
		this.rounds++;
		if (this.rounds > this.maxRounds) {
			throw new Error("Maximum number of tool rounds exceeded");
		}
	}
}


