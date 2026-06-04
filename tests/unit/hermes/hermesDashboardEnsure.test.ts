import TaskNotesPlugin from "../../../src/main";
import {
	HERMES_DASHBOARD_START_COMMAND,
	HermesAvailabilityService,
	type HermesAvailabilityHealth,
	type HermesDashboardStartResult,
} from "../../../src/hermes/hermesAvailabilityService";

jest.mock("obsidian");

function createPlugin(): TaskNotesPlugin {
	const plugin = Object.create(TaskNotesPlugin.prototype) as TaskNotesPlugin;
	plugin.settings = {
		hermesStartCommand: HERMES_DASHBOARD_START_COMMAND,
	} as never;
	return plugin;
}

function health(overrides: Partial<HermesAvailabilityHealth>): HermesAvailabilityHealth {
	return {
		status: "connected",
		mode: "live",
		rootUrl: "http://127.0.0.1:9119/",
		apiUrl: "http://127.0.0.1:9119/api/plugins/kanban",
		canStart: true,
		...overrides,
	};
}

function startResult(
	overrides: Partial<HermesDashboardStartResult> = {}
): HermesDashboardStartResult {
	return {
		started: true,
		pid: 9119,
		command: HERMES_DASHBOARD_START_COMMAND,
		health: health({ status: "starting", mode: "cache-only" }),
		...overrides,
	};
}

describe("Hermes dashboard ensure", () => {
	afterEach(() => {
		jest.restoreAllMocks();
	});

	it("polls a started dashboard until the Kanban API is live", async () => {
		const plugin = createPlugin();
		jest.spyOn(HermesAvailabilityService.prototype, "startDashboard").mockResolvedValue(
			startResult()
		);
		const recheckHealth = jest
			.spyOn(HermesAvailabilityService.prototype, "recheckHealth")
			.mockResolvedValueOnce(health({ status: "starting", mode: "cache-only" }))
			.mockResolvedValueOnce(health({ status: "connected", mode: "live" }));

		const result = await plugin.ensureHermesDashboardRunning({
			pollAttempts: 2,
			pollIntervalMs: 0,
		});

		expect(result.health.status).toBe("connected");
		expect(result.health.mode).toBe("live");
		expect(recheckHealth).toHaveBeenCalledTimes(2);
	});

	it("shares an in-flight dashboard startup across callers", async () => {
		const plugin = createPlugin();
		let resolveStart: (result: HermesDashboardStartResult) => void = () => undefined;
		const pendingStart = new Promise<HermesDashboardStartResult>((resolve) => {
			resolveStart = resolve;
		});
		const startDashboard = jest
			.spyOn(HermesAvailabilityService.prototype, "startDashboard")
			.mockReturnValue(pendingStart);

		const first = plugin.ensureHermesDashboardRunning({ pollIntervalMs: 0 });
		const second = plugin.ensureHermesDashboardRunning({ pollIntervalMs: 0 });
		resolveStart(startResult({ health: health({ status: "connected", mode: "live" }) }));
		await Promise.all([first, second]);

		expect(startDashboard).toHaveBeenCalledTimes(1);
	});
});
