import PgBoss from "../src/index.js";
import { getConnectionString } from "../test/testHelper";

async function schedule() {
	const boss = new PgBoss(getConnectionString());

	boss.on("error", console.error);

	await boss.start();

	const queue = "scheduled-queue";

	await boss.createQueue(queue);

	await boss.schedule(queue, "*/2 * * * *", { arg1: "schedule me" });

	await boss.work(queue, async ([job]) => {
		console.log(
			`received job ${job.id} with data ${JSON.stringify(job.data)} on ${new Date().toISOString()}`,
		);
	});
}

schedule().catch((err) => {
	console.log(err);
	process.exit(1);
});
