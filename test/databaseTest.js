import assert from "node:assert";
import PgBoss from "../src/index.js";

describe("database", () => {
	it("should fail on invalid database host", async () => {
		const boss = new PgBoss("postgres://bobby:tables@wat:12345/northwind");

		try {
			await boss.start();
			assert(false);
		} catch (_err) {
			assert(true);
		}
	});

	it("can be swapped out via BYODB", async () => {
		const query = "SELECT something FROM somewhere";

		const mydb = {
			executeSql: async (text, _values) => ({ rows: [], text }),
		};

		const boss = new PgBoss({ db: mydb });
		const response = await boss.getDb().executeSql(query);

		assert(response.text === query);
	});
});
