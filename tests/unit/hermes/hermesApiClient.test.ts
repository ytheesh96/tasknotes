import { requestUrl } from "obsidian";
import { HermesKanbanApiClient, getHermesTaskIdentity } from "../../../src/hermes/hermesApiClient";
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

	it("treats every direct TaskNotes folder as a possible board", () => {
		const task = {
			title: "Example",
			status: "triage",
			priority: "normal",
			path: "TaskNotes/Tasks/t_1234.md",
			archived: false,
			tags: ["task"],
		} satisfies TaskInfo;

		expect(getHermesTaskIdentity(task)).toEqual({
			board: "Tasks",
			id: "t_1234",
		});
	});

	it("ignores legacy Hermes custom properties for identity", () => {
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

		expect(getHermesTaskIdentity(task)).toBeNull();
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
