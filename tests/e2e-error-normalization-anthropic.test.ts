import { expect, test } from "./test-helpers";
import { postJson } from "./e2e-helpers";

function isAllowedType(t: string): boolean {
	return [
		"invalid_request_error",
		"authentication_error",
		"permission_error",
		"rate_limit_error",
		"server_error",
	].includes(t);
}

test("Error normalization: Anthropic unknown model maps 404->400 with envelope", async () => {
	const body = {
		model: "claude-sonnet-4-5-typo",
		stream: false,
		messages: [{ role: "user", content: "hello" }],
	};
	const resp = await postJson("http://localhost:8787/v1/chat/completions", body);
	expect.toBe(resp.headers.get("content-type"), "application/json");
	expect.toBe(resp.status, 400);
	const json = await resp.json();
	expect.toBeTruthy(json?.error);
	expect.toBeTruthy(typeof json.error.message === "string");
	expect.toBe(isAllowedType(json.error.type), true);
});

test("Error normalization: Anthropic request too large maps 413->400 with envelope", async () => {
	// 5MB content should safely exceed typical upstream request limits
	const big = "A".repeat(5_000_000);
	const body = {
		model: "claude-sonnet-4-5",
		stream: false,
		messages: [{ role: "user", content: big }],
	};
	const resp = await postJson("http://localhost:8787/v1/chat/completions", body);
	// Coercion should map 413 to 400; some gateways may return 400 directly
	expect.toBe(resp.headers.get("content-type"), "application/json");
	expect.toBe(resp.status, 400);
	const json = await resp.json();
	expect.toBeTruthy(json?.error);
	expect.toBe(isAllowedType(json.error.type), true);
});


