import PgBoss from "../src/index.js";
import { getConnectionString } from "../test/testHelper";

async function readme() {
	const boss = new PgBoss(getConnectionString());

	boss.on("error", console.error);

	await boss.start();

	const queue = "readme-queue";

	await boss.createQueue(queue);

	const id = await boss.send(queue, { arg1: "read me" });

	console.log(`created job ${id} in queue ${queue}`);

	await boss.work(queue, async ([job]) => {
		console.log(`received job ${job.id} with data ${JSON.stringify(job.data)}`);
	});
}

readme().catch((err) => {
	console.log(err);
	process.exit(1);
});
