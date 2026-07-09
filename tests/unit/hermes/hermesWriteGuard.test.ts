import {
	getHermesManagedCreationBoard,
	getUnsupportedHermesBoardMove,
	getUnsupportedHermesBoardMoveExplanation,
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
		path: "TaskNotes/Tasks/t_abc123.md",
		archived: false,
		tags: ["task"],
		projects: [],
		contexts: [],
		customProperties: { hermesTaskId: "t_abc123", hermesBoard: "default" },
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

	it("allows Hermes-managed writes when kanban-cli health is writable without dashboard health", async () => {
		const service = {
			recheckHealth: jest.fn(async (options?: { board?: string }) =>
				health({
					status: "connected",
					mode: "live",
					transport: "kanban-cli",
					writeStatus: "writable-via-cli",
					message: `Hermes Kanban CLI is available for board ${options?.board}.`,
				})
			),
		};
		const guard = new HermesWriteGuard({ availabilityService: service });

		await expect(guard.canWriteHermesTask(createTask())).resolves.toMatchObject({
			allowed: true,
			board: "default",
			taskId: "t_abc123",
			health: { transport: "kanban-cli", writeStatus: "writable-via-cli" },
		});
		expect(service.recheckHealth).toHaveBeenCalledWith({
			board: "default",
			transport: "kanban-cli",
		});
	});

	it("passes the selected transport into availability rechecks", async () => {
		const service = { recheckHealth: jest.fn(async () => health()) };
		const guard = new HermesWriteGuard({
			availabilityService: service,
			transport: "kanban-cli",
		});

		await expect(guard.canCreateHermesTask("default")).resolves.toMatchObject({ allowed: true });
		expect(service.recheckHealth).toHaveBeenCalledWith({
			board: "default",
			transport: "kanban-cli",
		});
	});

	it("uses CLI-specific blocked messages when the selected CLI transport cannot write", async () => {
		const guard = new HermesWriteGuard({
			availabilityService: {
				recheckHealth: jest.fn(async () =>
					health({
						status: "degraded",
						mode: "read-only",
						transport: "kanban-cli",
						writeStatus: "board-unavailable",
						message: "Hermes board default is not available through the CLI.",
					})
				),
			},
		});

		await expect(guard.assertCanCreateHermesTask("default")).rejects.toThrow(
			"Hermes board default is not available through the CLI."
		);
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
				createTask({ path: "TaskNotes/Tasks/local.md", tags: ["task"], customProperties: {} })
			)
		).resolves.toMatchObject({ allowed: true });
		expect(service.recheckHealth).not.toHaveBeenCalled();
	});

	it("treats path identity as sufficient for managed existing tasks", () => {
		expect(isHermesManagedTask(createTask())).toBe(true);
		expect(isHermesManagedTask(createTask({ tags: ["task"] }))).toBe(true);
		expect(
			isHermesManagedTask(
				createTask({ path: "TaskNotes/Tasks/local.md", customProperties: {} })
			)
		).toBe(false);
	});

	it("detects unsupported local Hermes board moves before writeback", () => {
		const originalTask = createTask({
			path: "TaskNotes/Tasks/t_move.md",
			customProperties: { hermesTaskId: "t_move", hermesBoard: "default" },
		});
		const updatedTask = createTask({
			path: "TaskNotes/Tasks/t_move.md",
			customProperties: { hermesTaskId: "t_move", hermesBoard: "developer" },
		});

		expect(getUnsupportedHermesBoardMove(originalTask, updatedTask)).toEqual({
			taskId: "t_move",
			fromBoard: "default",
			toBoard: "developer",
		});
		expect(getUnsupportedHermesBoardMoveExplanation(originalTask, updatedTask)).toContain(
			"does not expose a board-move endpoint"
		);
		expect(getUnsupportedHermesBoardMove(originalTask, originalTask)).toBeNull();
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
