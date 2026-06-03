import {
	getHermesManagedCreationBoard,
	HERMES_WRITE_BLOCKED_MESSAGE,
	HermesWriteGuard,
	isHermesManagedTask,
} from "../../../src/hermes/hermesWriteGuard";
import type { HermesAvailabilityHealth } from "../../../src/hermes/hermesAvailabilityService";
import type { TaskInfo } from "../../../src/types";

function health(overrides: Partial<HermesAvailabilityHealth> = {}): HermesAvailabilityHealth {
	return {
		status: "connected",
		mode: "live",
		rootUrl: "http://127.0.0.1:9119/",
		apiUrl: "http://127.0.0.1:9119/api/plugins/kanban",
		canStart: true,
		...overrides,
	};
}

function createTask(overrides: Partial<TaskInfo> = {}): TaskInfo {
	return {
		title: "Hermes task",
		status: "todo",
		priority: "normal",
		path: "TaskNotes/default/t_abc123.md",
		archived: false,
		tags: ["task", "hermes-kanban"],
		projects: ["Hermes/default"],
		contexts: [],
		...overrides,
	} as TaskInfo;
}

describe("HermesWriteGuard", () => {
	it("allows Hermes-managed writes when Hermes is live", async () => {
		const service = { recheckHealth: jest.fn(async () => health()) };
		const guard = new HermesWriteGuard({ availabilityService: service });

		await expect(guard.canWriteHermesTask(createTask())).resolves.toMatchObject({
			allowed: true,
			board: "default",
			taskId: "t_abc123",
		});
		expect(service.recheckHealth).toHaveBeenCalledTimes(1);
	});

	it("blocks Hermes-managed writes when Hermes is disconnected", async () => {
		const guard = new HermesWriteGuard({
			availabilityService: {
				recheckHealth: jest.fn(async () =>
					health({ status: "disconnected", mode: "cache-only" })
				),
			},
		});

		await expect(guard.canWriteHermesTask(createTask())).resolves.toMatchObject({
			allowed: false,
			board: "default",
			taskId: "t_abc123",
			status: "disconnected",
			mode: "cache-only",
			reason: HERMES_WRITE_BLOCKED_MESSAGE,
		});
	});

	it("guards board-path tasks even when the Hermes tag was removed", async () => {
		const service = { recheckHealth: jest.fn(async () => health({ status: "disconnected", mode: "cache-only" })) };
		const guard = new HermesWriteGuard({ availabilityService: service });

		await expect(
			guard.canWriteHermesTask(createTask({ tags: ["task"] }))
		).resolves.toMatchObject({
			allowed: false,
			board: "default",
			taskId: "t_abc123",
		});
		expect(service.recheckHealth).toHaveBeenCalledTimes(1);
	});

	it("blocks board task creation while Hermes is degraded", async () => {
		const guard = new HermesWriteGuard({
			availabilityService: {
				recheckHealth: jest.fn(async () => health({ status: "degraded", mode: "cache-only" })),
			},
		});

		await expect(guard.assertCanCreateHermesTask("default")).rejects.toThrow(
			"Hermes is partially available; writes are disabled until recheck succeeds."
		);
	});

	it("does not check availability for non-Hermes tasks", async () => {
		const service = { recheckHealth: jest.fn(async () => health({ status: "disconnected" })) };
		const guard = new HermesWriteGuard({ availabilityService: service });

		await expect(
			guard.canWriteHermesTask(
				createTask({ path: "TaskNotes/Tasks/local.md", tags: ["task"] })
			)
		).resolves.toMatchObject({ allowed: true });
		expect(service.recheckHealth).not.toHaveBeenCalled();
	});

	it("treats path identity as sufficient for managed existing tasks", () => {
		expect(isHermesManagedTask(createTask())).toBe(true);
		expect(isHermesManagedTask(createTask({ tags: ["task"] }))).toBe(true);
		expect(isHermesManagedTask(createTask({ path: "TaskNotes/Tasks/local.md" }))).toBe(false);
	});

	it("detects Hermes board creation routing from projects and tags", () => {
		expect(
			getHermesManagedCreationBoard({
				projects: ["Hermes/default"],
				tags: ["task", "hermes-kanban"],
			})
		).toBe("default");
		expect(getHermesManagedCreationBoard({ projects: ["Personal"], tags: ["task"] })).toBeNull();
	});
});
