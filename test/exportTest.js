import assert from "node:assert";
import PGBoss from "../src/index.js";
import version from "../version.json" with { type: "json" };

const currentSchemaVersion = version.schema;

const { getConstructionPlans, getMigrationPlans, getRollbackPlans } = PGBoss;

describe("export", () => {
	it("should export commands to manually build schema", () => {
		const schema = "custom";
		const plans = getConstructionPlans(schema);

		assert(plans.includes(`${schema}.job`));
		assert(plans.includes(`${schema}.version`));
	});

	it("should fail to export migration using current version", () => {
		const schema = "custom";

		try {
			getMigrationPlans(schema, currentSchemaVersion);
			assert(false, "migration plans should fail on current version");
		} catch {
			assert(true);
		}
	});

	it("should export commands to migrate", () => {
		const schema = "custom";
		const plans = getMigrationPlans(schema, currentSchemaVersion - 1);

		assert(plans, "migration plans not found");
	});

	it("should fail to export commands to roll back from invalid version", () => {
		const schema = "custom";

		try {
			getRollbackPlans(schema, -1);
			assert(false, "migration plans should fail on current version");
		} catch {
			assert(true);
		}
	});

	it("should export commands to roll back", () => {
		const schema = "custom";
		const plans = getRollbackPlans(schema, currentSchemaVersion);

		assert(plans, "rollback plans not found");
	});
});
