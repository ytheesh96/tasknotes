import { Notice } from "obsidian";
import TaskNotesPlugin from "../../../src/main";
import type { TaskInfo } from "../../../src/types";
import {
	HERMES_DASHBOARD_START_COMMAND,
	HermesAvailabilityService,
	type HermesDashboardStartResult,
} from "../../../src/hermes/hermesAvailabilityService";

jest.mock("obsidian");

function createTask(path: string): TaskInfo {
	return {
		title: "Wake Hermes",
		status: "todo",
		priority: "normal",
		path,
		archived: false,
	} as TaskInfo;
}

function createPlugin(overrides: Record<string, unknown> = {}): TaskNotesPlugin {
	const plugin = Object.create(TaskNotesPlugin.prototype) as TaskNotesPlugin;
	plugin.settings = {
		hermesAutoStartOnTaskChange: true,
		hermesStartCommand: HERMES_DASHBOARD_START_COMMAND,
		...overrides,
	} as never;
	Object.assign(plugin as unknown as Record<string, unknown>, {
		hermesAutoStartInFlight: false,
		hermesAutoStartLastAttemptAt: 0,
	});
	return plugin;
}

function maybeAutoStart(plugin: TaskNotesPlugin, eventData: unknown): Promise<void> {
	return (
		plugin as unknown as {
			maybeAutoStartHermesForTaskEvent(eventData: unknown): Promise<void>;
		}
	).maybeAutoStartHermesForTaskEvent(eventData);
}

function startResult(overrides: Partial<HermesDashboardStartResult> = {}): HermesDashboardStartResult {
	return {
		started: true,
		pid: 9119,
		command: HERMES_DASHBOARD_START_COMMAND,
		health: {
			status: "starting",
			mode: "cache-only",
			rootUrl: "http://127.0.0.1:9119/",
			apiUrl: "http://127.0.0.1:9119/api/plugins/kanban",
			canStart: true,
		},
		...overrides,
	};
}

describe("Hermes auto-start after TaskNotes changes", () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	afterEach(() => {
		jest.restoreAllMocks();
	});

	it("starts Hermes with the configured command after a Hermes-linked task changes", async () => {
		const plugin = createPlugin({ hermesStartCommand: "/Users/example/bin/start-hermes" });
		const startDashboard = jest
			.spyOn(HermesAvailabilityService.prototype, "startDashboard")
			.mockResolvedValue(startResult({ command: "/Users/example/bin/start-hermes" }));

		await maybeAutoStart(plugin, {
			updatedTask: createTask("TaskNotes/default/t_12345678.md"),
		});

		expect(startDashboard).toHaveBeenCalledWith("/Users/example/bin/start-hermes");
		expect(Notice).toHaveBeenCalledWith("Starting hermes for tasknotes sync.");
	});

	it("ignores ordinary TaskNotes changes", async () => {
		const plugin = createPlugin();
		const startDashboard = jest
			.spyOn(HermesAvailabilityService.prototype, "startDashboard")
			.mockResolvedValue(startResult());

		await maybeAutoStart(plugin, {
			updatedTask: createTask("TaskNotes/Tasks/not-hermes.md"),
		});

		expect(startDashboard).not.toHaveBeenCalled();
	});

	it("does not retry during the auto-start cooldown", async () => {
		const plugin = createPlugin();
		(plugin as unknown as Record<string, unknown>).hermesAutoStartLastAttemptAt = Date.now();
		const startDashboard = jest
			.spyOn(HermesAvailabilityService.prototype, "startDashboard")
			.mockResolvedValue(startResult());

		await maybeAutoStart(plugin, {
			updatedTask: createTask("TaskNotes/default/t_12345678.md"),
		});

		expect(startDashboard).not.toHaveBeenCalled();
	});
});
