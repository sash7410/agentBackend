import { run } from "./test-helpers";
import "./schema-mapper.test";
import "./reasoning-mapper.test";
import "./reasoning-stream-translator.test";
import "./reasoning-service-tools.test";

run().then((failures) => {
	process.exitCode = failures > 0 ? 1 : 0;
});


