import { strictEqual } from "node:assert";
import { delay } from "../src/tools.js";
import { getDb, start } from "./testHelper.js";

describe("maintenance", async () => {
	it("clearStorage() should empty both job storage tables", async function () {
		const boss = (this.test.boss = await start({
			...this.test.bossConfig,
			archiveCompletedAfterSeconds: 1,
		}));
		const queue = this.test.bossConfig.schema;

		const jobId = await boss.send(queue);
		await boss.fetch(queue);
		await boss.complete(queue, jobId);

		await delay(1000);
		await boss.maintain();

		await boss.send(queue);

		const db = await getDb();

		const getJobCount = async (table) => {
			const jobCountResult = await db.executeSql(
				`SELECT count(*)::int as job_count FROM ${this.test.bossConfig.schema}.${table}`,
			);
			return jobCountResult.rows[0].job_count;
		};

		const preJobCount = await getJobCount("job");
		const preArchiveCount = await getJobCount("archive");

		strictEqual(preJobCount, 1);
		strictEqual(preArchiveCount, 1);

		await boss.clearStorage();

		const postJobCount = await getJobCount("job");
		const postArchiveCount = await getJobCount("archive");

		strictEqual(postJobCount, 0);
		strictEqual(postArchiveCount, 0);
	});
});
