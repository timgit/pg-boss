import assert, { strictEqual } from "node:assert";
import PgBoss from "../src/index.js";
import { delay } from "../src/tools.js";

describe("background processing error handling", () => {
	it("maintenance error handling works", async function () {
		const defaults = {
			maintenanceIntervalSeconds: 1,
			supervise: true,
			__test__throw_maint: "my maintenance error",
		};

		const config = { ...this.test.bossConfig, ...defaults };
		const boss = (this.test.boss = new PgBoss(config));

		let errorCount = 0;

		boss.once("error", (error) => {
			strictEqual(error.message, config.__test__throw_maint);
			errorCount++;
		});

		await boss.start();

		await delay(3000);

		strictEqual(errorCount, 1);
	});

	it("slow maintenance will back off loop interval", async function () {
		const config = {
			...this.test.bossConfig,
			maintenanceIntervalSeconds: 1,
			supervise: true,
			__test__delay_maintenance: 2000,
		};

		const boss = (this.test.boss = new PgBoss(config));

		let eventCount = 0;

		boss.on("maintenance", () => eventCount++);

		await boss.start();

		await delay(5000);

		strictEqual(eventCount, 1);
	});

	it("slow monitoring will back off loop interval", async function () {
		const config = {
			...this.test.bossConfig,
			monitorStateIntervalSeconds: 1,
			__test__delay_monitor: 2000,
		};

		const boss = (this.test.boss = new PgBoss(config));

		let eventCount = 0;

		boss.on("monitor-states", () => eventCount++);

		await boss.start();

		await delay(4000);

		strictEqual(eventCount, 1);
	});

	it("state monitoring error handling works", async function () {
		const defaults = {
			monitorStateIntervalSeconds: 1,
			supervise: true,
			__test__throw_monitor: "my monitor error",
		};

		const config = { ...this.test.bossConfig, ...defaults };
		const boss = (this.test.boss = new PgBoss(config));

		let errorCount = 0;

		boss.once("error", (error) => {
			strictEqual(error.message, config.__test__throw_monitor);
			errorCount++;
		});

		await boss.start();

		await delay(3000);

		strictEqual(errorCount, 1);
	});

	it("shutdown monitoring error handling works", async function () {
		const config = {
			...this.test.bossConfig,
			__test__throw_shutdown: "shutdown error",
		};

		const boss = (this.test.boss = new PgBoss(config));

		let errorCount = 0;

		boss.once("error", (error) => {
			strictEqual(error.message, config.__test__throw_shutdown);
			errorCount++;
		});

		await boss.start();

		await boss.stop({ wait: false });

		await delay(1000);

		strictEqual(errorCount, 1);
	});

	it("shutdown error handling works", async function () {
		const config = {
			...this.test.bossConfig,
			__test__throw_stop_monitor: "monitor error",
		};

		const boss = (this.test.boss = new PgBoss(config));

		await boss.start();

		try {
			await boss.stop({ wait: false });
			assert(false);
		} catch (_err) {
			assert(true);
		}
	});
});
