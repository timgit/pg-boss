import assert, { strictEqual } from "node:assert";
import { delay } from "../src/tools.js";
import { start } from "./testHelper.js";

describe("expire", () => {
	it("should expire a job", async function () {
		const boss = (this.test.boss = await start({ ...this.test.bossConfig }));
		const queue = this.test.bossConfig.schema;
		const key = this.test.bossConfig.schema;

		const jobId = await boss.send({
			name: queue,
			data: { key },
			options: { retryLimit: 0, expireInSeconds: 1 },
		});

		const [job1] = await boss.fetch(queue);

		assert(job1);

		await delay(1000);

		await boss.maintain();

		const job = await boss.getJobById(queue, jobId);

		strictEqual("failed", job.state);
	});

	it("should expire a job - cascaded config", async function () {
		const boss = (this.test.boss = await start({
			...this.test.bossConfig,
			expireInSeconds: 1,
			retryLimit: 0,
		}));
		const queue = this.test.bossConfig.schema;

		const jobId = await boss.send(queue);

		// fetch the job but don't complete it
		await boss.fetch(queue);

		await delay(1000);

		await boss.maintain();

		const job = await boss.getJobById(queue, jobId);

		strictEqual("failed", job.state);
	});
});
