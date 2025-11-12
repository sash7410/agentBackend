import { run } from "./test-helpers";
// import "./e2e-openai-completions-nonreasoning.test";
// import "./e2e-anthropic-nonreasoning.test";
// import "./e2e-openai-responses-reasoning.test";
// import "./e2e-anthropic-reasoning-stream.test";
// import "./e2e-error-normalization-openai.test";
// import "./e2e-error-normalization-anthropic.test";
import "./e2e-thinking-frames.test";

run().then((failures) => {
	process.exitCode = failures > 0 ? 1 : 0;
});


