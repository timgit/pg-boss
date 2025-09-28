import assert from "node:assert";
import { getArchivedJobById, start } from "./testHelper.js";

describe("delete", async () => {
	it("should delete an archived via maintenance", async function () {
		const config = { ...this.test.bossConfig, deleteAfterSeconds: 1 };
		const boss = (this.test.boss = await start(config));
		const queue = this.test.bossConfig.schema;

		const jobId = await boss.send(queue);

		await boss.fetch(queue);

		await boss.complete(queue, jobId);

		await boss.maintain();

		const archivedJob = await getArchivedJobById(config.schema, queue, jobId);

		assert(!archivedJob);
	});

	it("should delete a job via deleteJob()", async function () {
		const config = { ...this.test.bossConfig };
		const boss = (this.test.boss = await start(config));
		const queue = config.schema;

		const jobId = await boss.send(queue);

		await boss.fetch(queue);

		await boss.deleteJob(queue, jobId);

		const job = await boss.getJobById(queue, jobId);

		assert(!job);
	});
});
