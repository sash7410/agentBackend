import fs from "fs";
import path from "path";

function getLogPath(): string {
	const custom = process.env.E2E_LOG_PATH;
	if (custom && custom.trim().length > 0) return custom;
	return path.resolve(process.cwd(), "logs.txt");
}

export async function waitForLogIncludes(
	substrings: string[],
	timeoutMs = 5000,
	pollIntervalMs = 200,
): Promise<void> {
	const logPath = getLogPath();
	const deadline = Date.now() + timeoutMs;
	let lastError: any = null;
	while (Date.now() < deadline) {
		try {
			if (fs.existsSync(logPath)) {
				const data = fs.readFileSync(logPath, "utf8");
				const ok = substrings.every((s) => data.includes(s));
				if (ok) return;
			}
		} catch (e: any) {
			lastError = e;
		}
		await new Promise((r) => setTimeout(r, pollIntervalMs));
	}
	if (lastError) throw lastError;
	throw new Error(
		`Timeout waiting for log substrings: ${JSON.stringify(substrings)} in ${getLogPath()}. ` +
			`Set E2E_LOG_PATH to point to your wrangler output (e.g., 'wrangler dev | tee logs.txt').`,
	);
}


