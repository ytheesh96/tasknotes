import { HermesAvailabilityService, HERMES_DASHBOARD_START_COMMAND } from "../../../src/hermes/hermesAvailabilityService";

describe("HermesAvailabilityService", () => {
	it("reports connected when the localhost root and kanban API are reachable", async () => {
		const service = new HermesAvailabilityService({
			request: jest.fn(async (url: string) => ({ ok: true, status: 200, text: "ok" })),
			kanbanClient: {
				listBoards: jest.fn(async () => [{ slug: "default" }]),
				listAssignees: jest.fn(async () => [{ name: "peacock" }]),
			},
			detectDashboardProcessCount: jest.fn(async () => 2),
		});

		await expect(service.checkHealth()).resolves.toEqual({
			status: "connected",
			mode: "live",
			rootUrl: "http://127.0.0.1:9119/",
			apiUrl: "http://127.0.0.1:9119/api/plugins/kanban",
			canStart: true,
			warning: "Multiple Hermes dashboard processes detected; using healthy localhost:9119.",
		});
	});

	it("reports degraded when the root responds but the kanban API fails", async () => {
		const service = new HermesAvailabilityService({
			request: jest.fn(async () => ({ ok: true, status: 200, text: "ok" })),
			kanbanClient: {
				listBoards: jest.fn(async () => {
					throw new Error("API unavailable");
				}),
				listAssignees: jest.fn(async () => []),
			},
		});

		await expect(service.checkHealth()).resolves.toMatchObject({
			status: "degraded",
			mode: "cache-only",
			message: "Hermes dashboard root is reachable, but the Kanban API is unavailable.",
		});
	});

	it("reports disconnected cache-only behavior when localhost is not reachable", async () => {
		const service = new HermesAvailabilityService({
			request: jest.fn(async () => {
				throw new Error("ECONNREFUSED");
			}),
		});

		await expect(service.checkHealth()).resolves.toMatchObject({
			status: "disconnected",
			mode: "cache-only",
			message: "Hermes dashboard is not reachable at http://127.0.0.1:9119/.",
		});
	});

	it("reports disconnected read-only behavior when startup is unavailable outside desktop", async () => {
		const service = new HermesAvailabilityService({
			isStartupAvailable: () => false,
			request: jest.fn(async () => {
				throw new Error("browser context");
			}),
		});

		await expect(service.checkHealth()).resolves.toMatchObject({
			status: "disconnected",
			mode: "read-only",
			canStart: false,
			message: "Hermes dashboard is not reachable at http://127.0.0.1:9119/.",
		});
	});

	it("returns cache-only fallback options without live boards or assignees while disconnected", async () => {
		const listBoards = jest.fn(async () => [{ slug: "default" }]);
		const listAssignees = jest.fn(async () => [{ name: "peacock" }]);
		const service = new HermesAvailabilityService({
			request: jest.fn(async () => {
				throw new Error("ECONNREFUSED");
			}),
			kanbanClient: { listBoards, listAssignees },
		});

		await expect(service.getOptions("default")).resolves.toMatchObject({
			boards: [],
			assignees: [],
			statuses: ["triage", "todo", "running", "blocked", "done"],
			health: {
				status: "disconnected",
				mode: "cache-only",
			},
		});
		expect(listBoards).not.toHaveBeenCalled();
		expect(listAssignees).not.toHaveBeenCalled();
	});

	it("does not start a duplicate dashboard when localhost is already healthy", async () => {
		const spawn = jest.fn();
		const service = new HermesAvailabilityService({
			request: jest.fn(async () => ({ ok: true, status: 200, text: "ok" })),
			kanbanClient: {
				listBoards: jest.fn(async () => [{ slug: "default" }]),
				listAssignees: jest.fn(async () => []),
			},
			spawnDashboard: spawn,
		});

		const result = await service.startDashboard();

		expect(result.started).toBe(false);
		expect(result.health.status).toBe("connected");
		expect(result.message).toBe("Hermes dashboard is already running on localhost:9119.");
		expect(spawn).not.toHaveBeenCalled();
	});

	it("does not start a duplicate dashboard when localhost is degraded but reachable", async () => {
		const spawn = jest.fn();
		const service = new HermesAvailabilityService({
			request: jest.fn(async () => ({ ok: true, status: 200, text: "ok" })),
			kanbanClient: {
				listBoards: jest.fn(async () => {
					throw new Error("API unavailable");
				}),
				listAssignees: jest.fn(async () => []),
			},
			spawnDashboard: spawn,
		});

		const result = await service.startDashboard();

		expect(result.started).toBe(false);
		expect(result.health.status).toBe("degraded");
		expect(result.message).toBe(
			"Hermes dashboard is already reachable on localhost:9119, but the Kanban API is unavailable. Recheck health after resolving the API failure."
		);
		expect(spawn).not.toHaveBeenCalled();
	});

	it("starts Hermes with the exact localhost dashboard command and returns starting health", async () => {
		const spawn = jest.fn(async () => ({ pid: 1234 }));
		const request = jest
			.fn()
			.mockRejectedValueOnce(new Error("ECONNREFUSED"))
			.mockRejectedValueOnce(new Error("still starting"));
		const service = new HermesAvailabilityService({
			request,
			spawnDashboard: spawn,
		});

		const result = await service.startDashboard();

		expect(HERMES_DASHBOARD_START_COMMAND).toBe(
			"hermes dashboard --host 127.0.0.1 --port 9119 --no-open --skip-build --tui"
		);
		expect(spawn).toHaveBeenCalledWith("hermes", [
			"dashboard",
			"--host",
			"127.0.0.1",
			"--port",
			"9119",
			"--no-open",
			"--skip-build",
			"--tui",
		]);
		expect(result).toMatchObject({
			started: true,
			pid: 1234,
			health: {
				status: "starting",
				mode: "cache-only",
				canStart: true,
			},
		});
	});

	it("returns actionable startup error data when startup is unavailable", async () => {
		const spawn = jest.fn();
		const service = new HermesAvailabilityService({
			isStartupAvailable: () => false,
			request: jest.fn(async () => {
				throw new Error("browser context");
			}),
			spawnDashboard: spawn,
		});

		const result = await service.startDashboard();

		expect(result.started).toBe(false);
		expect(result.health.status).toBe("disconnected");
		expect(result.health.canStart).toBe(false);
		expect(result.error).toEqual({
			code: "startup-unavailable",
			message:
				"Starting Hermes is only available in Obsidian desktop with Node child_process access.",
			action: "Run hermes dashboard --host 127.0.0.1 --port 9119 --no-open --skip-build --tui from a local terminal, then recheck health.",
		});
		expect(spawn).not.toHaveBeenCalled();
	});
});
