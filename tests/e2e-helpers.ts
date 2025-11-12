export function buildClientRequestBody(body: any) {
	return JSON.stringify(body);
}

export async function postJson(url: string, body: any, headers?: Record<string, string>): Promise<Response> {
	const h = { "content-type": "application/json", ...(headers || {}) };
	return await fetch(url, { method: "POST", headers: h as any, body: buildClientRequestBody(body) });
}

export async function collectSSE(stream: ReadableStream<Uint8Array>): Promise<string[]> {
	const decoder = new TextDecoder();
	const reader = stream.getReader();
	let acc = "";
	const out: string[] = [];
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		acc += decoder.decode(value);
		let idx;
		while ((idx = acc.indexOf("\n\n")) >= 0) {
			const frame = acc.slice(0, idx);
			acc = acc.slice(idx + 2);
			const lines = frame.split("\n");
			for (const l of lines) {
				if (l.startsWith("data: ")) {
					out.push(l.slice(6));
				}
			}
		}
	}
	return out;
}

export async function collectSSEObjects(stream: ReadableStream<Uint8Array>): Promise<any[]> {
	const lines = await collectSSE(stream);
	const objs: any[] = [];
	for (const l of lines) {
		if (l === "[DONE]") {
			objs.push(l);
			continue;
		}
		try {
			const obj = JSON.parse(l);
			objs.push(obj);
		} catch {
			// ignore non-JSON data frames
		}
	}
	return objs;
}


