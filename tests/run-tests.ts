import { run } from "./test-helpers";
import "./e2e-openai-completions-nonreasoning.test";
import "./e2e-anthropic-nonreasoning.test";
import "./e2e-openai-responses-reasoning.test";
import "./e2e-anthropic-reasoning-stream.test";

run().then((failures) => {
	process.exitCode = failures > 0 ? 1 : 0;
});


