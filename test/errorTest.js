import { start } from "./testHelper.js";

describe("error", () => {
	it("should handle an error in a worker and not blow up", async function () {
		const boss = (this.test.boss = await start(this.test.bossConfig));
		const queue = this.test.bossConfig.schema;

		let processCount = 0;

		await boss.send(queue);
		await boss.send(queue);

		await new Promise((resolve) => {
			boss.work(queue, async () => {
				processCount++;

				if (processCount === 1) {
					throw new Error("test - nothing to see here");
				} else {
					resolve();
				}
			});
		});
	});
});
