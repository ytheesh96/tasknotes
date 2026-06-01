import { requestUrl } from "obsidian";
import { HermesKanbanApiClient, getHermesTaskIdentity } from "../../../src/hermes/hermesApiClient";
import type { TaskInfo } from "../../../src/types";

describe("HermesKanbanApiClient", () => {
	const originalFetch = global.fetch;
	const requestUrlMock = requestUrl as jest.Mock;

	beforeEach(() => {
		global.fetch = jest.fn();
		requestUrlMock.mockReset();
	});

	afterEach(() => {
		global.fetch = originalFetch;
		jest.restoreAllMocks();
	});

	it("resolves board and task id from the Hermes mirror path", () => {
		const task = {
			title: "Example",
			status: "triage",
			priority: "normal",
			path: "TaskNotes/Hermes/default/t_1234.md",
			archived: false,
			tags: ["task", "hermes-kanban"],
		} satisfies TaskInfo;

		expect(getHermesTaskIdentity(task)).toEqual({
			board: "default",
			id: "t_1234",
		});
	});

	it("falls back to legacy Hermes custom properties for old mirrors", () => {
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

		expect(getHermesTaskIdentity(task)).toEqual({
			board: "obsidian-os",
			id: "t_abcd",
		});
	});

	it("posts created tasks to the board-scoped Hermes API", async () => {
		(global.fetch as jest.Mock).mockResolvedValue(
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
		expect(global.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:9119/api/plugins/kanban/tasks?board=obsidian-os",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					title: "New task",
					triage: true,
					priority: 3,
				}),
			})
		);
	});

	it("can request an initially blocked Hermes task with a block reason", async () => {
		(global.fetch as jest.Mock).mockResolvedValue(
			jsonResponse({
				task: { id: "t_human", title: "Human task", status: "blocked" },
			})
		);
		const api = new HermesKanbanApiClient("http://127.0.0.1:9119/api/plugins/kanban");

		const created = await api.createTask("default", {
			title: "Human task",
			assignee: "human",
			initial_status: "blocked",
			block_reason: "Waiting on human: human",
		});

		expect(created.status).toBe("blocked");
		expect(global.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:9119/api/plugins/kanban/tasks?board=default",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					title: "Human task",
					assignee: "human",
					initial_status: "blocked",
					block_reason: "Waiting on human: human",
				}),
			})
		);
	});

	it("surfaces Hermes API error details", async () => {
		(global.fetch as jest.Mock).mockResolvedValue(
			jsonResponse({ detail: "Cannot set status to running" }, 400, "Bad Request")
		);
		const api = new HermesKanbanApiClient();

		await expect(
			api.updateTask({ board: "default", id: "t_bad" }, { status: "running" })
		).rejects.toThrow("Cannot set status to running");
	});

	it("discovers the dashboard session token and retries unauthorized requests", async () => {
		(global.fetch as jest.Mock)
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
		expect(global.fetch).toHaveBeenNthCalledWith(
			3,
			"http://127.0.0.1:9119/api/plugins/kanban/tasks/t_retry?board=default",
			expect.objectContaining({
				headers: expect.objectContaining({
					Authorization: "Bearer test-token",
				}),
			})
		);
	});

	it("falls back to Obsidian requestUrl when browser fetch is blocked", async () => {
		(global.fetch as jest.Mock).mockRejectedValueOnce(new TypeError("Failed to fetch"));
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
});

function jsonResponse(body: unknown, status = 200, statusText = "OK"): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText,
		json: async () => body,
	} as Response;
}

function textResponse(body: string, status = 200, statusText = "OK"): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText,
		text: async () => body,
	} as Response;
}
