import { run } from "./test-helpers";
import "./schema-mapper.test";

run().then((failures) => {
	process.exitCode = failures > 0 ? 1 : 0;
});


