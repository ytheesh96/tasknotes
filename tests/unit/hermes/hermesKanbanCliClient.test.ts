import {
	HermesKanbanCliClient,
	createHermesKanbanClient,
} from "../../../src/hermes/hermesKanbanTransport";

describe("HermesKanbanCliClient", () => {
	it("creates triage tasks through hermes kanban CLI without shell interpolation", async () => {
		const execFile = jest.fn((_command, _args, _options, callback) => {
			callback(null, JSON.stringify({ id: "t_new", title: "New task", status: "triage" }), "");
		});
		const client = new HermesKanbanCliClient({ execFile, hermesCommand: "hermes" });

		const created = await client.createTask("research-team", {
			title: "New task",
			body: "Task body",
			triage: true,
			priority: 4,
			parents: ["t_parent"],
			idempotency_key: "tasknotes:new-task",
			created_by: "tasknotes",
		});

		expect(created).toEqual({ id: "t_new", title: "New task", status: "triage" });
		expect(execFile).toHaveBeenCalledTimes(1);
		expect(execFile).toHaveBeenCalledWith(
			"hermes",
			[
				"kanban",
				"--board",
				"research-team",
				"create",
				"New task",
				"--body",
				"Task body",
				"--triage",
				"--priority",
				"4",
				"--parent",
				"t_parent",
				"--idempotency-key",
				"tasknotes:new-task",
				"--created-by",
				"tasknotes",
				"--json",
			],
			expect.objectContaining({ shell: false, timeout: 15000 }),
			expect.any(Function)
		);
	});

	it("falls back to the configured Hermes executable when PATH lookup is unavailable", async () => {
		const previousExecutable = process.env.HERMES_EXECUTABLE;
		process.env.HERMES_EXECUTABLE = "/tmp/hermes-bin";
		try {
			const execFile = jest.fn((command, _args, _options, callback) => {
				if (command === "/tmp/hermes-bin") {
					callback(null, JSON.stringify({ id: "t_env", title: "Env", status: "triage" }), "");
					return;
				}
				callback(Object.assign(new Error("missing"), { code: "ENOENT" }), "", "");
			});
			const client = new HermesKanbanCliClient({ execFile });

			await expect(client.createTask("default", { title: "Env" })).resolves.toEqual({
				id: "t_env",
				title: "Env",
				status: "triage",
			});
			expect(execFile.mock.calls[0][0]).toBe("/tmp/hermes-bin");
		} finally {
			if (previousExecutable === undefined) {
				delete process.env.HERMES_EXECUTABLE;
			} else {
				process.env.HERMES_EXECUTABLE = previousExecutable;
			}
		}
	});

	it("tries known Hermes executable candidates after PATH ENOENT", async () => {
		const execFile = jest.fn((command, _args, _options, callback) => {
			if (command === "/Users/yt/.hermes/hermes-agent/venv/bin/hermes") {
				callback(null, JSON.stringify({ id: "t_known", title: "Known", status: "triage" }), "");
				return;
			}
			callback(Object.assign(new Error("missing"), { code: "ENOENT" }), "", "");
		});
		const client = new HermesKanbanCliClient({ execFile });

		await expect(client.createTask("default", { title: "Known" })).resolves.toEqual({
			id: "t_known",
			title: "Known",
			status: "triage",
		});
		expect(execFile.mock.calls.map((call) => call[0])).toContain(
			"/Users/yt/.hermes/hermes-agent/venv/bin/hermes"
		);
	});

	it("defaults TaskNotes-native submissions to triage without an assignee", async () => {
		const execFile = jest.fn((_command, _args, _options, callback) => {
			callback(null, JSON.stringify({ id: "t_native", title: "Native", status: "triage" }), "");
		});
		const client = new HermesKanbanCliClient({ execFile, hermesCommand: "hermes" });

		await client.createTask("default", { title: "Native" });

		const args = execFile.mock.calls[0][1];
		expect(args).toContain("--triage");
		expect(args).not.toContain("--assignee");
	});

	it("preserves explicit routing metadata that the CLI exposes", async () => {
		const execFile = jest.fn((_command, _args, _options, callback) => {
			callback(
				null,
				JSON.stringify({ id: "t_routed", title: "Routed", status: "ready", assignee: "peacock" }),
				""
			);
		});
		const client = new HermesKanbanCliClient({ execFile, hermesCommand: "hermes" });

		await client.createTask("default", {
			title: "Routed",
			assignee: "peacock",
			tenant: "tenant-a",
			workspace_kind: "dir",
			workspace_path: "/tmp/tasknotes",
			initial_status: "blocked",
			skills: ["review"],
		});

		expect(execFile.mock.calls[0][1]).toEqual([
			"kanban",
			"--board",
			"default",
			"create",
			"Routed",
			"--triage",
			"--assignee",
			"peacock",
			"--tenant",
			"tenant-a",
			"--workspace",
			"dir:/tmp/tasknotes",
			"--initial-status",
			"blocked",
			"--skill",
			"review",
			"--json",
		]);
	});

	it("turns nonzero exits into sanitized UI-safe errors", async () => {
		const error = Object.assign(new Error("Command failed with token secret-token-123"), { code: 2 });
		const execFile = jest.fn((_command, _args, _options, callback) => {
			callback(error, "", "bad\u001b[31m stderr\nwith api_key=secret-token-123\nwith details");
		});
		const client = new HermesKanbanCliClient({ execFile, hermesCommand: "hermes" });

		await expect(client.createTask("default", { title: "Bad" })).rejects.toThrow(
			"Hermes Kanban CLI failed (exit 2): bad stderr with api_key=[redacted] with details"
		);
	});

	it("reports missing Hermes binary distinctly without leaking the attempted task text", async () => {
		const error = Object.assign(new Error("spawn hermes ENOENT --body do not leak"), {
			code: "ENOENT",
		});
		const execFile = jest.fn((_command, _args, _options, callback) => {
			callback(error, "", "");
		});
		const client = new HermesKanbanCliClient({ execFile, hermesCommand: "hermes" });

		await expect(
			client.createTask("default", { title: "Sensitive title", body: "do not leak" })
		).rejects.toThrow("Hermes Kanban CLI executable not found: hermes");
	});

	it("turns invalid JSON into a useful create-task error", async () => {
		const execFile = jest.fn((_command, _args, _options, callback) => {
			callback(null, "not-json", "");
		});
		const client = new HermesKanbanCliClient({ execFile, hermesCommand: "hermes" });

		await expect(client.createTask("default", { title: "Bad JSON" })).rejects.toThrow(
			"Hermes Kanban CLI returned invalid JSON for create task"
		);
	});

	it("accepts wrapped task JSON for compatibility with transport-shaped responses", async () => {
		const execFile = jest.fn((_command, _args, _options, callback) => {
			callback(
				null,
				JSON.stringify({ task: { id: "t_wrapped", title: "Wrapped", status: "triage" } }),
				""
			);
		});
		const client = new HermesKanbanCliClient({ execFile, hermesCommand: "hermes" });

		await expect(client.createTask("default", { title: "Wrapped" })).resolves.toEqual({
			id: "t_wrapped",
			title: "Wrapped",
			status: "triage",
		});
	});

	it("keeps dashboard-api transport selectable", () => {
		const client = createHermesKanbanClient("dashboard-api");

		expect(client.constructor.name).toBe("HermesKanbanApiClient");
	});

	it("uses the CLI transport by default", () => {
		const client = createHermesKanbanClient();

		expect(client.constructor.name).toBe("HermesKanbanCliClient");
	});
});
