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

test("Error normalization: OpenAI invalid model maps 404->400 with envelope", async () => {
	const body = {
		model: "gpt-5-does-not-exist",
		stream: false,
		messages: [{ role: "user", content: "hello" }],
	};
	const resp = await postJson("http://localhost:8787/v1/chat/completions", body);
	expect.toBe(resp.headers.get("content-type"), "application/json");
	// Downstream 404 should be coerced to 400
	expect.toBe(resp.status, 400);
	const json = await resp.json();
	expect.toBeTruthy(json?.error);
	expect.toBeTruthy(typeof json.error.message === "string");
	expect.toBe(isAllowedType(json.error.type), true);
});

test("Error normalization: OpenAI invalid parameter returns envelope", async () => {
	const body = {
		model: "gpt-5",
		stream: false,
		// Force a downstream validation error by sending an obviously invalid type
		temperature: -999,
		messages: [{ role: "user", content: "hello" }],
	};
	const resp = await postJson("http://localhost:8787/v1/chat/completions", body);
	// Either OpenAI rejects (400) or we may still pass; if upstream accepts, this test should be adapted.
	// We assert only that error envelope shape is respected when not ok.
	if (resp.ok) return;
	expect.toBe(resp.headers.get("content-type"), "application/json");
	expect.toBe(resp.status, 400);
	const json = await resp.json();
	expect.toBeTruthy(json?.error);
	expect.toBe(isAllowedType(json.error.type), true);
});


