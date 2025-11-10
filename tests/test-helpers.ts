import assert from "assert";

type AsyncOrSync = void | Promise<void>;

type TestCase = {
	name: string;
	fn: () => AsyncOrSync;
};

const cases: TestCase[] = [];

export function test(name: string, fn: () => AsyncOrSync) {
	cases.push({ name, fn });
}

export async function run(): Promise<number> {
	let failures = 0;
	for (const c of cases) {
		try {
			await c.fn();
			console.log(`✓ ${c.name}`);
		} catch (e: any) {
			failures++;
			console.error(`𐄂 ${c.name}`);
			console.error(e?.stack || e?.message || String(e));
		}
	}
	console.log(`\n${cases.length - failures} passed, ${failures} failed`);
	return failures;
}

export const expect = {
	toEqual<T>(actual: T, expected: T) {
		assert.deepStrictEqual(actual, expected);
	},
	toBe(actual: any, expected: any) {
		assert.strictEqual(actual, expected);
	},
	toBeTruthy(actual: any) {
		assert.ok(actual);
	},
	toContain(haystack: string, needle: string) {
		assert.ok(haystack.includes(needle), `Expected "${haystack}" to contain "${needle}"`);
	},
};


