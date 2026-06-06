import {
	Notice,
	Plugin,
	WorkspaceLeaf,
	Editor,
	Menu,
	TAbstractFile,
	TFile,
	getLanguage,
	normalizePath,
} from "obsidian";
import { format } from "date-fns";
import {
	createDailyNote,
	getDailyNote,
	getAllDailyNotes,
	appHasDailyNotesPluginLoaded,
} from "obsidian-daily-notes-interface";
import { TaskNotesSettings } from "./types/settings";
import { generateBasesFileTemplate } from "./templates/defaultBasesFiles";
import {
	MINI_CALENDAR_VIEW_TYPE,
	TaskInfo,
	EVENT_DATA_CHANGED,
	EVENT_TASK_UPDATED,
	EVENT_DATE_CHANGED,
} from "./types";

import { TaskCreationModal } from "./modals/TaskCreationModal";
import { TaskEditModal } from "./modals/TaskEditModal";
import { openTaskSelector } from "./modals/TaskSelectorWithCreateModal";
import { ProjectSelectModal } from "./modals/ProjectSelectModal";
import { PomodoroService } from "./services/PomodoroService";
import { formatTime, getActiveTimeEntry } from "./utils/helpers";
import { convertUTCToLocalCalendarDate } from "./utils/dateUtils";
import { TaskManager } from "./utils/TaskManager";
import { DependencyCache } from "./utils/DependencyCache";
import { RequestDeduplicator, PredictivePrefetcher } from "./utils/RequestDeduplicator";
import { DOMReconciler, UIStateManager } from "./utils/DOMReconciler";
import { FieldMapper } from "./services/FieldMapper";
import { StatusManager } from "./services/StatusManager";
import { PriorityManager } from "./services/PriorityManager";
import { TaskService } from "./services/TaskService";
import { FilterService } from "./services/FilterService";
import { TaskStatsService } from "./services/TaskStatsService";
import type { ViewPerformanceService } from "./services/ViewPerformanceService";
import { AutoArchiveService } from "./services/AutoArchiveService";
import { ViewStateManager } from "./services/ViewStateManager";
import { DragDropManager } from "./utils/DragDropManager";
import { formatDateForStorage, parseDateToLocal, getTodayLocal } from "./utils/dateUtils";
import { ICSSubscriptionService } from "./services/ICSSubscriptionService";
import { ICSNoteService } from "./services/ICSNoteService";
import { StatusBarService } from "./ui/StatusBarService";
import { ProjectSubtasksService } from "./services/ProjectSubtasksService";
import { ExpandedProjectsService } from "./services/ExpandedProjectsService";
import { NotificationService } from "./ui/NotificationService";
import { AutoExportService } from "./services/AutoExportService";
// Type-only import for HTTPAPIService (actual import is dynamic on desktop only)
import type { HTTPAPIService } from "./services/HTTPAPIService";
import { createI18nService, I18nService } from "./i18n";
import { OAuthService } from "./services/OAuthService";
import { GoogleCalendarService } from "./services/GoogleCalendarService";
import { MicrosoftCalendarService } from "./services/MicrosoftCalendarService";
import { CalendarProviderRegistry } from "./services/CalendarProvider";
import { TaskCalendarSyncService } from "./services/TaskCalendarSyncService";
import { addTaskToProject, assignTaskAsSubtask } from "./services/taskRelationshipActions";
import {
	initializeAfterLayoutReady,
	initializeCalendarProviders,
	registerBasesIntegration,
} from "./bootstrap/pluginBootstrap";
import { cleanupPluginRuntime, initializePluginRuntime } from "./bootstrap/pluginRuntime";
import { ensureDefaultBasesViewFiles } from "./bootstrap/defaultBasesFiles";
import { buildCurrentNoteConversionTaskInfo } from "./services/task-service/currentNoteConversion";
import { applyParentNoteProjectDefault } from "./utils/taskCreationPrepopulation";
import { getAllTasksFromNoteFirst, getTaskInfoFromNoteFirst } from "./utils/taskInfoRead";
import { applySearchQueryToView } from "./utils/obsidianSearchView";
import { TaskContextMenu } from "./components/TaskContextMenu";
import {
	LoadedSettingsData,
	buildSettingsDataForSave,
	buildSettingsFromLoadedData,
	loadPluginSettingsDataWithRetry,
	pluginDataFileExists,
} from "./settings/settingsPersistence";
import { startDateChangeDetection } from "./bootstrap/dateChangeDetection";
import {
	buildHermesTaskCreationOptions,
	normalizeHermesModalFieldsConfig,
	normalizeHermesUserFields,
} from "./hermes/hermesTaskNotesIntegration";
import { HermesKanbanApiClient, getHermesTaskIdentity } from "./hermes/hermesApiClient";
import { provisionHermesBoardSurfaces } from "./hermes/hermesBoardProvisioning";
import { canonicalHermesTaskPath } from "./hermes/hermesCanonicalTaskNotes";
import {
	HERMES_DASHBOARD_START_COMMAND,
	HERMES_KANBAN_API_URL,
	HermesAvailabilityService,
	type HermesAvailabilityHealth,
	type HermesDashboardStartOptions,
	type HermesDashboardStartResult,
	normalizeHermesDashboardStartCommand,
} from "./hermes/hermesAvailabilityService";
import {
	HERMES_MANAGED_TASK_RECONCILE_INTERVAL_MS,
	HERMES_TASKNOTES_ACTIVITY_RECONCILE_INTERVAL_MS,
	getHermesManagedBoardFromTaskEvent,
	getHermesManagedBoards,
	shouldHandleHermesTaskEvent,
	syncHermesManagedTaskFromHermes,
	syncHermesManagedTasksFromHermes,
	syncHermesTaskNotesActivityFromHermes,
} from "./hermes/hermesTaskSync";
import {
	HERMES_TASKNOTES_WEBHOOK_ID,
	buildHermesTaskNotesWebhookConfig,
	getHermesTaskNotesBoardFromTaskEvent,
} from "./hermes/hermesTaskNotesApiSync";
import { createTaskNotesLogger } from "./utils/tasknotesLogger";
import {
	createTaskNotesPerformanceProfiler,
	TaskNotesPerformanceProfiler,
} from "./utils/PerformanceProfiler";

const tasknotesLogger = createTaskNotesLogger({ tag: "Main" });
const HERMES_AUTO_START_COOLDOWN_MS = 5 * 60 * 1000;
const HERMES_DASHBOARD_ENSURE_COOLDOWN_MS = 60 * 1000;
const HERMES_DASHBOARD_ENSURE_POLL_ATTEMPTS = 8;
const HERMES_DASHBOARD_ENSURE_POLL_INTERVAL_MS = 1000;
const HERMES_TASKNOTES_RECONCILE_INTERVAL_SECONDS = "300";

type DailyNoteMoment = Parameters<typeof getDailyNote>[0];
type TaskLinkDetectionServiceInstance =
	import("./services/TaskLinkDetectionService").TaskLinkDetectionService;
type TaskLinkMatch = ReturnType<TaskLinkDetectionServiceInstance["findWikilinks"]>[number];
type SubmenuMenuItem = {
	setSubmenu(): Menu;
};
interface HermesDashboardEnsureOptions {
	showNotice?: boolean;
	force?: boolean;
	pollAttempts?: number;
	pollIntervalMs?: number;
}

function getSubmenu(item: unknown): Menu {
	return (item as SubmenuMenuItem).setSubmenu();
}

function waitForHermesDashboardPoll(intervalMs: number): Promise<void> {
	return new Promise((resolve) => {
		window.setTimeout(resolve, Math.max(0, intervalMs));
	});
}

function normalizeHermesTaskIdForLookup(taskId: string): string {
	const match = taskId.trim().match(/\bt_[a-z0-9]{8}\b/i);
	return match ? match[0].toLowerCase() : taskId.trim().toLowerCase();
}

function toFileUrl(path: string): string {
	return `file://${path
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/")}`;
}

export default class TaskNotesPlugin extends Plugin {
	settings: TaskNotesSettings;
	i18n: I18nService;
	private settingsLoadCompromised = false;
	private settingsDataSavePromise: Promise<void> | null = null;
	private settingsDataSaveRequested = false;
	private hermesManagedTaskSyncStarted = false;
	private hermesManagedTaskSyncInFlight = false;
	private hermesTaskNotesActivitySyncStarted = false;
	private hermesTaskNotesActivitySyncInFlight = false;
	private hermesEventStreamsActive = false;
	private hermesEventSockets = new Map<string, WebSocket>();
	private hermesEventReconnectTimers = new Map<string, number>();
	private hermesEventReconnectDelayByBoard = new Map<string, number>();
	private hermesEventCursorByBoard = new Map<string, number>();
	private hermesAutoStartInFlight = false;
	private hermesAutoStartLastAttemptAt = 0;
	private hermesDashboardEnsureInFlight: Promise<HermesDashboardStartResult> | null = null;
	private hermesDashboardEnsureLastFailedAt = 0;
	private hermesDashboardStartupRestartNoticeShown = false;

	// Ready promise to signal when initialization is complete
	private readyPromise: Promise<void>;
	private resolveReady: () => void;

	// Task manager for just-in-time task lookups (also handles events)
	cacheManager: TaskManager;
	emitter: TaskManager;

	// Dependency cache for relationships that need indexing
	dependencyCache: DependencyCache;

	// Performance optimization utilities
	requestDeduplicator: RequestDeduplicator;
	predictivePrefetcher: PredictivePrefetcher;
	domReconciler: DOMReconciler;
	uiStateManager: UIStateManager;
	performanceProfiler: TaskNotesPerformanceProfiler;

	// Pomodoro service
	pomodoroService: PomodoroService;

	// Customization services
	fieldMapper: FieldMapper;
	statusManager: StatusManager;
	priorityManager: PriorityManager;

	// Business logic services
	taskService: TaskService;
	filterService: FilterService;
	taskStatsService: TaskStatsService;
	viewStateManager: ViewStateManager;
	projectSubtasksService: ProjectSubtasksService;
	expandedProjectsService: ExpandedProjectsService;
	autoArchiveService: AutoArchiveService;
	viewPerformanceService: ViewPerformanceService;

	// Task selection service for batch operations
	taskSelectionService: import("./services/TaskSelectionService").TaskSelectionService;
	workspaceNavigationService: import("./ui/WorkspaceNavigationService").WorkspaceNavigationService;
	taskActionCoordinator: import("./ui/TaskActionCoordinator").TaskActionCoordinator;
	settingsLifecycleService: import("./services/SettingsLifecycleService").SettingsLifecycleService;
	commandRegistry: import("./commands/TranslatedCommandRegistry").TranslatedCommandRegistry;

	// Editor services
	taskLinkDetectionService?: import("./services/TaskLinkDetectionService").TaskLinkDetectionService;
	instantTaskConvertService?: import("./services/InstantTaskConvertService").InstantTaskConvertService;

	// Drag and drop manager
	dragDropManager: DragDropManager;

	// ICS subscription service
	icsSubscriptionService: ICSSubscriptionService;

	// ICS note service for creating notes/tasks from ICS events
	icsNoteService: ICSNoteService;

	// Auto export service for continuous ICS export
	autoExportService: AutoExportService;

	// Status bar service
	statusBarService: StatusBarService;

	// Notification service
	notificationService: NotificationService;

	// HTTP API service
	apiService?: HTTPAPIService;

	// Public JavaScript API for in-vault scripts
	api: import("./api/TaskNotesAPI").TaskNotesPublicAPI;

	// OAuth service
	oauthService: OAuthService;

	// Google Calendar service
	googleCalendarService: GoogleCalendarService;

	// Microsoft Calendar service
	microsoftCalendarService: MicrosoftCalendarService;

	// Calendar provider registry for abstraction
	calendarProviderRegistry: CalendarProviderRegistry;

	// Task-to-Google Calendar sync service
	taskCalendarSyncService: TaskCalendarSyncService;
	taskFileLifecycleReconciliationService?: import("./services/TaskFileLifecycleReconciliationService").TaskFileLifecycleReconciliationService;

	// mdbase-spec generation service
	mdbaseSpecService: import("./services/MdbaseSpecService").MdbaseSpecService;

	// Bases filter converter for exporting saved views
	basesFilterConverter: import("./services/BasesFilterConverter").BasesFilterConverter;

	// Event listener cleanup
	taskUpdateListenerForEditor: unknown = null;
	relationshipsReadingModeCleanup: (() => void) | null = null;
	taskCardReadingModeCleanup: (() => void) | null = null;

	// Initialization guard to prevent duplicate initialization
	initializationComplete = false;

	// Migration state management
	private migrationComplete = false;
	private migrationPromise: Promise<void> | null = null;

	// Bases registration state management
	basesRegistered = false;

	/**
	 * Get the system UI locale with proper priority order for TaskNotes plugin.
	 *
	 * Priority order for "System default" language setting:
	 * 1. Obsidian's configured language (what users expect for plugin behavior)
	 * 2. Browser/system locale (fallback if Obsidian language unavailable)
	 * 3. English (ultimate fallback)
	 *
	 * This ensures that when users select "System default", TaskNotes respects
	 * their Obsidian language setting first, which is the most intuitive behavior
	 * for an Obsidian plugin.
	 */
	private getSystemUILocale(): string {
		// Priority 1: Get Obsidian's configured language (this is what users expect!)
		try {
			const obsidianLanguage = getLanguage();
			if (obsidianLanguage) {
				return obsidianLanguage;
			}
		} catch {
			// Silently continue to next attempt if getLanguage() fails
		}

		// Priority 2: Fall back to browser/system locale
		if (typeof navigator !== "undefined" && navigator.language) {
			return navigator.language;
		}

		// Priority 3: Ultimate fallback
		return "en";
	}

	private refreshLocalizedViews(): void {
		// Views source their labels via getDisplayText; they'll pick up translations on next refresh.
		// For now we don't force-refresh to avoid disrupting the workspace layout.
	}

	async onload() {
		// Create the promise and store its resolver
		this.readyPromise = new Promise((resolve) => {
			this.resolveReady = resolve;
		});

		await this.loadSettings();
		this.performanceProfiler = createTaskNotesPerformanceProfiler({
			isEnabled: () => this.settings?.enableDebugLogging === true,
			logger: createTaskNotesLogger({
				tag: "PerformanceProfiler",
				isDebugEnabled: () => this.settings?.enableDebugLogging === true,
			}),
		});

		this.i18n = createI18nService({
			initialLocale: this.settings.uiLanguage ?? "system",
			getSystemLocale: () => this.getSystemUILocale(),
		});

		this.i18n.on("locale-changed", ({ current }) => {
			if (!this.initializationComplete) {
				return;
			}
			const languageLabel = this.i18n.getNativeLanguageName(current);
			new Notice(this.i18n.translate("notices.languageChanged", { language: languageLabel }));
			this.refreshLocalizedViews();
			this.commandRegistry?.refreshTranslations();
		});

		await initializePluginRuntime(this);
		this.registerHermesAutoStartOnTaskChanges();
		this.registerTaskNotesFileMenuActions();

		// Start migration check early (before views can be opened)
		this.migrationPromise = this.performEarlyMigrationCheck();

		initializeCalendarProviders(this);
		await registerBasesIntegration(this);

		// Defer expensive initialization until layout is ready
		this.app.workspace.onLayoutReady(() => {
			void this.initializeAfterLayoutReady();
		});

		// At the very end of onload, resolve the promise to signal readiness
		this.resolveReady();
	}

	private registerTaskNotesFileMenuActions(): void {
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file, source) => {
				this.addTaskNotesFileMenuActions(menu, file, source);
			})
		);
	}

	addTaskNotesFileMenuActions(menu: Menu, file: TAbstractFile, source?: string): void {
		if (source === "tasknotes-context-menu") {
			return;
		}

		if (!(file instanceof TFile)) {
			return;
		}

		const metadata = this.app.metadataCache.getFileCache(file);
		if (!metadata?.frontmatter || !this.cacheManager.isTaskFile(metadata.frontmatter)) {
			return;
		}

		menu.addSeparator();
		menu.addItem((item) => {
			item.setTitle(this.i18n.translate("modals.taskEdit.title"));
			item.setIcon("pencil");
			item.setSection("tasknotes");
			item.onClick(() => {
				void this.openTaskEditModalForFile(file);
			});
		});

		const task = this.cacheManager.getCachedTaskInfoSync(file.path);
		if (!task) {
			return;
		}

		menu.addItem((item) => {
			item.setTitle(this.i18n.translate("common.appName"));
			item.setIcon("list-checks");
			item.setSection("tasknotes");
			const submenu = getSubmenu(item);
			TaskContextMenu.addToMenu(submenu, {
				task,
				plugin: this,
				targetDate: getTodayLocal(),
				onUpdate: () => {
					this.app.workspace.trigger("tasknotes:refresh-views");
				},
			});
		});
	}

	/**
	 * Initialize HTTP API service (desktop only)
	 */
	async initializeAfterLayoutReady(): Promise<void> {
		await initializeAfterLayoutReady(this);
		this.startHermesTaskNotesActivitySync();
		tasknotesLogger.debug("Hermes mirror import sync is legacy; activity sync is started", {
			category: "provider",
			operation: "hermes-tasknotes-api-sync",
		});
	}

	async configureHermesTaskNotesSyncForLiveDashboard(): Promise<void> {
		try {
			const health = await new HermesAvailabilityService().checkHealth();
			const currentResult: HermesDashboardStartResult = {
				started: false,
				command: this.getHermesDashboardStartCommand(),
				health,
			};
			if (this.isHermesDashboardUsable(health)) {
				await this.configureHermesTaskNotesSyncIfLive(currentResult);
				return;
			}

			const result = await this.ensureHermesDashboardRunning({ showNotice: false });
			this.showHermesDashboardRestartNoticeAfterStartupAttempt(result);
		} catch (error) {
			tasknotesLogger.debug("Could not configure Hermes TaskNotes webhook:", {
				category: "provider",
				operation: "hermes-tasknotes-webhook-configure",
				error,
			});
		}
	}

	private registerHermesAutoStartOnTaskChanges(): void {
		this.registerEvent(
			this.emitter.on(EVENT_TASK_UPDATED, (eventData: unknown) => {
				void this.maybeAutoStartHermesForTaskEvent(eventData);
			})
		);
	}

	private async maybeAutoStartHermesForTaskEvent(eventData: unknown): Promise<void> {
		if (!this.settings.hermesAutoStartOnTaskChange) {
			return;
		}
		const board = getHermesTaskNotesBoardFromTaskEvent(eventData, { includeArchived: true });
		if (!board || this.hermesAutoStartInFlight) {
			return;
		}
		const now = Date.now();
		if (now - this.hermesAutoStartLastAttemptAt < HERMES_AUTO_START_COOLDOWN_MS) {
			return;
		}
		this.hermesAutoStartInFlight = true;
		try {
			const result = await this.startHermesDashboard({ showNotice: false });
			if (result.started) {
				new Notice("Starting hermes for tasknotes sync.");
			}
			if (result.health.status !== "connected") {
				this.hermesAutoStartLastAttemptAt = Date.now();
			}
			if (result.error) {
				new Notice("Could not start hermes automatically. Use the start hermes command.");
			}
		} catch (error) {
			this.hermesAutoStartLastAttemptAt = Date.now();
			tasknotesLogger.debug("Hermes auto-start failed after task change", {
				category: "provider",
				operation: "hermes-auto-start",
				details: { board },
				error,
			});
		} finally {
			this.hermesAutoStartInFlight = false;
		}
	}

	getHermesDashboardStartCommand(): string {
		return normalizeHermesDashboardStartCommand(
			this.settings.hermesStartCommand || HERMES_DASHBOARD_START_COMMAND
		);
	}

	async startHermesDashboard(
		options: { showNotice?: boolean } = {}
	): Promise<HermesDashboardStartResult> {
		const result = await this.startHermesDashboardWithOptions(new HermesAvailabilityService());
		await this.configureHermesTaskNotesSyncIfLive(result);
		if (options.showNotice ?? true) {
			this.showHermesDashboardStartNotice(result);
		}
		return result;
	}

	private async startHermesDashboardWithOptions(
		service: HermesAvailabilityService
	): Promise<HermesDashboardStartResult> {
		const command = this.getHermesDashboardStartCommand();
		const startOptions = await this.getHermesDashboardStartOptions();
		if (this.hasHermesDashboardStartEnv(startOptions)) {
			return service.startDashboard(command, startOptions);
		}
		return service.startDashboard(command);
	}

	private async getHermesDashboardStartOptions(): Promise<HermesDashboardStartOptions> {
		if (!this.settings.enableAPI) {
			return {};
		}
		const env: Record<string, string | undefined> = {
			HERMES_TASKNOTES_BASE_URL: this.getTaskNotesApiBaseUrl(),
			HERMES_TASKNOTES_API_TOKEN: this.settings.apiAuthToken || undefined,
			HERMES_TASKNOTES_WEBHOOK_SECRET: await this.ensureHermesTaskNotesWebhookSecret(),
			HERMES_TASKNOTES_RECONCILE_INTERVAL_SECONDS:
				HERMES_TASKNOTES_RECONCILE_INTERVAL_SECONDS,
		};
		return { env };
	}

	private getTaskNotesApiBaseUrl(): string {
		const port = Number.isFinite(this.settings.apiPort) ? this.settings.apiPort : 8080;
		return `http://127.0.0.1:${port}`;
	}

	private hasHermesDashboardStartEnv(options: HermesDashboardStartOptions): boolean {
		return Object.values(options.env ?? {}).some(
			(value) => typeof value === "string" && value.length > 0
		);
	}

	private async ensureHermesTaskNotesWebhookSecret(): Promise<string> {
		const existing = this.settings.hermesTaskNotesWebhookSecret?.trim();
		if (existing) {
			return existing;
		}
		const secret = this.generateHermesTaskNotesWebhookSecret();
		this.settings.hermesTaskNotesWebhookSecret = secret;
		await this.saveSettings();
		return secret;
	}

	private generateHermesTaskNotesWebhookSecret(): string {
		const bytes = crypto.getRandomValues(new Uint8Array(32));
		return Array.from(bytes)
			.map((byte) => byte.toString(16).padStart(2, "0"))
			.join("");
	}

	private async configureHermesTaskNotesSyncIfLive(
		result: HermesDashboardStartResult
	): Promise<void> {
		if (result.health.status !== "connected" || result.health.mode !== "live") {
			return;
		}
		await this.ensureHermesTaskNotesWebhookRegistered();
		await this.provisionHermesBoardSurfacesForLiveDashboard();
		this.startHermesManagedTaskSync();
	}

	private async provisionHermesBoardSurfacesForLiveDashboard(): Promise<void> {
		try {
			const boards = (await new HermesKanbanApiClient().listBoards())
				.filter((board) => !board.archived)
				.map((board) => board.slug);
			if (boards.length === 0) {
				return;
			}
			const result = await provisionHermesBoardSurfaces(this, boards);
			if (
				result.viewsCreated.length > 0 ||
				result.viewsUpdated.length > 0 ||
				result.foldersCreated.length > 0 ||
				result.legacyViewsRemoved.length > 0
			) {
				this.app.workspace.trigger("tasknotes:refresh-views");
			}
		} catch (error) {
			tasknotesLogger.debug("Could not provision Hermes board surfaces:", {
				category: "provider",
				operation: "hermes-board-surface-provision",
				error,
			});
		}
	}

	private async ensureHermesTaskNotesWebhookRegistered(): Promise<void> {
		if (!this.settings.enableAPI) {
			return;
		}
		const secret = await this.ensureHermesTaskNotesWebhookSecret();
		const next = buildHermesTaskNotesWebhookConfig({
			url: `${HERMES_KANBAN_API_URL}/tasknotes/webhook`,
			secret,
		});
		const existingIndex = (this.settings.webhooks ?? []).findIndex(
			(webhook) => webhook.id === HERMES_TASKNOTES_WEBHOOK_ID
		);
		const existing =
			existingIndex >= 0 ? (this.settings.webhooks ?? [])[existingIndex] : undefined;
		if (existing && this.isHermesTaskNotesWebhookCurrent(existing, next)) {
			return;
		}

		const webhooks = [...(this.settings.webhooks ?? [])];
		const webhook = existing
			? {
					...existing,
					...next,
					createdAt: existing.createdAt || next.createdAt,
					failureCount: existing.failureCount ?? 0,
					successCount: existing.successCount ?? 0,
				}
			: next;
		if (existingIndex >= 0) {
			webhooks[existingIndex] = webhook;
		} else {
			webhooks.push(webhook);
		}
		this.settings.webhooks = webhooks;
		await this.saveSettings();
		this.apiService?.syncWebhookSettings?.();
	}

	private isHermesTaskNotesWebhookCurrent(
		current: ReturnType<typeof buildHermesTaskNotesWebhookConfig>,
		next: ReturnType<typeof buildHermesTaskNotesWebhookConfig>
	): boolean {
		return (
			current.url === next.url &&
			current.secret === next.secret &&
			current.active === next.active &&
			current.corsHeaders === next.corsHeaders &&
			current.events.length === next.events.length &&
			current.events.every((event, index) => event === next.events[index])
		);
	}

	private showHermesDashboardStartNotice(result: HermesDashboardStartResult): void {
		if (result.error) {
			new Notice(`${result.error.message} ${result.error.action}`);
			return;
		}
		if (result.message) {
			new Notice(result.message);
			return;
		}
		if (result.started) {
			new Notice("Starting hermes dashboard.");
		}
	}

	private showHermesDashboardRestartNoticeAfterStartupAttempt(
		result: HermesDashboardStartResult
	): void {
		if (
			this.hermesDashboardStartupRestartNoticeShown ||
			this.isHermesDashboardUsable(result.health)
		) {
			return;
		}

		let reason = "TaskNotes could not start Hermes automatically.";
		if (result.health.status === "degraded") {
			reason = "Hermes is reachable, but the Kanban API is not live.";
		} else if (result.started) {
			reason = "TaskNotes tried to start Hermes, but Hermes is still not live.";
		}
		new Notice(`${reason} Restart Hermes, then TaskNotes will reconnect.`, 10000);
		this.hermesDashboardStartupRestartNoticeShown = true;
	}

	async ensureHermesDashboardRunning(
		options: HermesDashboardEnsureOptions = {}
	): Promise<HermesDashboardStartResult> {
		if (this.hermesDashboardEnsureInFlight) {
			return this.hermesDashboardEnsureInFlight;
		}

		const now = Date.now();
		if (
			!options.force &&
			now - this.hermesDashboardEnsureLastFailedAt < HERMES_DASHBOARD_ENSURE_COOLDOWN_MS
		) {
			const service = new HermesAvailabilityService();
			const health = await service.recheckHealth();
			return {
				started: false,
				command: this.getHermesDashboardStartCommand(),
				health,
				message:
					health.status === "connected"
						? "Hermes dashboard is already running on localhost:9119."
						: "Hermes dashboard startup was recently attempted; using cached activity while it recovers.",
			};
		}

		this.hermesDashboardEnsureInFlight = this.ensureHermesDashboardRunningOnce(options).finally(
			() => {
				this.hermesDashboardEnsureInFlight = null;
			}
		);
		return this.hermesDashboardEnsureInFlight;
	}

	private async ensureHermesDashboardRunningOnce(
		options: HermesDashboardEnsureOptions
	): Promise<HermesDashboardStartResult> {
		const service = new HermesAvailabilityService();
		const result = await this.startHermesDashboardWithOptions(service);
		const finalResult = await this.pollHermesDashboardAfterStart(service, result, options);
		await this.configureHermesTaskNotesSyncIfLive(finalResult);

		if (finalResult.error || !this.isHermesDashboardUsable(finalResult.health)) {
			this.hermesDashboardEnsureLastFailedAt = Date.now();
		}
		if (options.showNotice ?? false) {
			this.showHermesDashboardStartNotice(finalResult);
		}
		return finalResult;
	}

	private async pollHermesDashboardAfterStart(
		service: HermesAvailabilityService,
		result: HermesDashboardStartResult,
		options: HermesDashboardEnsureOptions
	): Promise<HermesDashboardStartResult> {
		if (!result.started || this.isHermesDashboardUsable(result.health) || result.error) {
			return result;
		}

		const attempts = options.pollAttempts ?? HERMES_DASHBOARD_ENSURE_POLL_ATTEMPTS;
		const intervalMs = options.pollIntervalMs ?? HERMES_DASHBOARD_ENSURE_POLL_INTERVAL_MS;
		let latestHealth = result.health;
		for (let attempt = 0; attempt < attempts; attempt++) {
			await waitForHermesDashboardPoll(intervalMs);
			latestHealth = await service.recheckHealth();
			if (this.isHermesDashboardUsable(latestHealth)) {
				return { ...result, health: latestHealth };
			}
		}

		return { ...result, health: latestHealth };
	}

	private isHermesDashboardUsable(health: HermesAvailabilityHealth): boolean {
		return health.status === "connected" && health.mode === "live";
	}

	private startHermesManagedTaskSync(): void {
		if (this.hermesManagedTaskSyncStarted) {
			return;
		}
		this.hermesManagedTaskSyncStarted = true;
		this.hermesEventStreamsActive = true;
		this.register(() => this.stopHermesEventStreams());
		this.registerEvent(
			this.emitter.on(EVENT_TASK_UPDATED, (eventData: unknown) => {
				void this.ensureHermesEventStreamForTaskEvent(eventData);
			})
		);
		this.registerInterval(
			window.setInterval(() => {
				void this.syncHermesManagedTasksFromHermes();
			}, HERMES_MANAGED_TASK_RECONCILE_INTERVAL_MS)
		);
		void this.syncHermesManagedTasksFromHermes();
	}

	private async syncHermesManagedTasksFromHermes(): Promise<void> {
		if (this.hermesManagedTaskSyncInFlight) {
			return;
		}
		this.hermesManagedTaskSyncInFlight = true;
		try {
			const tasks = await this.cacheManager.getAllTasks();
			await this.refreshHermesEventStreams(tasks);
			const result = await syncHermesManagedTasksFromHermes(this, { tasks });
			if (result.updated > 0 || result.deleted > 0 || result.failed > 0) {
				tasknotesLogger.debug("Hermes managed task sync completed", {
					category: "provider",
					operation: "hermes-managed-task-sync",
					details: { ...result },
				});
			}
		} catch (error) {
			tasknotesLogger.debug("Hermes managed task sync skipped", {
				category: "provider",
				operation: "hermes-managed-task-sync",
				error,
			});
		} finally {
			this.hermesManagedTaskSyncInFlight = false;
		}
	}

	private startHermesTaskNotesActivitySync(): void {
		if (this.hermesTaskNotesActivitySyncStarted) {
			return;
		}
		this.hermesTaskNotesActivitySyncStarted = true;
		this.registerInterval(
			window.setInterval(() => {
				void this.syncHermesTaskNotesActivityFromHermes();
			}, HERMES_TASKNOTES_ACTIVITY_RECONCILE_INTERVAL_MS)
		);
		void this.syncHermesTaskNotesActivityFromHermes();
	}

	private async syncHermesTaskNotesActivityFromHermes(): Promise<void> {
		if (this.hermesTaskNotesActivitySyncInFlight) {
			return;
		}
		this.hermesTaskNotesActivitySyncInFlight = true;
		try {
			const health = await new HermesAvailabilityService().checkHealth();
			if (!this.isHermesDashboardUsable(health)) {
				return;
			}
			const tasks = await this.cacheManager.getAllTasks();
			const result = await syncHermesTaskNotesActivityFromHermes(this, { tasks });
			if (result.updated > 0 || result.missing > 0 || result.failed > 0) {
				tasknotesLogger.debug("Hermes TaskNotes activity sync completed", {
					category: "provider",
					operation: "hermes-tasknotes-activity-sync",
					details: { ...result },
				});
			}
		} catch (error) {
			tasknotesLogger.debug("Hermes TaskNotes activity sync skipped", {
				category: "provider",
				operation: "hermes-tasknotes-activity-sync",
				error,
			});
		} finally {
			this.hermesTaskNotesActivitySyncInFlight = false;
		}
	}

	private async ensureHermesEventStreamForTaskEvent(eventData: unknown): Promise<void> {
		const board = getHermesManagedBoardFromTaskEvent(eventData);
		if (
			!board ||
			this.hermesEventSockets.has(board) ||
			this.hermesEventReconnectTimers.has(board)
		) {
			return;
		}
		await this.openHermesEventStream(board);
	}

	private async refreshHermesEventStreams(tasks: readonly TaskInfo[]): Promise<void> {
		const nextBoards = new Set(getHermesManagedBoards(tasks));
		for (const board of this.hermesEventSockets.keys()) {
			if (!nextBoards.has(board)) {
				this.closeHermesEventStream(board);
			}
		}
		for (const board of nextBoards) {
			if (
				!this.hermesEventSockets.has(board) &&
				!this.hermesEventReconnectTimers.has(board)
			) {
				await this.openHermesEventStream(board);
			}
		}
	}

	private async openHermesEventStream(board: string): Promise<void> {
		if (!this.hermesEventStreamsActive || this.hermesEventSockets.has(board)) {
			return;
		}
		let url: string | null = null;
		try {
			url = await new HermesKanbanApiClient().getEventStreamUrl(
				board,
				this.hermesEventCursorByBoard.get(board) ?? 0
			);
		} catch (error) {
			tasknotesLogger.debug("Could not prepare Hermes event stream", {
				category: "provider",
				operation: "hermes-event-stream",
				details: { board },
				error,
			});
		}
		if (!url) {
			this.scheduleHermesEventReconnect(board);
			return;
		}

		let socket: WebSocket;
		try {
			socket = new WebSocket(url);
		} catch (error) {
			tasknotesLogger.debug("Could not open Hermes event stream", {
				category: "provider",
				operation: "hermes-event-stream",
				details: { board },
				error,
			});
			this.scheduleHermesEventReconnect(board);
			return;
		}

		this.hermesEventSockets.set(board, socket);
		socket.onopen = () => {
			this.hermesEventReconnectDelayByBoard.set(board, 1_000);
		};
		socket.onmessage = (event) => {
			const raw = typeof event.data === "string" ? event.data : "";
			void this.handleHermesEventStreamMessage(board, raw);
		};
		socket.onerror = () => {
			socket.close();
		};
		socket.onclose = () => {
			if (this.hermesEventSockets.get(board) === socket) {
				this.hermesEventSockets.delete(board);
			}
			this.scheduleHermesEventReconnect(board);
		};
	}

	private scheduleHermesEventReconnect(board: string): void {
		if (!this.hermesEventStreamsActive || this.hermesEventReconnectTimers.has(board)) {
			return;
		}
		const delay = this.hermesEventReconnectDelayByBoard.get(board) ?? 1_000;
		this.hermesEventReconnectDelayByBoard.set(board, Math.min(delay * 2, 30_000));
		const timer = window.setTimeout(() => {
			this.hermesEventReconnectTimers.delete(board);
			void this.openHermesEventStream(board);
		}, delay);
		this.hermesEventReconnectTimers.set(board, timer);
	}

	private closeHermesEventStream(board: string): void {
		const timer = this.hermesEventReconnectTimers.get(board);
		if (timer !== undefined) {
			window.clearTimeout(timer);
			this.hermesEventReconnectTimers.delete(board);
		}
		const socket = this.hermesEventSockets.get(board);
		if (socket) {
			socket.onopen = null;
			socket.onmessage = null;
			socket.onerror = null;
			socket.onclose = null;
			socket.close();
			this.hermesEventSockets.delete(board);
		}
		this.hermesEventReconnectDelayByBoard.delete(board);
	}

	private stopHermesEventStreams(): void {
		this.hermesEventStreamsActive = false;
		for (const board of [
			...this.hermesEventSockets.keys(),
			...this.hermesEventReconnectTimers.keys(),
		]) {
			this.closeHermesEventStream(board);
		}
	}

	private async handleHermesEventStreamMessage(board: string, raw: string): Promise<void> {
		if (!raw) {
			return;
		}
		let payload: unknown;
		try {
			payload = JSON.parse(raw);
		} catch {
			return;
		}
		if (!payload || typeof payload !== "object") {
			return;
		}
		const message = payload as {
			cursor?: unknown;
			events?: Array<{ id?: unknown; task_id?: unknown; kind?: unknown }>;
		};
		if (typeof message.cursor === "number") {
			this.hermesEventCursorByBoard.set(board, message.cursor);
		}
		const taskIds = new Set<string>();
		for (const event of message.events ?? []) {
			if (typeof event.id === "number") {
				this.hermesEventCursorByBoard.set(
					board,
					Math.max(this.hermesEventCursorByBoard.get(board) ?? 0, event.id)
				);
			}
			const kind = typeof event.kind === "string" ? event.kind : undefined;
			if (!shouldHandleHermesTaskEvent(kind) || typeof event.task_id !== "string") {
				continue;
			}
			taskIds.add(event.task_id);
		}
		for (const id of taskIds) {
			try {
				await syncHermesManagedTaskFromHermes(this, { board, id });
			} catch (error) {
				tasknotesLogger.debug("Hermes event task refresh failed", {
					category: "provider",
					operation: "hermes-event-task-refresh",
					details: { board, id },
					error,
				});
			}
		}
	}

	/**
	 * Initialize heavy services lazily in the background
	 */
	initializeServicesLazily(): void {
		void import("./bootstrap/pluginBootstrap").then(({ initializeServicesLazily }) => {
			initializeServicesLazily(this);
		});
	}

	/**
	 * Warm up TaskManager indexes for better performance
	 */
	async warmupProjectIndexes(): Promise<void> {
		try {
			// Simple approach: just trigger the lazy index building once
			// This is much more efficient than processing individual files
			// Trigger index building with a single call - this will process all files internally
			this.cacheManager.getTasksForDate(new Date().toISOString().split("T")[0]);
		} catch (error) {
			tasknotesLogger.error("[TaskNotes] Error during project index warmup:", {
				category: "internal",
				operation: "project-index-warmup",
				error: error,
			});
		}
	}

	/**
	 * Public method for views to wait for readiness
	 */
	async onReady(): Promise<void> {
		await this.readyPromise;
	}

	/**
	 * Set up event listeners for status bar updates
	 */
	setupStatusBarEventListeners(): void {
		if (!this.statusBarService) {
			return;
		}

		// Listen for task updates that might affect time tracking
		this.registerEvent(
			this.emitter.on(EVENT_TASK_UPDATED, () => {
				// Small delay to ensure task state changes are fully propagated
				window.setTimeout(() => {
					this.statusBarService.requestUpdate();
				}, 100);
			})
		);

		// Listen for general data changes
		this.registerEvent(
			this.emitter.on(EVENT_DATA_CHANGED, () => {
				// Small delay to ensure data changes are fully propagated
				window.setTimeout(() => {
					this.statusBarService.requestUpdate();
				}, 100);
			})
		);

		// Listen for Pomodoro events if Pomodoro service is available
		if (this.pomodoroService) {
			// Listen for Pomodoro start events
			this.registerEvent(
				this.emitter.on("pomodoro-start", () => {
					window.setTimeout(() => {
						this.statusBarService.requestUpdate();
					}, 100);
				})
			);

			// Listen for Pomodoro stop events
			this.registerEvent(
				this.emitter.on("pomodoro-stop", () => {
					window.setTimeout(() => {
						this.statusBarService.requestUpdate();
					}, 100);
				})
			);

			// Listen for Pomodoro state changes
			this.registerEvent(
				this.emitter.on("pomodoro-state-changed", () => {
					window.setTimeout(() => {
						this.statusBarService.requestUpdate();
					}, 100);
				})
			);
		}
	}

	setupTimeTrackingEventListeners(): void {
		this.settingsLifecycleService.setupTimeTrackingEventListeners();
	}

	/**
	 * Perform early migration check and state preparation
	 * This runs before any views can be opened to prevent race conditions
	 */
	private async performEarlyMigrationCheck(): Promise<void> {
		try {
			// Initialize saved views (handles migration if needed)
			await this.viewStateManager.initializeSavedViews();

			// Perform view state migration if needed (this is silent and fast)
			if (this.viewStateManager.needsMigration()) {
				await this.viewStateManager.performMigration();
			}

			// Migration check complete
			this.migrationComplete = true;
		} catch (error) {
			tasknotesLogger.error("Error during early migration check:", {
				category: "configuration",
				operation: "early-migration-check",
				error: error,
			});
			// Don't fail the entire plugin load due to migration check issues
			this.migrationComplete = true;
		}
	}

	/**
	 * Check for version updates and show release notes if needed
	 */
	async checkForVersionUpdate(): Promise<void> {
		try {
			const currentVersion = this.manifest.version;
			const lastSeenVersion = this.settings.lastSeenVersion;

			// If this is a new install or version has changed, show release notes (if enabled)
			if (lastSeenVersion && lastSeenVersion !== currentVersion) {
				const showReleaseNotes = this.settings.showReleaseNotesOnUpdate ?? true;
				if (showReleaseNotes) {
					// Show release notes after a delay to ensure UI is ready
					window.setTimeout(() => {
						void (async () => {
							await this.activateReleaseNotesView();
							// Update lastSeenVersion immediately after showing the release notes
							// This ensures they only show once per version
							this.settings.lastSeenVersion = currentVersion;
							await this.saveSettings();
						})();
					}, 1500); // Slightly longer delay than migration to avoid conflicts
				} else {
					// Still update lastSeenVersion even if not showing release notes
					this.settings.lastSeenVersion = currentVersion;
					await this.saveSettings();
				}
			}

			// Update lastSeenVersion if it hasn't been set yet (new install)
			if (!lastSeenVersion) {
				this.settings.lastSeenVersion = currentVersion;
				await this.saveSettings();
			}
		} catch (error) {
			tasknotesLogger.error("Error checking for version update:", {
				category: "configuration",
				operation: "checking-version-update",
				error: error,
			});
		}
	}

	/**
	 * Public method for views to wait for migration completion
	 */
	async waitForMigration(): Promise<void> {
		if (this.migrationPromise) {
			await this.migrationPromise;
		}

		// Additional safety check - wait until migration is marked complete
		while (!this.migrationComplete) {
			await new Promise((resolve) => window.setTimeout(resolve, 50));
		}
	}

	// Methods for updating shared state and emitting events

	/**
	 * Notify views that data has changed and views should refresh
	 * @param filePath Optional path of the file that changed (for targeted cache invalidation)
	 * @param force Whether to force a full cache rebuild
	 * @param triggerRefresh Whether to trigger a full UI refresh (default true)
	 */
	notifyDataChanged(filePath?: string, force = false, triggerRefresh = true): void {
		// Clear cache entries for native cache manager
		if (filePath) {
			this.cacheManager.clearCacheEntry(filePath);

			// Clear task link detection cache for this file
			if (this.taskLinkDetectionService) {
				this.taskLinkDetectionService.clearCacheForFile(filePath);
			}
		} else if (force) {
			// Full cache clear if forcing
			void this.cacheManager.clearAllCaches();

			// Clear task link detection cache completely
			if (this.taskLinkDetectionService) {
				this.taskLinkDetectionService.clearCache();
			}
		}

		// Only emit refresh event if triggerRefresh is true
		if (triggerRefresh) {
			// Use requestAnimationFrame for better UI timing instead of setTimeout
			window.requestAnimationFrame(() => {
				this.emitter.trigger(EVENT_DATA_CHANGED);
			});
		}
	}

	/**
	 * Set up date change detection to refresh task states when the date rolls over
	 */
	setupDateChangeDetection(): void {
		startDateChangeDetection({
			registerTimer: (timerId) => this.registerInterval(timerId),
			emitDateChanged: () => this.emitter.trigger(EVENT_DATE_CHANGED),
		});
	}

	onunload() {
		void cleanupPluginRuntime(this);
	}

	private async pluginDataFileExists(): Promise<boolean> {
		return pluginDataFileExists(this);
	}

	private async loadSettingsData(): Promise<LoadedSettingsData | null> {
		this.settingsLoadCompromised = false;

		const result = await loadPluginSettingsDataWithRetry(this);
		this.settingsLoadCompromised = result.compromised;
		if (result.compromised) {
			tasknotesLogger.error("Settings data could not be read safely", {
				category: "internal",
				operation: "load-settings-data",
				details: {
					reason: "Settings data file exists, but Obsidian returned no settings data.",
					settingsSavesBlocked: true,
				},
			});
		}
		return result.data;
	}

	async loadSettings() {
		const loadedData = await this.loadSettingsData();
		const { settings, shouldPersistMigratedSettings } = buildSettingsFromLoadedData(loadedData);
		const hermesUserFields = normalizeHermesUserFields(settings.userFields);
		const hermesModalFieldsConfig = normalizeHermesModalFieldsConfig(
			settings.modalFieldsConfig
		);
		settings.userFields = hermesUserFields.fields;
		settings.modalFieldsConfig = hermesModalFieldsConfig.config;
		this.settings = settings;

		if (
			shouldPersistMigratedSettings ||
			hermesUserFields.changed ||
			hermesModalFieldsConfig.changed
		) {
			// Save the migrated settings to include new field mappings (non-blocking)
			window.setTimeout(() => {
				void (async () => {
					try {
						await this.saveSettingsDataOnly();
					} catch (error) {
						tasknotesLogger.error("Failed to save migrated settings:", {
							category: "configuration",
							operation: "save-migrated-settings",
							error: error,
						});
					}
				})();
			}, 100);
		}

		// Cache setting migration is no longer needed (native cache only)
	}

	async saveSettings() {
		await this.settingsLifecycleService.saveSettings();
	}

	/**
	 * Persist settings to disk without triggering runtime side-effects.
	 * Intended for background/internal updates (e.g., sync token writes).
	 */
	async saveSettingsDataOnly(): Promise<void> {
		this.settingsDataSaveRequested = true;
		if (!this.settingsDataSavePromise) {
			this.settingsDataSavePromise = this.drainSettingsDataSaves();
		}

		await this.settingsDataSavePromise;
	}

	private async drainSettingsDataSaves(): Promise<void> {
		try {
			while (this.settingsDataSaveRequested) {
				this.settingsDataSaveRequested = false;
				await this.writeSettingsDataOnlyOnce();
			}
		} finally {
			this.settingsDataSavePromise = null;
			if (this.settingsDataSaveRequested) {
				await this.saveSettingsDataOnly();
			}
		}
	}

	private async writeSettingsDataOnlyOnce(): Promise<void> {
		if (this.settingsLoadCompromised) {
			tasknotesLogger.warn(
				"[TaskNotes] Skipping settings save because settings data could not be read safely during startup.",
				{
					category: "configuration",
					operation: "skipping-settings-save-because-settings-data-read-safely-startup",
				}
			);
			return;
		}

		// Load existing plugin data to preserve non-settings data like pomodoroHistory
		const loadedData = await this.loadData();
		if (loadedData === null && (await this.pluginDataFileExists())) {
			this.settingsLoadCompromised = true;
			tasknotesLogger.warn(
				"[TaskNotes] Skipping settings save because data.json exists but could not be read.",
				{
					category: "configuration",
					operation: "skipping-settings-save-because-data-json-exists-but-read",
				}
			);
			return;
		}

		const data = loadedData || {};
		await this.saveData(buildSettingsDataForSave(data, this.settings));
	}

	async onExternalSettingsChange(): Promise<void> {
		await this.settingsLifecycleService.onExternalSettingsChange();
	}

	// Helper method to create or activate a view of specific type
	private async revealLeafReady(leaf: WorkspaceLeaf): Promise<void> {
		await this.workspaceNavigationService.revealLeafReady(leaf);
	}

	// Helper method to create or activate a view of specific type
	async activateView(viewType: string) {
		return this.workspaceNavigationService.activateView(viewType);
	}

	async activateCalendarView() {
		return this.workspaceNavigationService.activateCalendarView();
	}

	async activateAgendaView() {
		return this.workspaceNavigationService.activateAgendaView();
	}

	async activatePomodoroView() {
		return this.workspaceNavigationService.activatePomodoroView();
	}

	async activatePomodoroStatsView() {
		return this.workspaceNavigationService.activatePomodoroStatsView();
	}

	async activateStatsView() {
		return this.workspaceNavigationService.activateStatsView();
	}

	async activateReleaseNotesView() {
		return this.workspaceNavigationService.activateReleaseNotesView();
	}

	async openBasesFileForCommand(commandId: string): Promise<void> {
		await this.workspaceNavigationService.openBasesFileForCommand(commandId);
	}

	/**
	 * Create default .base files in TaskNotes/Views/ directory
	 * Called from settings UI
	 */
	async createDefaultBasesFiles(options: { overwriteExisting?: boolean } = {}): Promise<void> {
		const { created, updated, skipped } = await this.ensureBasesViewFiles(options);

		if (created.length > 0) {
			new Notice(
				`Created ${created.length} default Bases file(s):\n${created.join("\n")}`,
				8000
			);
		}

		if (updated.length > 0) {
			new Notice(
				`Updated ${updated.length} default Bases file(s):\n${updated.join("\n")}`,
				8000
			);
		}

		if (skipped.length > 0 && created.length === 0 && updated.length === 0) {
			new Notice(`Default Bases files already exist:\n${skipped.join("\n")}`, 8000);
		}
	}

	async ensureBasesViewFiles(
		options: { overwriteExisting?: boolean } = {}
	): Promise<{ created: string[]; updated: string[]; skipped: string[] }> {
		return ensureDefaultBasesViewFiles(
			{
				app: this.app,
				settings: this.settings,
				generateTemplate: (commandId) => generateBasesFileTemplate(commandId, this),
				warn: (message, error) => {
					if (error === undefined) {
						tasknotesLogger.warn(message, {
							category: "configuration",
							operation: "ensure-bases-view-files",
						});
					} else {
						tasknotesLogger.warn(message, {
							category: "configuration",
							operation: "ensure-bases-view-files",
							error: error,
						});
					}
				},
			},
			options
		);
	}

	/**
	 * Open and activate the search pane with a tag query
	 * (Renamed from openSearchPaneWithTag for cleaner API)
	 */
	async openTagsPane(tag: string): Promise<boolean> {
		const { workspace } = this.app;

		try {
			// Try to find existing search view first
			let searchLeaf = workspace.getLeavesOfType("search").first();

			if (!searchLeaf) {
				// Try to create/activate the search view in left sidebar
				const leftLeaf = workspace.getLeftLeaf(false);

				if (!leftLeaf) {
					tasknotesLogger.warn("Could not get left leaf for search pane", {
						category: "configuration",
						operation: "get-left-leaf-search-pane",
					});
					return false;
				}

				try {
					await leftLeaf.setViewState({
						type: "search",
						active: true,
					});
					searchLeaf = leftLeaf;
				} catch (error) {
					tasknotesLogger.warn("Failed to create search view:", {
						category: "persistence",
						operation: "create-search-view",
						error: error,
					});
					return false;
				}
			}

			if (!searchLeaf) {
				tasknotesLogger.warn("No search leaf available", {
					category: "configuration",
					operation: "no-search-leaf",
				});
				return false;
			}

			await this.revealLeafReady(searchLeaf);

			const searchQuery = `tag:${tag}`;
			if (!applySearchQueryToView(searchLeaf.view, searchQuery)) {
				tasknotesLogger.warn("[TaskNotes] Could not find method to set search query", {
					category: "stale-data",
					operation: "find-method-set-search-query",
				});
				new Notice("Search pane opened but could not set tag query");
				return false;
			}

			return true;
		} catch (error) {
			tasknotesLogger.error("[TaskNotes] Error opening search pane with tag:", {
				category: "internal",
				operation: "opening-search-pane-tag",
				error: error,
			});
			new Notice(`Failed to open search pane for tag: ${tag}`);
			return false;
		}
	}

	getLeafOfType(viewType: string): unknown {
		return this.workspaceNavigationService.getLeafOfType(viewType);
	}

	getCalendarLeaf(): unknown {
		return this.getLeafOfType(MINI_CALENDAR_VIEW_TYPE);
	}

	async navigateToCurrentDailyNote() {
		// Fix for issue #1223: Use getTodayLocal() to get the correct local calendar date
		// instead of new Date() which would be incorrectly converted by convertUTCToLocalCalendarDate()
		const date = getTodayLocal();
		await this.navigateToDailyNote(date, { isAlreadyLocal: true });
	}

	async navigateToDailyNote(date: Date, options?: { isAlreadyLocal?: boolean }) {
		try {
			// Check if Daily Notes plugin is enabled
			if (!appHasDailyNotesPluginLoaded()) {
				new Notice(
					"Daily notes core plugin is not enabled. Please enable it in settings > core plugins."
				);
				return;
			}

			// Convert date to moment for the API
			// Fix for issue #857: Convert UTC-anchored date to local calendar date
			// before passing to moment() to ensure correct day is used
			// Fix for issue #1223: Skip conversion if the date is already local (e.g., from getTodayLocal())
			const localDate = options?.isAlreadyLocal ? date : convertUTCToLocalCalendarDate(date);
			const moment = (window as Window & { moment: (date: Date) => DailyNoteMoment }).moment(
				localDate
			);

			// Get all daily notes to check if one exists for this date
			const allDailyNotes = getAllDailyNotes();
			let dailyNote = getDailyNote(moment, allDailyNotes);
			let noteWasCreated = false;

			// If no daily note exists for this date, create one
			if (!dailyNote) {
				try {
					dailyNote = await createDailyNote(moment);
					noteWasCreated = true;
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : String(error);
					tasknotesLogger.error("Failed to create daily note:", {
						category: "persistence",
						operation: "create-daily-note",
						error: error,
					});
					new Notice(`Failed to create daily note: ${errorMessage}`);
					return;
				}
			}

			// Open the daily note
			if (dailyNote) {
				await this.app.workspace.getLeaf(false).openFile(dailyNote);

				// If we created a new daily note, refresh the cache to ensure it shows up in views
				if (noteWasCreated) {
					// Note: Cache rebuilding happens automatically on data change notification

					// Notify views that data has changed to trigger a UI refresh
					this.notifyDataChanged(dailyNote.path, false, true);
				}
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			tasknotesLogger.error("Failed to navigate to daily note:", {
				category: "persistence",
				operation: "navigate-daily-note",
				error: error,
			});
			new Notice(`Failed to navigate to daily note: ${errorMessage}`);
		}
	}

	/**
	 * Inject dynamic CSS for custom statuses and priorities
	 */
	injectCustomStyles(): void {
		// Remove existing custom styles
		const existingStyle = activeDocument.getElementById("tasknotes-custom-styles");
		if (existingStyle) {
			existingStyle.remove();
		}

		// Generate new styles
		const statusStyles = this.statusManager.getStatusStyles();
		const priorityStyles = this.priorityManager.getPriorityStyles();

		// Create style element
		const styleEl = activeDocument.createElement("style");
		styleEl.id = "tasknotes-custom-styles";
		styleEl.textContent = `
		${statusStyles}
		${priorityStyles}
	`;

		// Inject into document head
		activeDocument.head.appendChild(styleEl);
	}

	async updateTaskProperty(
		task: TaskInfo,
		property: keyof TaskInfo,
		value: TaskInfo[keyof TaskInfo],
		options: { silent?: boolean } = {}
	): Promise<TaskInfo> {
		try {
			const updatedTask = await this.taskService.updateProperty(
				task,
				property,
				value,
				options
			);

			// Provide user feedback unless silent
			if (!options.silent) {
				if (property === "status") {
					const statusValue = typeof value === "string" ? value : String(value);
					const statusConfig = this.statusManager.getStatusConfig(statusValue);
					new Notice(`Task marked as '${statusConfig?.label || statusValue}'`);
				} else {
					new Notice(`Task ${property} updated`);
				}
			}

			return updatedTask;
		} catch (error) {
			tasknotesLogger.error(`Failed to update task ${property}:`, {
				category: "validation",
				operation: "update-task",
				error: error,
			});
			new Notice(`Failed to update task ${property}`);
			throw error;
		}
	}

	/**
	 * Toggles a recurring task's completion status for the selected date
	 */
	async toggleRecurringTaskComplete(task: TaskInfo, date?: Date): Promise<TaskInfo> {
		try {
			const targetDate = await this.taskService.resolveRecurringTaskActionDate(task, date);
			const updatedTask = await this.taskService.toggleRecurringTaskComplete(
				task,
				targetDate
			);

			const dateStr = formatDateForStorage(targetDate);
			const wasCompleted = updatedTask.complete_instances?.includes(dateStr);
			const action = wasCompleted ? "completed" : "marked incomplete";

			// Format date for display: convert UTC-anchored date back to local display
			const displayDate = parseDateToLocal(dateStr);
			new Notice(`Recurring task ${action} for ${format(displayDate, "MMM d")}`);
			return updatedTask;
		} catch (error) {
			tasknotesLogger.error("Failed to toggle recurring task completion:", {
				category: "persistence",
				operation: "toggle-recurring-task-completion",
				error: error,
			});
			new Notice("Failed to update recurring task");
			throw error;
		}
	}

	async toggleTaskArchive(task: TaskInfo): Promise<TaskInfo> {
		try {
			const updatedTask = await this.taskService.toggleArchive(task);
			const action = updatedTask.archived ? "archived" : "unarchived";
			new Notice(`Task ${action}`);
			return updatedTask;
		} catch (error) {
			tasknotesLogger.error("Failed to toggle task archive:", {
				category: "persistence",
				operation: "toggle-task-archive",
				error: error,
			});
			new Notice("Failed to update task archive status");
			throw error;
		}
	}

	async toggleTaskStatus(task: TaskInfo): Promise<TaskInfo> {
		try {
			const updatedTask = await this.taskService.toggleStatus(task);
			const statusConfig = this.statusManager.getStatusConfig(updatedTask.status);
			new Notice(`Task marked as '${statusConfig?.label || updatedTask.status}'`);
			return updatedTask;
		} catch (error) {
			tasknotesLogger.error("Failed to toggle task status:", {
				category: "persistence",
				operation: "toggle-task-status",
				error: error,
			});
			new Notice("Failed to update task status");
			throw error;
		}
	}

	openTaskCreationModal(prePopulatedValues?: Partial<TaskInfo>) {
		const values = this.applyParentNoteProjectDefault(prePopulatedValues);
		const options = buildHermesTaskCreationOptions(
			this.app,
			this.settings.userFields ?? [],
			values,
			undefined,
			this.settings.taskCreationDefaults.defaultProjects
		);
		new TaskCreationModal(this.app, this, options).open();
	}

	openGoalTaskCreationModal(prePopulatedValues?: Partial<TaskInfo>) {
		const tags = [
			...this.asStringArray(prePopulatedValues?.tags),
			"goal",
		];
		this.openTaskCreationModal({
			...prePopulatedValues,
			tags: [...new Set(tags)],
		});
	}

	private asStringArray(value: unknown): string[] {
		if (Array.isArray(value)) {
			return value.map(String).map((item) => item.trim()).filter(Boolean);
		}
		if (typeof value === "string" && value.trim()) {
			return value.split(",").map((item) => item.trim()).filter(Boolean);
		}
		return [];
	}

	private applyParentNoteProjectDefault(
		prePopulatedValues?: Partial<TaskInfo>
	): Partial<TaskInfo> | undefined {
		if (!this.settings.taskCreationDefaults.useParentNoteAsProject) {
			return prePopulatedValues;
		}

		const currentFile = this.app.workspace.getActiveFile();
		const parentNote = currentFile
			? this.app.fileManager.generateMarkdownLink(currentFile, currentFile.path)
			: undefined;

		return applyParentNoteProjectDefault(prePopulatedValues, parentNote);
	}

	/**
	 * Convert the current note to a task by adding required task frontmatter.
	 * Opens the task edit modal pre-populated with the note's existing data.
	 */
	async convertCurrentNoteToTask(): Promise<void> {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			new Notice(this.i18n.translate("commands.convertCurrentNoteToTask.noActiveFile"));
			return;
		}

		// Check if this note is already a task
		const existingTask = await getTaskInfoFromNoteFirst(this, activeFile.path);
		if (existingTask) {
			new Notice(this.i18n.translate("commands.convertCurrentNoteToTask.alreadyTask"));
			return;
		}

		// Read existing frontmatter and body from the file
		const metadata = this.app.metadataCache.getFileCache(activeFile);
		const frontmatter: Record<string, unknown> = metadata?.frontmatter || {};
		const content = await this.app.vault.read(activeFile);

		const taskInfo = buildCurrentNoteConversionTaskInfo({
			path: activeFile.path,
			basename: activeFile.basename,
			content,
			frontmatter,
			settings: this.settings,
		});

		// Open the task edit modal with the constructed TaskInfo
		new TaskEditModal(this.app, this, {
			task: taskInfo,
			onTaskUpdated: (updatedTask) => {
				new Notice(
					this.i18n.translate("commands.convertCurrentNoteToTask.success", {
						title: updatedTask.title,
					})
				);
			},
		}).open();
	}

	/**
	 * Open the task selector with create modal.
	 * This modal allows users to either select an existing task or create a new one via NLP.
	 */
	async openTaskSelectorWithCreate(): Promise<void> {
		await this.taskActionCoordinator.openTaskSelectorWithCreate();
	}

	async openTaskSelectorWithCreateAndStartTracking(): Promise<void> {
		await this.taskActionCoordinator.openTaskSelectorWithCreateAndStartTracking();
	}

	async rolloverOverdueScheduledTasks(): Promise<void> {
		await this.taskActionCoordinator.rolloverOverdueScheduledTasks();
	}

	/**
	 * Apply a filter to show subtasks of a project
	 */
	async applyProjectSubtaskFilter(projectTask: TaskInfo): Promise<void> {
		try {
			const file = this.app.vault.getAbstractFileByPath(projectTask.path);
			if (!file) {
				new Notice("Project file not found");
				return;
			}

			// Note: This feature was part of the old view system (deprecated in v4)
			// TODO: Re-implement for Bases views if needed
			new Notice("Project subtask filtering not available");
		} catch (error) {
			tasknotesLogger.error("Error applying project subtask filter:", {
				category: "persistence",
				operation: "applying-project-subtask-filter",
				error: error,
			});
			new Notice("Failed to apply project filter");
		}
	}

	/**
	 * Starts a time tracking session for a task
	 */
	async startTimeTracking(task: TaskInfo, description?: string): Promise<TaskInfo> {
		return this.taskActionCoordinator.startTimeTracking(task, description);
	}

	/**
	 * Stops the active time tracking session for a task
	 */
	async stopTimeTracking(task: TaskInfo): Promise<TaskInfo> {
		return this.taskActionCoordinator.stopTimeTracking(task);
	}

	/**
	 * Gets the active time tracking session for a task
	 */
	getActiveTimeSession(task: TaskInfo) {
		return getActiveTimeEntry(task.timeEntries || []);
	}

	/**
	 * Check if a recurring task is completed for a specific date
	 */
	isRecurringTaskCompleteForDate(task: TaskInfo, date: Date): boolean {
		if (!task.recurrence) return false;
		const dateStr = formatDateForStorage(date);
		const completeInstances = Array.isArray(task.complete_instances)
			? task.complete_instances
			: [];
		return completeInstances.includes(dateStr);
	}

	/**
	 * Formats time in minutes to a readable string
	 */
	formatTime(minutes: number): string {
		return formatTime(minutes);
	}

	/**
	 * Opens the task edit modal for a specific task
	 */
	async openTaskEditModal(task: TaskInfo, onTaskUpdated?: (task: TaskInfo) => void) {
		// With native cache, task data is always current - no need to refetch
		new TaskEditModal(this.app, this, { task, onTaskUpdated }).open();
	}

	async openHermesTaskEditModalById(taskId: string, board?: string): Promise<void> {
		const normalizedTaskId = normalizeHermesTaskIdForLookup(taskId);
		const normalizedBoard = board?.trim();
		if (!normalizedTaskId) {
			new Notice("Missing task ID.");
			return;
		}

		const directPath = normalizedBoard
			? canonicalHermesTaskPath(normalizedBoard, normalizedTaskId)
			: "";
		const directTask = directPath
			? await getTaskInfoFromNoteFirst(this, directPath)
			: null;
		if (directTask) {
			await this.openTaskEditModal(directTask);
			return;
		}
		const tasks = await getAllTasksFromNoteFirst(this);
		const matchesTaskId = (task: TaskInfo) => {
			const identity = getHermesTaskIdentity(task);
			return Boolean(
				identity && normalizeHermesTaskIdForLookup(identity.id) === normalizedTaskId
			);
		};
		const matchingTask =
			tasks.find((task) => {
				const identity = getHermesTaskIdentity(task);
				return Boolean(
					identity &&
						normalizeHermesTaskIdForLookup(identity.id) === normalizedTaskId &&
						(!normalizedBoard || identity.board === normalizedBoard)
				);
			}) ?? tasks.find(matchesTaskId);

		if (!matchingTask) {
			new Notice(`Could not find task ${normalizedTaskId}.`);
			return;
		}

		const freshMatchingTask =
			(await this.cacheManager.getTaskInfoFromFrontmatter(matchingTask.path)) ?? matchingTask;
		await this.openTaskEditModal(freshMatchingTask);
	}

	async openHermesArtifactPath(rawPath: string): Promise<void> {
		const target = rawPath.trim();
		if (!target) {
			new Notice("Missing artifact path.");
			return;
		}

		const vaultPath = this.resolveHermesArtifactVaultPath(target);
		if (vaultPath) {
			const file = this.app.vault.getAbstractFileByPath(vaultPath);
			if (file instanceof TFile) {
				await this.app.workspace.getLeaf(true).openFile(file);
				return;
			}
		}

		if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
			window.open(target, "_blank");
			return;
		}

		if (target.startsWith("/")) {
			window.open(toFileUrl(target), "_blank");
			return;
		}

		new Notice(`Could not open artifact: ${target}`);
	}

	private resolveHermesArtifactVaultPath(rawPath: string): string | null {
		const target = rawPath.trim();
		if (!target) {
			return null;
		}

		const adapter = this.app.vault.adapter as { getBasePath?: () => string };
		const basePath = adapter.getBasePath?.();
		const candidates = new Set<string>();
		candidates.add(target);

		if (target.startsWith("file://")) {
			try {
				candidates.add(decodeURIComponent(new URL(target).pathname));
			} catch {
				// Keep the original candidate.
			}
		}

		if (basePath) {
			for (const candidate of Array.from(candidates)) {
				if (candidate === basePath || candidate.startsWith(`${basePath}/`)) {
					candidates.add(candidate.slice(basePath.length).replace(/^\/+/, ""));
				}
			}
		}

		for (const candidate of candidates) {
			const normalized = normalizePath(candidate.replace(/^\/+/, ""));
			if (this.app.vault.getAbstractFileByPath(normalized) instanceof TFile) {
				return normalized;
			}
		}

		return null;
	}

	/**
	 * Opens a date/time picker modal for the given task date field.
	 */
	async openDueDateModal(task: TaskInfo) {
		void this.openTaskDatePicker(task, "due");
	}

	async openScheduledDateModal(task: TaskInfo) {
		void this.openTaskDatePicker(task, "scheduled");
	}

	private async openTaskDatePicker(task: TaskInfo, field: "due" | "scheduled") {
		try {
			const { DateTimePickerModal } = await import("./modals/DateTimePickerModal");
			const { getDatePart, getTimePart, combineDateAndTime } = await import(
				"./utils/dateUtils"
			);
			const currentValue = (field === "due" ? task.due : task.scheduled) || "";
			const modal = new DateTimePickerModal(this.app, {
				currentDate: getDatePart(currentValue) || null,
				currentTime: getTimePart(currentValue) || null,
				dateRole: field,
				plugin: this,
				onSelect: (date, time) => {
					void (async () => {
						const value =
							date && time ? combineDateAndTime(date, time) : date || undefined;
						await this.taskService.updateProperty(task, field, value);
					})();
				},
			});
			modal.open();
		} catch (error) {
			tasknotesLogger.error("Error loading DateTimePickerModal:", {
				category: "validation",
				operation: "loading-datetimepickermodal",
				error: error,
			});
		}
	}

	/**
	 * Refreshes the TaskNotes cache by clearing all cached data and re-initializing
	 */
	async refreshCache(): Promise<void> {
		try {
			// Show loading notice
			const loadingNotice = new Notice("Refreshing tasknotes cache...", 0);

			// Clear all caches
			await this.cacheManager.clearAllCaches();

			// Notify all views to refresh
			this.notifyDataChanged(undefined, true, true);

			// Hide loading notice and show success
			loadingNotice.hide();
			new Notice("Tasknotes cache refreshed successfully");
		} catch (error) {
			tasknotesLogger.error("Error refreshing cache:", {
				category: "stale-data",
				operation: "refreshing-cache",
				error: error,
			});
			new Notice("Failed to refresh cache. Please try again.");
		}
	}

	/**
	 * Convert any checkbox task on current line to TaskNotes task
	 * Supports multi-line selection where additional lines become task details
	 */
	async convertTaskToTaskNote(editor: Editor): Promise<void> {
		try {
			const cursor = editor.getCursor();

			// Check if instant convert service is available
			if (!this.instantTaskConvertService) {
				new Notice("Task conversion service not available. Please try again.");
				return;
			}

			// Use the instant convert service for immediate conversion without modal
			await this.instantTaskConvertService.instantConvertTask(editor, cursor.line);
		} catch (error) {
			tasknotesLogger.error("Error converting task:", {
				category: "validation",
				operation: "converting-task",
				error: error,
			});
			new Notice("Failed to convert task. Please try again.");
		}
	}

	/**
	 * Batch convert all checkbox tasks in the current note to TaskNotes
	 */
	async batchConvertAllTasks(editor: Editor): Promise<void> {
		try {
			// Check if instant convert service is available
			if (!this.instantTaskConvertService) {
				new Notice("Task conversion service not available. Please try again.");
				return;
			}

			// Use the instant convert service for batch conversion
			await this.instantTaskConvertService.batchConvertAllTasks(editor);
		} catch (error) {
			tasknotesLogger.error("Error batch converting tasks:", {
				category: "validation",
				operation: "batch-converting-tasks",
				error: error,
			});
			new Notice("Failed to batch convert tasks. Please try again.");
		}
	}

	/**
	 * Insert a wikilink to a selected tasknote at the current cursor position
	 */
	async insertTaskNoteLink(editor: Editor): Promise<void> {
		try {
			// Get all tasks
			const allTasks = await getAllTasksFromNoteFirst(this);
			const unarchivedTasks = allTasks.filter((task) => !task.archived);

			// Open task selector modal
			openTaskSelector(this, unarchivedTasks, (selectedTask) => {
				if (selectedTask) {
					// Create link using Obsidian's generateMarkdownLink (respects user's link format settings)
					const file = this.app.vault.getAbstractFileByPath(selectedTask.path);
					if (file instanceof TFile) {
						const currentFile = this.app.workspace.getActiveFile();
						const sourcePath = currentFile?.path || "";
						const properLink = this.app.fileManager.generateMarkdownLink(
							file,
							sourcePath,
							"",
							selectedTask.title // Use task title as alias
						);

						// Insert at cursor position
						const cursor = editor.getCursor();
						editor.replaceRange(properLink, cursor);

						// Move cursor to end of inserted text
						const newCursor = {
							line: cursor.line,
							ch: cursor.ch + properLink.length,
						};
						editor.setCursor(newCursor);
					} else {
						new Notice("Failed to create link - file not found");
					}
				}
			});
		} catch (error) {
			tasknotesLogger.error("Error inserting tasknote link:", {
				category: "persistence",
				operation: "inserting-tasknote-link",
				error: error,
			});
			new Notice("Failed to insert tasknote link");
		}
	}

	/**
	 * Open task selector to start time tracking for a task
	 */
	async openTaskSelectorForTimeTracking(): Promise<void> {
		await this.taskActionCoordinator.openTaskSelectorForTimeTracking();
	}

	/**
	 * Open task selector to edit time entries for a task
	 */
	async openTaskSelectorForTimeEntryEditor(): Promise<void> {
		await this.taskActionCoordinator.openTaskSelectorForTimeEntryEditor();
	}

	/**
	 * Open time entry editor modal for a specific task
	 */
	openTimeEntryEditor(task: TaskInfo, onSave?: () => void): void {
		this.taskActionCoordinator.openTimeEntryEditor(task, onSave);
	}

	/**
	 * Extract selection information for command usage
	 */
	private extractSelectionInfoForCommand(
		editor: Editor,
		lineNumber: number
	): {
		taskLine: string;
		details: string;
		startLine: number;
		endLine: number;
		originalContent: string[];
	} {
		const selection = editor.getSelection();

		// If there's a selection, use it; otherwise just use the current line
		if (selection && selection.trim()) {
			const selectionRange = editor.listSelections()[0];
			const startLine = Math.min(selectionRange.anchor.line, selectionRange.head.line);
			const endLine = Math.max(selectionRange.anchor.line, selectionRange.head.line);

			// Extract all lines in the selection
			const selectedLines: string[] = [];
			for (let i = startLine; i <= endLine; i++) {
				selectedLines.push(editor.getLine(i));
			}

			// First line should be the task, rest become details
			const taskLine = selectedLines[0];
			const detailLines = selectedLines.slice(1);
			// Join without trimming to preserve indentation, but remove trailing whitespace only
			const details = detailLines.join("\n").trimEnd();

			return {
				taskLine,
				details,
				startLine,
				endLine,
				originalContent: selectedLines,
			};
		} else {
			// No selection, just use the current line
			const taskLine = editor.getLine(lineNumber);
			return {
				taskLine,
				details: "",
				startLine: lineNumber,
				endLine: lineNumber,
				originalContent: [taskLine],
			};
		}
	}

	/**
	 * Open Quick Actions for the currently active TaskNote
	 */
	async openQuickActionsForCurrentTask(): Promise<void> {
		try {
			// Get currently active file
			const activeFile = this.app.workspace.getActiveFile();
			if (!activeFile) {
				new Notice("No file is currently open");
				return;
			}

			await this.openQuickActionsForTaskFile(activeFile, "Current file is not a tasknote");
		} catch (error) {
			tasknotesLogger.error("Error opening quick actions:", {
				category: "internal",
				operation: "opening-quick-actions",
				error: error,
			});
			new Notice("Failed to open quick actions");
		}
	}

	async openQuickActionsForTaskUnderCursor(
		editor: Editor,
		sourceFile?: TFile | null
	): Promise<void> {
		try {
			const activeFile = sourceFile ?? this.app.workspace.getActiveFile();
			if (!activeFile) {
				new Notice("No file is currently open");
				return;
			}

			const detectionService = await this.getTaskLinkDetectionService();
			const link = this.getTaskLinkAtCursor(editor, detectionService);
			if (!link) {
				new Notice("No task link found");
				return;
			}

			const detected = await detectionService.detectTaskLink(
				link.match,
				activeFile.path,
				link.type
			);
			if (!detected.isValidTaskLink || !detected.taskInfo) {
				new Notice("No task link found");
				return;
			}

			await this.openQuickActionsForTaskInfo(detected.taskInfo);
		} catch (error) {
			tasknotesLogger.error("Error opening quick actions for task under cursor:", {
				category: "persistence",
				operation: "opening-quick-actions-task-under-cursor",
				error: error,
			});
			new Notice("Failed to open quick actions");
		}
	}

	async openTaskEditModalForCurrentTask(): Promise<void> {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			new Notice("No file is currently open");
			return;
		}

		await this.openTaskEditModalForFile(activeFile, "Current file is not a tasknote");
	}

	async cycleCurrentTaskStatus(): Promise<void> {
		try {
			const taskInfo = await this.getCurrentTaskForCommand();
			if (!taskInfo) {
				return;
			}

			const nextStatus = this.statusManager.getNextStatus(taskInfo.status);
			await this.updateTaskProperty(taskInfo, "status", nextStatus);
		} catch (error) {
			tasknotesLogger.error("Failed to cycle current task status:", {
				category: "persistence",
				operation: "cycle-current-task-status",
				error: error,
			});
			new Notice("Failed to cycle task status");
		}
	}

	async cycleCurrentTaskPriority(): Promise<void> {
		try {
			const taskInfo = await this.getCurrentTaskForCommand();
			if (!taskInfo) {
				return;
			}

			const currentPriority = taskInfo.priority || this.settings.defaultTaskPriority;
			const nextPriority = this.priorityManager.getNextPriority(currentPriority);
			await this.updateTaskProperty(taskInfo, "priority", nextPriority);
		} catch (error) {
			tasknotesLogger.error("Failed to cycle current task priority:", {
				category: "persistence",
				operation: "cycle-current-task-priority",
				error: error,
			});
			new Notice("Failed to cycle task priority");
		}
	}

	private async getCurrentTaskForCommand(
		notTaskNotice = "Current file is not a task"
	): Promise<TaskInfo | null> {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			new Notice("No file is currently open");
			return null;
		}

		const taskInfo = await getTaskInfoFromNoteFirst(this, activeFile.path);
		if (!taskInfo) {
			new Notice(notTaskNotice);
			return null;
		}

		return taskInfo;
	}

	private async getTaskLinkDetectionService(): Promise<TaskLinkDetectionServiceInstance> {
		if (!this.taskLinkDetectionService) {
			const { TaskLinkDetectionService } = await import(
				"./services/TaskLinkDetectionService"
			);
			this.taskLinkDetectionService = new TaskLinkDetectionService(this);
		}

		return this.taskLinkDetectionService;
	}

	private getTaskLinkAtCursor(
		editor: Editor,
		detectionService: TaskLinkDetectionServiceInstance
	): TaskLinkMatch | null {
		const cursor = editor.getCursor();
		const line = editor.getLine(cursor.line);
		const links = detectionService.findWikilinks(line);

		return (
			links.find(
				(link) =>
					cursor.ch >= link.start &&
					cursor.ch <= link.end &&
					(link.type === "wikilink" || link.type === "markdown")
			) ?? null
		);
	}

	private async openTaskEditModalForFile(file: TFile, notTaskNotice?: string): Promise<void> {
		try {
			const taskInfo = await getTaskInfoFromNoteFirst(this, file.path);
			if (!taskInfo) {
				new Notice(
					notTaskNotice ??
						this.i18n.translate("modals.taskEdit.notices.fileMissing", {
							path: file.path,
						})
				);
				return;
			}

			await this.openTaskEditModal(taskInfo);
		} catch (error) {
			tasknotesLogger.error("Error opening task edit modal from file menu:", {
				category: "persistence",
				operation: "opening-task-edit-modal-file-menu",
				error: error,
			});
			new Notice(this.i18n.translate("modals.taskEdit.notices.openNoteFailure"));
		}
	}

	private async openQuickActionsForTaskFile(
		file: TFile,
		notTaskNotice = "Selected file is not a tasknote"
	): Promise<void> {
		const taskInfo = await getTaskInfoFromNoteFirst(this, file.path);
		if (!taskInfo) {
			new Notice(notTaskNotice);
			return;
		}

		await this.openQuickActionsForTaskInfo(taskInfo);
	}

	private async openQuickActionsForTaskInfo(taskInfo: TaskInfo): Promise<void> {
		const { TaskActionPaletteModal } = await import("./modals/TaskActionPaletteModal");
		// Use fresh UTC-anchored "today" for recurring task handling
		const now = new Date();
		const today = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
		const modal = new TaskActionPaletteModal(this.app, taskInfo, this, today);
		modal.open();
	}

	async addProjectToCurrentTask(): Promise<void> {
		try {
			const activeFile = this.app.workspace.getActiveFile();
			if (!activeFile) {
				new Notice("No file is currently open");
				return;
			}

			const taskInfo = await getTaskInfoFromNoteFirst(this, activeFile.path);
			if (!taskInfo) {
				new Notice("Current file is not a task");
				return;
			}

			const selector = new ProjectSelectModal(this.app, this, (projectFile) => {
				if (!(projectFile instanceof TFile)) {
					new Notice(
						this.i18n.translate(
							"contextMenus.task.organization.notices.projectSelectFailed"
						)
					);
					return;
				}
				void this.addSelectedProjectToTask(taskInfo, projectFile);
			});
			selector.open();
		} catch (error) {
			tasknotesLogger.error("Failed to add project to current task:", {
				category: "persistence",
				operation: "add-project-current-task",
				error: error,
			});
			new Notice(
				this.i18n.translate("contextMenus.task.organization.notices.addToProjectFailed")
			);
		}
	}

	async addSubtaskToCurrentNote(): Promise<void> {
		try {
			const activeFile = this.app.workspace.getActiveFile();
			if (!activeFile) {
				new Notice("No file is currently open");
				return;
			}

			const allTasks = await getAllTasksFromNoteFirst(this);
			const candidates = allTasks.filter((candidate) => candidate.path !== activeFile.path);
			if (candidates.length === 0) {
				new Notice(
					this.i18n.translate("contextMenus.task.organization.notices.noEligibleSubtasks")
				);
				return;
			}

			openTaskSelector(this, candidates, (subtask) => {
				if (!subtask) return;
				void this.assignSelectedSubtaskToCurrentNote(activeFile, subtask);
			});
		} catch (error) {
			tasknotesLogger.error("Failed to add subtask to current note:", {
				category: "persistence",
				operation: "add-subtask-current-note",
				error: error,
			});
			new Notice(
				this.i18n.translate("contextMenus.task.organization.notices.subtaskSelectFailed")
			);
		}
	}

	private async addSelectedProjectToTask(task: TaskInfo, projectFile: TFile): Promise<void> {
		try {
			await addTaskToProject(this, task, projectFile);
		} catch (error) {
			tasknotesLogger.error("Failed to add selected project to task:", {
				category: "persistence",
				operation: "add-selected-project-task",
				error: error,
			});
			new Notice(
				this.i18n.translate("contextMenus.task.organization.notices.addToProjectFailed")
			);
		}
	}

	private async assignSelectedSubtaskToCurrentNote(
		parentFile: TFile,
		subtask: TaskInfo
	): Promise<void> {
		try {
			await assignTaskAsSubtask(this, parentFile, subtask);
		} catch (error) {
			tasknotesLogger.error("Failed to assign selected subtask to current note:", {
				category: "persistence",
				operation: "assign-selected-subtask-current-note",
				error: error,
			});
			new Notice(
				this.i18n.translate("contextMenus.task.organization.notices.addAsSubtaskFailed")
			);
		}
	}

	/**
	 * Create a new inline task at cursor position
	 * Opens the task creation modal, then inserts a link to the created task
	 * Handles two scenarios:
	 * 1. Cursor on blank line: add new inline task
	 * 2. Cursor anywhere else: start new line then create inline task
	 */
	async createInlineTask(editor: Editor): Promise<void> {
		try {
			const cursor = editor.getCursor();
			const currentLine = editor.getLine(cursor.line);
			const lineContent = currentLine.trim();

			// Determine insertion point
			let insertionPoint: { line: number; ch: number };

			// Scenario 1: Cursor on blank line
			if (lineContent === "") {
				insertionPoint = { line: cursor.line, ch: cursor.ch };
			}
			// Scenario 2: Cursor anywhere else - create new line
			else {
				// Insert a new line and position cursor there
				const endOfLine = { line: cursor.line, ch: currentLine.length };
				editor.replaceRange("\n", endOfLine);
				insertionPoint = { line: cursor.line + 1, ch: 0 };
			}

			// Store the insertion context for the callback
			const insertionContext = {
				editor,
				insertionPoint,
			};

			const prePopulatedValues = this.applyParentNoteProjectDefault();
			const taskCreationOptions = buildHermesTaskCreationOptions(
				this.app,
				this.settings.userFields ?? [],
				prePopulatedValues,
				(task: TaskInfo) => {
					this.handleInlineTaskCreated(task, insertionContext);
				},
				this.settings.taskCreationDefaults.defaultProjects
			);
			taskCreationOptions.creationContext = "modal-inline-creation";

			// Open task creation modal with callback to insert link
			// Use modal-inline-creation context for inline folder behavior (Issue #1424)
			const modal = new TaskCreationModal(this.app, this, taskCreationOptions);

			modal.open();
		} catch (error) {
			tasknotesLogger.error("Error creating inline task:", {
				category: "persistence",
				operation: "creating-inline-task",
				error: error,
			});
			new Notice("Failed to create inline task");
		}
	}

	/**
	 * Handle task creation completion - insert link at the determined position
	 */
	private handleInlineTaskCreated(
		task: TaskInfo,
		context: {
			editor: Editor;
			insertionPoint: { line: number; ch: number };
		}
	): void {
		try {
			const { editor, insertionPoint } = context;

			// Create link using Obsidian's generateMarkdownLink
			const file = this.app.vault.getAbstractFileByPath(task.path);
			if (!(file instanceof TFile)) {
				new Notice("Failed to create link - file not found");
				return;
			}

			const currentFile = this.app.workspace.getActiveFile();
			const sourcePath = currentFile?.path || "";
			const properLink = this.app.fileManager.generateMarkdownLink(
				file,
				sourcePath,
				"",
				task.title // Use task title as alias
			);

			// Insert the link at the determined insertion point
			editor.replaceRange(properLink, insertionPoint);

			// Position cursor at end of inserted link
			const newCursor = {
				line: insertionPoint.line,
				ch: insertionPoint.ch + properLink.length,
			};
			editor.setCursor(newCursor);

			new Notice(`Inline task "${task.title}" created and linked successfully`);
		} catch (error) {
			tasknotesLogger.error("Error handling inline task creation:", {
				category: "persistence",
				operation: "handling-inline-task-creation",
				error: error,
			});
			new Notice("Failed to insert task link");
		}
	}
}
