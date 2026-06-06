import { requestUrl } from "obsidian";
import {
	HermesApiError,
	HermesKanbanApiClient,
	getHermesTaskIdentity,
} from "../../../src/hermes/hermesApiClient";
import type { TaskInfo } from "../../../src/types";

describe("HermesKanbanApiClient", () => {
	const requestUrlMock = requestUrl as jest.Mock;

	beforeEach(() => {
		requestUrlMock.mockReset();
	});

	afterEach(() => {
		jest.restoreAllMocks();
	});

	it("resolves board and task id from the TaskNotes control-panel path", () => {
		const task = {
			title: "Example",
			status: "triage",
			priority: "normal",
			path: "TaskNotes/default/t_1234.md",
			archived: false,
			tags: ["task", "hermes-kanban"],
		} satisfies TaskInfo;

		expect(getHermesTaskIdentity(task)).toEqual({
			board: "default",
			id: "t_1234",
		});
	});

	it("does not treat legacy Hermes mirror paths as board task identities", () => {
		const task = {
			title: "Example",
			status: "triage",
			priority: "normal",
			path: "TaskNotes/Hermes/default/t_1234.md",
			archived: false,
		} satisfies TaskInfo;

		expect(getHermesTaskIdentity(task)).toBeNull();
	});

	it("does not treat reserved TaskNotes folders as board task identities", () => {
		const task = {
			title: "Example",
			status: "triage",
			priority: "normal",
			path: "TaskNotes/Tasks/t_1234.md",
			archived: false,
			tags: ["task"],
		} satisfies TaskInfo;

		expect(getHermesTaskIdentity(task)).toBeNull();
	});

	it("treats direct TaskNotes board folders as board task identities", () => {
		const task = {
			title: "Example",
			status: "triage",
			priority: "normal",
			path: "TaskNotes/job-hunt/t_1234.md",
			archived: false,
			tags: ["task"],
		} satisfies TaskInfo;

		expect(getHermesTaskIdentity(task)).toEqual({
			board: "job-hunt",
			id: "t_1234",
		});
	});

	it("honors legacy Hermes custom properties for identity recovery", () => {
		const task = {
			title: "Example",
			status: "triage",
			priority: "normal",
			path: "Tasks/example.md",
			archived: false,
			customProperties: {
				hermes_board: "obsidian-os",
				hermes_id: "t_abcd",
			},
		} satisfies TaskInfo;

		expect(getHermesTaskIdentity(task)).toEqual({ board: "obsidian-os", id: "t_abcd" });
	});

	it("checks the localhost dashboard root used by the kanban API", async () => {
		requestUrlMock.mockResolvedValueOnce(textResponse("ok"));
		const api = new HermesKanbanApiClient("http://127.0.0.1:9119/api/plugins/kanban");

		const health = await api.checkRoot();

		expect(health).toEqual({ ok: true, status: 200, text: "ok" });
		expect(requestUrlMock).toHaveBeenCalledWith({
			url: "http://127.0.0.1:9119/",
			throw: false,
		});
	});

	it("posts created tasks to the board-scoped Hermes API", async () => {
		requestUrlMock.mockResolvedValue(
			jsonResponse({
				task: { id: "t_new", title: "New task", status: "triage" },
			})
		);
		const api = new HermesKanbanApiClient("http://127.0.0.1:9119/api/plugins/kanban");

		const created = await api.createTask("obsidian-os", {
			title: "New task",
			triage: true,
			priority: 3,
		});

		expect(created.id).toBe("t_new");
		expect(requestUrlMock).toHaveBeenCalledWith(
			expect.objectContaining({
				url: "http://127.0.0.1:9119/api/plugins/kanban/tasks?board=obsidian-os",
				method: "POST",
				body: JSON.stringify({
					title: "New task",
					triage: true,
					priority: 3,
				}),
				throw: false,
			})
		);
	});

	it("can request an explicitly blocked board task with a block reason", async () => {
		requestUrlMock.mockResolvedValue(
			jsonResponse({
				task: { id: "t_blocked", title: "Blocked task", status: "blocked" },
			})
		);
		const api = new HermesKanbanApiClient("http://127.0.0.1:9119/api/plugins/kanban");

		const created = await api.createTask("default", {
			title: "Blocked task",
			assignee: "peacock",
			initial_status: "blocked",
			block_reason: "Waiting on external dependency",
		});

		expect(created.status).toBe("blocked");
		expect(requestUrlMock).toHaveBeenCalledWith(
			expect.objectContaining({
				url: "http://127.0.0.1:9119/api/plugins/kanban/tasks?board=default",
				method: "POST",
				body: JSON.stringify({
					title: "Blocked task",
					assignee: "peacock",
					initial_status: "blocked",
					block_reason: "Waiting on external dependency",
				}),
				throw: false,
			})
		);
	});

	it("surfaces Hermes API error details", async () => {
		requestUrlMock.mockResolvedValue(
			jsonResponse({ detail: "Cannot set status to running" }, 400, "Bad Request")
		);
		const api = new HermesKanbanApiClient();

		await expect(
			api.updateTask({ board: "default", id: "t_bad" }, { status: "running" })
		).rejects.toThrow("Cannot set status to running");
		await expect(
			api.updateTask({ board: "default", id: "t_bad" }, { status: "running" })
		).rejects.toMatchObject({
			name: "HermesApiError",
			status: 400,
		} satisfies Partial<HermesApiError>);
	});

	it("discovers the dashboard session token and retries unauthorized requests", async () => {
		requestUrlMock
			.mockResolvedValueOnce(jsonResponse({ detail: "Unauthorized" }, 401, "Unauthorized"))
			.mockResolvedValueOnce(
				textResponse('<script>window.__HERMES_SESSION_TOKEN__="test-token";</script>')
			)
			.mockResolvedValueOnce(
				jsonResponse({
					task: { id: "t_retry", title: "Retry", status: "blocked" },
				})
			);
		const api = new HermesKanbanApiClient("http://127.0.0.1:9119/api/plugins/kanban");

		const updated = await api.updateTask(
			{ board: "default", id: "t_retry" },
			{ status: "blocked" }
		);

		expect(updated.id).toBe("t_retry");
		expect(requestUrlMock).toHaveBeenNthCalledWith(
			3,
			expect.objectContaining({
				url: "http://127.0.0.1:9119/api/plugins/kanban/tasks/t_retry?board=default",
				headers: expect.objectContaining({
					Authorization: "Bearer test-token",
				}),
			})
		);
	});

	it("uses Obsidian requestUrl for board detail requests", async () => {
		requestUrlMock.mockResolvedValueOnce({
			status: 200,
			json: {
				task: { id: "t_detail", title: "Detail", status: "done" },
				comments: [{ author: "worker", body: "done", created_at: 1770000000 }],
				events: [],
				runs: [],
			},
			text: "",
		});
		const api = new HermesKanbanApiClient("http://127.0.0.1:9119/api/plugins/kanban");

		const detail = await api.getTask({ board: "default", id: "t_detail" });

		expect(detail.task?.id).toBe("t_detail");
		expect(requestUrlMock).toHaveBeenCalledWith(
			expect.objectContaining({
				url: "http://127.0.0.1:9119/api/plugins/kanban/tasks/t_detail?board=default",
				method: "GET",
				throw: false,
			})
		);
	});

	it("reads board state with archived tasks included", async () => {
		requestUrlMock.mockResolvedValueOnce(
			jsonResponse({
				columns: [
					{
						name: "done",
						tasks: [{ id: "t_done", title: "Done", status: "done" }],
					},
				],
				latest_event_id: 42,
			})
		);
		const api = new HermesKanbanApiClient("http://127.0.0.1:9119/api/plugins/kanban");

		const board = await api.getBoard("obsidian-os", { includeArchived: true });

		expect(board.columns?.[0]?.tasks[0]?.id).toBe("t_done");
		expect(requestUrlMock).toHaveBeenCalledWith(
			expect.objectContaining({
				url: "http://127.0.0.1:9119/api/plugins/kanban/board?board=obsidian-os&include_archived=true",
				method: "GET",
				throw: false,
			})
		);
	});

	it("requests and preserves run-grouped board swimlanes with backend query parameters", async () => {
		requestUrlMock.mockResolvedValueOnce(
			jsonResponse({
				columns: [],
				run_lanes: [
					{
						id: "run_active",
						title: "Active run",
						run_type: "user",
						counts: { total: 2, active: 2 },
						columns: [
							{
								name: "running",
								tasks: [{ id: "t_running", title: "Running", status: "running" }],
							},
						],
					},
				],
			})
		);
		const api = new HermesKanbanApiClient("http://127.0.0.1:9119/api/plugins/kanban");

		const board = await api.getBoard("obsidian-os", {
			groupBy: "run",
			runScope: "direct",
			runId: "run_active",
		});

		expect(board.run_lanes?.[0]?.id).toBe("run_active");
		expect(board.run_lanes?.[0]?.columns?.[0]?.tasks[0]?.id).toBe("t_running");
		expect(requestUrlMock).toHaveBeenCalledWith(
			expect.objectContaining({
			url: "http://127.0.0.1:9119/api/plugins/kanban/board?board=obsidian-os&group_by=run&run_scope=direct&run_id=run_active",
				method: "GET",
				throw: false,
			})
		);
	});

	it("posts explicit run reassignment payloads and preserves returned audit fields", async () => {
		requestUrlMock.mockResolvedValueOnce(
			jsonResponse({
				task: {
					id: "t_run",
					title: "Run task",
					status: "todo",
					run_id: "run_target",
					run_assignment_source: "dashboard_edit",
				},
			})
		);
		const api = new HermesKanbanApiClient("http://127.0.0.1:9119/api/plugins/kanban");

		const task = await api.assignTaskRun(
			{ board: "obsidian-os", id: "t_run" },
			{ runId: "run_target", source: "dashboard_edit", actor: "tasknotes" }
		);

		expect(task.run_id).toBe("run_target");
		expect(task.run_assignment_source).toBe("dashboard_edit");
		expect(requestUrlMock).toHaveBeenCalledWith(
			expect.objectContaining({
				url: "http://127.0.0.1:9119/api/plugins/kanban/tasks/t_run/run?board=obsidian-os",
				method: "POST",
				body: JSON.stringify({
					run_id: "run_target",
					source: "dashboard_edit",
					actor: "tasknotes",
				}),
				throw: false,
			})
		);
	});

	it("posts explicit unset to move a task to No run", async () => {
		requestUrlMock.mockResolvedValueOnce(
			jsonResponse({ task: { id: "t_run", title: "Run task", status: "todo", run_id: null } })
		);
		const api = new HermesKanbanApiClient("http://127.0.0.1:9119/api/plugins/kanban");

		const task = await api.assignTaskRun(
			{ board: "obsidian-os", id: "t_run" },
			{ runId: null, source: "unset", actor: "tasknotes" }
		);

		expect(task.run_id).toBeNull();
		expect(requestUrlMock).toHaveBeenCalledWith(
			expect.objectContaining({
				body: JSON.stringify({ run_id: null, source: "unset", actor: "tasknotes" }),
			})
		);
	});

	it("builds authenticated Hermes event stream URLs", async () => {
		requestUrlMock.mockResolvedValueOnce(
			textResponse('<script>window.__HERMES_SESSION_TOKEN__="test-token";</script>')
		);
		const api = new HermesKanbanApiClient("http://127.0.0.1:9119/api/plugins/kanban");

		const url = await api.getEventStreamUrl("default", 123);

		expect(url).toBe(
			"ws://127.0.0.1:9119/api/plugins/kanban/events?since=123&token=test-token&board=default"
		);
		expect(requestUrlMock).toHaveBeenCalledWith({
			url: "http://127.0.0.1:9119/",
			throw: false,
		});
	});

	it("creates Hermes boards through the board API", async () => {
		requestUrlMock.mockResolvedValueOnce(
			jsonResponse({
				board: { slug: "new-board", name: "New Board" },
			})
		);
		const api = new HermesKanbanApiClient("http://127.0.0.1:9119/api/plugins/kanban");

		const board = await api.createBoard({
			slug: "new-board",
			name: "New Board",
		});

		expect(board.slug).toBe("new-board");
		expect(requestUrlMock).toHaveBeenCalledWith(
			expect.objectContaining({
				url: "http://127.0.0.1:9119/api/plugins/kanban/boards",
				method: "POST",
				body: JSON.stringify({
					slug: "new-board",
					name: "New Board",
				}),
				throw: false,
			})
		);
	});

	it("archives Hermes boards through the board API by default", async () => {
		requestUrlMock.mockResolvedValueOnce(
			jsonResponse({
				result: { slug: "old-board", action: "archived" },
			})
		);
		const api = new HermesKanbanApiClient("http://127.0.0.1:9119/api/plugins/kanban");

		await api.deleteBoard("old-board");

		expect(requestUrlMock).toHaveBeenCalledWith(
			expect.objectContaining({
				url: "http://127.0.0.1:9119/api/plugins/kanban/boards/old-board",
				method: "DELETE",
				throw: false,
			})
		);
	});
});

function jsonResponse(body: unknown, status = 200, statusText = "OK") {
	return {
		status,
		statusText,
		json: body,
		text: JSON.stringify(body),
	};
}

function textResponse(body: string, status = 200, statusText = "OK") {
	return {
		status,
		statusText,
		text: body,
	};
}
