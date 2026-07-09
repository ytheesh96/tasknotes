import { Notice } from "obsidian";
import TaskNotesPlugin from "../../../src/main";
import type { TaskInfo } from "../../../src/types";
import { HermesKanbanApiClient } from "../../../src/hermes/hermesApiClient";
import { provisionHermesBoardSurfaces } from "../../../src/hermes/hermesBoardProvisioning";
import {
	HERMES_DASHBOARD_START_COMMAND,
	HermesAvailabilityService,
	type HermesDashboardStartResult,
} from "../../../src/hermes/hermesAvailabilityService";

jest.mock("obsidian");
jest.mock("../../../src/hermes/hermesBoardProvisioning", () => ({
	provisionHermesBoardSurfaces: jest.fn().mockResolvedValue({
		foldersCreated: [],
		foldersSkipped: [],
		viewsCreated: [],
		viewsUpdated: [],
		viewsSkipped: [],
		legacyViewsRemoved: [],
		legacyViewsSkipped: [],
		boardsSkipped: [],
	}),
}));

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
		startHermesManagedTaskSync: jest.fn(),
		app: { workspace: { trigger: jest.fn() } },
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

function configureLiveDashboard(plugin: TaskNotesPlugin): Promise<void> {
	return (
		plugin as unknown as {
			configureHermesTaskNotesSyncForLiveDashboard(): Promise<void>;
		}
	).configureHermesTaskNotesSyncForLiveDashboard();
}

function managedTaskSyncStart(plugin: TaskNotesPlugin): jest.Mock {
	return (plugin as unknown as { startHermesManagedTaskSync: jest.Mock })
		.startHermesManagedTaskSync;
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
		jest.spyOn(HermesKanbanApiClient.prototype, "listBoards").mockResolvedValue([]);
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

	it("starts Hermes with TaskNotes API env and registers the Hermes webhook when API is enabled", async () => {
		const plugin = createPlugin({
			enableAPI: true,
			apiPort: 18080,
			apiAuthToken: "tasknotes-token",
			hermesTaskNotesWebhookSecret: "webhook-secret",
			webhooks: [],
		});
		plugin.saveSettings = jest.fn(async () => undefined) as never;
		const startDashboard = jest
			.spyOn(HermesAvailabilityService.prototype, "startDashboard")
			.mockResolvedValue(
				startResult({
					health: {
						status: "connected",
						mode: "live",
						rootUrl: "http://127.0.0.1:9119/",
						apiUrl: "http://127.0.0.1:9119/api/plugins/kanban",
						canStart: true,
					},
				})
			);

		await maybeAutoStart(plugin, {
			updatedTask: createTask("TaskNotes/default/t_12345678.md"),
		});

		expect(startDashboard).toHaveBeenCalledWith(HERMES_DASHBOARD_START_COMMAND, {
			env: {
				HERMES_TASKNOTES_BASE_URL: "http://127.0.0.1:18080",
				HERMES_TASKNOTES_API_TOKEN: "tasknotes-token",
				HERMES_TASKNOTES_WEBHOOK_SECRET: "webhook-secret",
				HERMES_TASKNOTES_RECONCILE_INTERVAL_SECONDS: "300",
			},
		});
		expect(plugin.settings.webhooks).toEqual([
			expect.objectContaining({
				id: "hermes-tasknotes-sync",
				url: "http://127.0.0.1:9119/api/plugins/kanban/tasknotes/webhook",
				secret: "webhook-secret",
				active: true,
			}),
		]);
		expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
		expect(managedTaskSyncStart(plugin)).toHaveBeenCalledTimes(1);
	});

	it("registers the Hermes webhook when an already-running dashboard is live", async () => {
		const plugin = createPlugin({
			enableAPI: true,
			apiPort: 18080,
			apiAuthToken: "tasknotes-token",
			hermesTaskNotesWebhookSecret: "webhook-secret",
			webhooks: [],
		});
		plugin.saveSettings = jest.fn(async () => undefined) as never;
		const syncWebhookSettings = jest.fn();
		plugin.apiService = { syncWebhookSettings } as never;
		const checkHealth = jest
			.spyOn(HermesAvailabilityService.prototype, "checkHealth")
			.mockResolvedValue({
				status: "connected",
				mode: "live",
				rootUrl: "http://127.0.0.1:9119/",
				apiUrl: "http://127.0.0.1:9119/api/plugins/kanban",
				canStart: true,
			});
		const startDashboard = jest.spyOn(HermesAvailabilityService.prototype, "startDashboard");

		await configureLiveDashboard(plugin);

		expect(checkHealth).toHaveBeenCalled();
		expect(startDashboard).not.toHaveBeenCalled();
		expect(Notice).not.toHaveBeenCalled();
		expect(plugin.settings.webhooks).toEqual([
			expect.objectContaining({
				id: "hermes-tasknotes-sync",
				url: "http://127.0.0.1:9119/api/plugins/kanban/tasknotes/webhook",
				secret: "webhook-secret",
				active: true,
			}),
		]);
		expect(syncWebhookSettings).toHaveBeenCalledTimes(1);
		expect(managedTaskSyncStart(plugin)).toHaveBeenCalledTimes(1);
	});

	it("provisions shared Hermes board Kanban views when the live dashboard is connected", async () => {
		const plugin = createPlugin({
			enableAPI: true,
			apiPort: 18080,
			hermesTaskNotesWebhookSecret: "webhook-secret",
			webhooks: [],
		});
		plugin.saveSettings = jest.fn(async () => undefined) as never;
		plugin.apiService = { syncWebhookSettings: jest.fn() } as never;
		jest.spyOn(HermesAvailabilityService.prototype, "checkHealth").mockResolvedValue({
			status: "connected",
			mode: "live",
			rootUrl: "http://127.0.0.1:9119/",
			apiUrl: "http://127.0.0.1:9119/api/plugins/kanban",
			canStart: true,
		});
		jest.spyOn(HermesKanbanApiClient.prototype, "listBoards").mockResolvedValue([
			{ slug: "default" },
			{ slug: "obsidian-os" },
			{ slug: "old-board", archived: true },
		]);

		await configureLiveDashboard(plugin);

		expect(provisionHermesBoardSurfaces).toHaveBeenCalledWith(plugin, [
			"default",
			"obsidian-os",
		]);
	});

	it("shows a restart notice and leaves managed-task event sync inactive when Hermes startup does not become live", async () => {
		const plugin = createPlugin({
			enableAPI: true,
			apiPort: 18080,
			apiAuthToken: "tasknotes-token",
			hermesTaskNotesWebhookSecret: "webhook-secret",
			webhooks: [],
		});
		plugin.saveSettings = jest.fn(async () => undefined) as never;
		const disconnectedHealth = {
			status: "disconnected" as const,
			mode: "cache-only",
			rootUrl: "http://127.0.0.1:9119/",
			apiUrl: "http://127.0.0.1:9119/api/plugins/kanban",
			canStart: true,
		};
		jest.spyOn(HermesAvailabilityService.prototype, "checkHealth").mockResolvedValue(
			disconnectedHealth
		);
		const startDashboard = jest
			.spyOn(HermesAvailabilityService.prototype, "startDashboard")
			.mockResolvedValue(
				startResult({
					started: false,
					health: disconnectedHealth,
				})
			);

		await configureLiveDashboard(plugin);

		expect(startDashboard).toHaveBeenCalledWith(HERMES_DASHBOARD_START_COMMAND, {
			env: {
				HERMES_TASKNOTES_BASE_URL: "http://127.0.0.1:18080",
				HERMES_TASKNOTES_API_TOKEN: "tasknotes-token",
				HERMES_TASKNOTES_WEBHOOK_SECRET: "webhook-secret",
				HERMES_TASKNOTES_RECONCILE_INTERVAL_SECONDS: "300",
			},
		});
		expect(Notice).toHaveBeenCalledWith(
			"TaskNotes could not start Hermes automatically. Restart Hermes, then TaskNotes will reconnect.",
			10000
		);
		expect(plugin.saveSettings).not.toHaveBeenCalled();
		expect(managedTaskSyncStart(plugin)).not.toHaveBeenCalled();
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
