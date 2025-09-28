import assert, { strictEqual } from "node:assert";
import { getDb, start } from "./testHelper.js";

describe("fetch", () => {
	it("should reject missing queue argument", async function () {
		const boss = (this.test.boss = await start(this.test.bossConfig));

		try {
			await boss.fetch();
			assert(false);
		} catch (err) {
			assert(err);
		}
	});

	it("should fetch a job by name manually", async function () {
		const boss = (this.test.boss = await start(this.test.bossConfig));
		const queue = this.test.bossConfig.schema;

		await boss.send(queue);
		const [job] = await boss.fetch(queue);
		assert(queue === job.name);
		// Metadata should only be included when specifically requested
		assert(job.startedOn === undefined);
	});

	it("should get a batch of jobs as an array", async function () {
		const boss = (this.test.boss = await start(this.test.bossConfig));
		const queue = this.test.bossConfig.schema;
		const batchSize = 4;

		await Promise.all([
			boss.send(queue),
			boss.send(queue),
			boss.send(queue),
			boss.send(queue),
		]);

		const jobs = await boss.fetch(queue, { batchSize });

		assert(jobs.length === batchSize);
		// Metadata should only be included when specifically requested
		assert(jobs[0].startedOn === undefined);
	});

	it("should fetch all metadata for a single job when requested", async function () {
		const boss = (this.test.boss = await start(this.test.bossConfig));
		const queue = this.test.bossConfig.schema;

		await boss.send(queue);
		const [job] = await boss.fetch(queue, { includeMetadata: true });

		assert(queue === job.name);
		assert(job.priority === 0);
		assert(job.state === "active");
		assert(job.policy !== undefined);
		assert(job.retryLimit === 0);
		assert(job.retryCount === 0);
		assert(job.retryDelay === 0);
		assert(job.retryBackoff === false);
		assert(job.startAfter !== undefined);
		assert(job.startedOn !== undefined);
		assert(job.singletonKey === null);
		assert(job.singletonOn === null);
		assert(job.expireIn.minutes === 15);
		assert(job.createdOn !== undefined);
		assert(job.completedOn === null);
		assert(job.keepUntil !== undefined);
	});

	it("should fetch all metadata for a batch of jobs when requested", async function () {
		const boss = (this.test.boss = await start(this.test.bossConfig));
		const queue = this.test.bossConfig.schema;
		const batchSize = 4;

		await Promise.all([
			boss.send(queue),
			boss.send(queue),
			boss.send(queue),
			boss.send(queue),
		]);

		const jobs = await boss.fetch(queue, { batchSize, includeMetadata: true });
		assert(jobs.length === batchSize);

		for (const job of jobs) {
			assert(queue === job.name);
			assert(job.priority === 0);
			assert(job.state === "active");
			assert(job.policy !== undefined);
			assert(job.retryLimit === 0);
			assert(job.retryCount === 0);
			assert(job.retryDelay === 0);
			assert(job.retryBackoff === false);
			assert(job.startAfter !== undefined);
			assert(job.startedOn !== undefined);
			assert(job.singletonKey === null);
			assert(job.singletonOn === null);
			assert(job.expireIn.minutes === 15);
			assert(job.createdOn !== undefined);
			assert(job.completedOn === null);
			assert(job.keepUntil !== undefined);
		}
	});

	it("should fetch a job with custom connection", async function () {
		const boss = (this.test.boss = await start(this.test.bossConfig));
		const queue = this.test.bossConfig.schema;

		let calledCounter = 0;
		const db = await getDb();
		const options = {
			db: {
				async executeSql(sql, values) {
					calledCounter++;
					return db.pool.query(sql, values);
				},
			},
		};

		await boss.send(queue, {}, options);
		const [job] = await boss.fetch(queue, { ...options, batchSize: 10 });
		assert(queue === job.name);
		assert(job.startedOn === undefined);
		strictEqual(calledCounter, 2);
	});

	it("should allow fetching jobs that have a start_after in the future", async function () {
		const boss = (this.test.boss = await start(this.test.bossConfig));
		const queue = this.test.bossConfig.schema;

		await boss.send(queue, { startAfter: new Date(Date.now() + 1000) });
		const db = await getDb();
		const sqlStatements = [];
		const options = {
			db: {
				async executeSql(sql, values) {
					sqlStatements.push(sql);
					return db.pool.query(sql, values);
				},
			},
		};

		const jobs = await boss.fetch(queue, {
			...options,
			ignoreStartAfter: true,
		});
		assert(jobs.length === 1);
		assert(sqlStatements.length === 1);
		assert(!sqlStatements[0].includes("start_after < now()"));
	});
});
