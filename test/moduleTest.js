import assert from "node:assert";
import PGBoss from "../src/index.js";

describe("module", () => {
	it("should export states object", () => {
		const states = PGBoss.states;

		assert(states.created);
		assert(states.retry);
		assert(states.active);
		assert(states.completed);
		assert(states.cancelled);
		assert(states.failed);
	});
});
