/* eslint-disable @typescript-eslint/no-non-null-assertion -- Modal lifecycle initializes required controls before event handlers run. */
import { App, Notice, setTooltip, Setting, TFile } from "obsidian";
import TaskNotesPlugin from "../main";
import { TaskModal } from "./TaskModal";
import { TaskDependency, TaskInfo } from "../types";
import { formatTimestampForDisplay, getCurrentTimestamp } from "../utils/dateUtils";
import { extractTaskInfo, calculateTotalTimeSpent, formatTime } from "../utils/helpers";
import { stringifyUnknown } from "../utils/stringUtils";
import { ConfirmationModal, showConfirmationModal } from "./ConfirmationModal";
import { showTextInputModal } from "./TextInputModal";
import { createCompletionsCalendarSection } from "./taskEditCompletions";
import { BlockingUpdates } from "./taskEditChanges";
import { createTaskModalActionButtons } from "./taskModalActionButtons";
import { showTaskModalReminderContextMenu } from "./taskModalActionMenus";
import { buildTaskEditChangesFromModalState } from "./taskEditChangeState";
import { buildTaskEditFormStateFromTask } from "./taskEditFormState";
import { applyTaskEditSubtaskChanges, hasTaskEditSubtaskChanges } from "./taskEditSubtasks";
import {
	HermesKanbanApiClient,
	getHermesTaskIdentity,
	type HermesTaskDetailResponse,
} from "../hermes/hermesApiClient";
import { createOrUpdateHermesMirrorNote } from "../hermes/hermesMirror";
import { buildHermesAssigneeUpdatePayload } from "../hermes/hermesAssignee";
import type { ModalFieldsConfigLike } from "./taskModalFieldConfig";
import { createTaskNotesLogger } from "../utils/tasknotesLogger";
import { resizeTaskModalTitleTextarea } from "./taskModalTitleInput";

const tasknotesLogger = createTaskNotesLogger({ tag: "Modals/TaskEditModal" });

interface HermesCommentCard {
	id?: string;
	author: string;
	body: string;
	createdAt?: string | number;
}

interface HermesRunCard {
	id?: string;
	profile: string;
	status: string;
	outcome?: string;
	summary?: string;
	error?: string;
	startedAt?: string | number;
	endedAt?: string | number;
}

interface HermesEventCard {
	id?: string;
	kind: string;
	payload?: unknown;
	createdAt?: string | number;
	runId?: string;
}

interface HermesActivityCard {
	title: string;
	fullTitle?: string;
	meta?: string;
	details?: HermesActivityDetail[];
	actions?: HermesActivityAction[];
	body?: string;
}

interface HermesActivityDetail {
	label: string;
	value: string;
}

interface HermesActivityAction {
	type: "artifact" | "task";
	label: string;
	value: string;
}

interface HermesActivityElements {
	commentsList: HTMLElement;
	runHistorySection: HTMLElement;
	runHistoryList: HTMLElement;
	eventsSection: HTMLElement;
	eventsList: HTMLElement;
}

interface HermesActivityContainers {
	commentsContainer: HTMLElement;
	readOnlyContainer: HTMLElement;
}

function normalizeHermesComments(comments: unknown[]): HermesCommentCard[] {
	return comments.flatMap((comment) => {
		if (!comment || typeof comment !== "object") {
			return [];
		}
		const record = comment as Record<string, unknown>;
		const body = typeof record.body === "string" ? record.body.trim() : "";
		if (!body) {
			return [];
		}

		const author = typeof record.author === "string" ? record.author.trim() : "";
		const id = record.id;
		const createdAt = record.created_at ?? record.createdAt;
		return [
			{
				id: typeof id === "string" || typeof id === "number" ? String(id) : undefined,
				author: author || "Hermes",
				body,
				createdAt:
					typeof createdAt === "string" || typeof createdAt === "number"
						? createdAt
						: undefined,
			},
		];
	});
}

function normalizeHermesRuns(runs: unknown[]): HermesRunCard[] {
	return runs.flatMap((run) => {
		if (!run || typeof run !== "object") {
			return [];
		}
		const record = run as Record<string, unknown>;
		const status = optionalString(record.status) || "unknown";
		const outcome = optionalString(record.outcome);
		const summary = optionalString(record.summary);
		const error = optionalString(record.error);
		return [
			{
				id: optionalId(record.id),
				profile: optionalString(record.profile) || "worker",
				status,
				outcome,
				summary,
				error,
				startedAt: optionalTimestamp(record.started_at ?? record.startedAt),
				endedAt: optionalTimestamp(record.ended_at ?? record.endedAt),
			},
		];
	});
}

function normalizeHermesEvents(events: unknown[]): HermesEventCard[] {
	return events.flatMap((event) => {
		if (!event || typeof event !== "object") {
			return [];
		}
		const record = event as Record<string, unknown>;
		const kind = optionalString(record.kind);
		if (!kind) {
			return [];
		}
		return [
			{
				id: optionalId(record.id),
				kind,
				payload: record.payload,
				createdAt: optionalTimestamp(record.created_at ?? record.createdAt),
				runId: optionalId(record.run_id ?? record.runId),
			},
		];
	});
}

function optionalString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function optionalId(value: unknown): string | undefined {
	return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function optionalTimestamp(value: unknown): string | number | undefined {
	return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function formatHermesActivityTimestamp(timestamp: string | number | undefined): string {
	const date = parseHermesActivityDate(timestamp);
	if (!date) {
		return "";
	}
	return formatHermesRelativeTime(date);
}

function parseHermesActivityDate(timestamp: string | number | undefined): Date | null {
	if (timestamp === undefined || timestamp === "") {
		return null;
	}
	if (typeof timestamp === "number") {
		const milliseconds = timestamp > 1_000_000_000_000 ? timestamp : timestamp * 1000;
		const date = new Date(milliseconds);
		return Number.isNaN(date.getTime()) ? null : date;
	}

	const numericTimestamp = Number(timestamp);
	if (Number.isFinite(numericTimestamp) && timestamp.trim() !== "") {
		return parseHermesActivityDate(numericTimestamp);
	}

	const date = new Date(timestamp);
	return Number.isNaN(date.getTime()) ? null : date;
}

function formatHermesRelativeTime(date: Date, now = new Date()): string {
	const diffSeconds = Math.round((date.getTime() - now.getTime()) / 1000);
	const absoluteSeconds = Math.abs(diffSeconds);
	if (absoluteSeconds < 60) {
		return "now";
	}

	const units: Array<[number, string, string]> = [
		[60, "min", "mins"],
		[60, "hour", "hours"],
		[24, "day", "days"],
		[7, "week", "weeks"],
		[4.345, "month", "months"],
		[12, "year", "years"],
	];
	let value = absoluteSeconds;
	let singular = "sec";
	let plural = "secs";
	for (const [divisor, nextSingular, nextPlural] of units) {
		if (value < divisor) {
			break;
		}
		value = Math.floor(value / divisor);
		singular = nextSingular;
		plural = nextPlural;
	}
	const unit = value === 1 ? singular : plural;
	return diffSeconds > 0 ? `in ${value} ${unit}` : `${value} ${unit} ago`;
}

function formatHermesCommentMeta(comment: HermesCommentCard): string {
	const author = comment.author?.trim() || "Hermes";
	const timestamp = formatHermesActivityTimestamp(comment.createdAt);
	return [author, timestamp].filter(Boolean).join(" - ");
}

function compactHermesActivityText(value: unknown, maxLength = 360): string {
	const raw = typeof value === "string" ? value : stringifyUnknown(value);
	const text = raw.trim();
	if (text.length <= maxLength) {
		return text;
	}
	return `${text.slice(0, maxLength - 3).trimEnd()}...`;
}

function hermesActivityText(value: unknown): string {
	const raw = typeof value === "string" ? value : stringifyUnknown(value);
	return raw.trim();
}

const HERMES_EVENT_PRIMARY_FIELDS = ["summary", "message", "error", "result", "outcome"];
const HERMES_EVENT_FIELD_ORDER = [
	"summary",
	"message",
	"error",
	"status",
	"outcome",
	"result_len",
	"changed_files",
	"artifacts",
	"verification",
	"decisions",
	"worker_session_id",
	"run_id",
	"profile",
	"assignee",
];
const HERMES_EVENT_FIELD_LABELS: Record<string, string> = {
	result_len: "Result length",
	changed_files: "Changed files",
	worker_session_id: "Worker session",
	run_id: "Run",
};
const HERMES_EVENT_ARRAY_NOUNS: Record<string, string> = {
	changed_files: "file",
	artifacts: "artifact",
	verification: "check",
	decisions: "decision",
};
const HERMES_TASK_ID_REGEX = /\bt_[a-z0-9]{8}\b/gi;
const HERMES_EVENT_ARTIFACT_KEYS = new Set([
	"artifact",
	"artifacts",
	"changed_files",
	"working_files",
	"file",
	"files",
	"path",
	"paths",
]);
const HERMES_EVENT_ARTIFACT_EXTENSIONS =
	/\.(?:base|canvas|csv|html?|jpeg|jpg|json|md|pdf|png|svg|tsv|txt|webp|yaml|yml)$/i;

function formatHermesEventCard(event: HermesEventCard): HermesActivityCard {
	const kindLabel = formatHermesEventKind(event.kind);
	const payload = normalizeHermesEventPayload(event.payload);
	const details: HermesActivityDetail[] = [];
	const actions = extractHermesEventActions(payload);
	const body = formatHermesEventPayloadBody(payload);
	let fullTitle = kindLabel;

	if (isHermesEventRecord(payload)) {
		const primary = HERMES_EVENT_PRIMARY_FIELDS.find((key) => {
			const value = payload[key];
			return !isEmptyHermesEventPayloadValue(value);
		});
		if (primary) {
			fullTitle = `${kindLabel}: ${summarizeHermesEventPayloadValue(payload[primary], primary, 140)}`;
		}

		for (const key of orderHermesEventPayloadKeys(payload)) {
			if (key === primary || details.length >= 5) {
				continue;
			}
			const value = payload[key];
			if (isEmptyHermesEventPayloadValue(value)) {
				continue;
			}
			details.push({
				label: formatHermesEventFieldLabel(key),
				value: summarizeHermesEventPayloadValue(value, key),
			});
		}
	} else if (!isEmptyHermesEventPayloadValue(payload)) {
		fullTitle = `${kindLabel}: ${summarizeHermesEventPayloadValue(payload, "payload", 140)}`;
	}

	if (event.runId && !details.some((detail) => detail.label === "Run")) {
		details.push({ label: "Run", value: event.runId });
	}

	return {
		title: compactHermesActivityText(fullTitle, 180),
		fullTitle,
		details: details.length > 0 ? details : undefined,
		actions: actions.length > 0 ? actions : undefined,
		body: body || undefined,
		meta: formatHermesActivityTimestamp(event.createdAt),
	};
}

function normalizeHermesEventPayload(payload: unknown): unknown {
	if (typeof payload !== "string") {
		return payload;
	}
	const text = payload.trim();
	if (!text) {
		return "";
	}
	if (!/^[{[]/.test(text)) {
		return text;
	}
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return text;
	}
}

function formatHermesEventKind(kind: string): string {
	const words = kind.replace(/[_-]+/g, " ").trim();
	if (!words) {
		return "Event";
	}
	return words.replace(/\b[a-z]/g, (char) => char.toUpperCase());
}

function isHermesEventRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isEmptyHermesEventPayloadValue(value: unknown): boolean {
	return (
		value === null ||
		value === undefined ||
		(typeof value === "string" && value.trim() === "") ||
		(Array.isArray(value) && value.length === 0)
	);
}

function orderHermesEventPayloadKeys(record: Record<string, unknown>): string[] {
	const keys = Object.keys(record);
	return [
		...HERMES_EVENT_FIELD_ORDER.filter((key) => keys.includes(key)),
		...keys.filter((key) => !HERMES_EVENT_FIELD_ORDER.includes(key)).sort(),
	];
}

function formatHermesEventFieldLabel(key: string): string {
	return (
		HERMES_EVENT_FIELD_LABELS[key] ??
		key
			.replace(/[_-]+/g, " ")
			.replace(/\b[a-z]/g, (char) => char.toUpperCase())
	);
}

function summarizeHermesEventPayloadValue(
	value: unknown,
	key: string,
	maxLength = 96
): string {
	if (Array.isArray(value)) {
		const noun = HERMES_EVENT_ARRAY_NOUNS[key] ?? "item";
		const count = value.length;
		const suffix = count === 1 ? noun : `${noun}s`;
		return `${count} ${suffix}`;
	}
	if (isHermesEventRecord(value)) {
		const entries = orderHermesEventPayloadKeys(value)
			.filter((entryKey) => !isEmptyHermesEventPayloadValue(value[entryKey]))
			.slice(0, 3)
			.map(
				(entryKey) =>
					`${formatHermesEventFieldLabel(entryKey)}: ${summarizeHermesEventPayloadValue(
						value[entryKey],
						entryKey,
						48
					)}`
			);
		return entries.length > 0 ? compactHermesActivityText(entries.join(", "), maxLength) : "No fields";
	}
	const text = hermesActivityText(value);
	return compactHermesActivityText(text, maxLength);
}

function formatHermesEventPayloadBody(payload: unknown): string {
	if (!isHermesEventRecord(payload)) {
		return "";
	}
	const sections: string[] = [];
	for (const key of orderHermesEventPayloadKeys(payload)) {
		const value = payload[key];
		if (Array.isArray(value) && value.length > 0) {
			const label = formatHermesEventFieldLabel(key);
			const noun = HERMES_EVENT_ARRAY_NOUNS[key] ?? "item";
			const suffix = value.length === 1 ? noun : `${noun}s`;
			const rows = value
				.slice(0, 6)
				.map((item) => `- ${summarizeHermesEventPayloadValue(item, key, 160)}`);
			if (value.length > rows.length) {
				rows.push(`- +${value.length - rows.length} more`);
			}
			sections.push(`${label} (${value.length} ${suffix})\n${rows.join("\n")}`);
		} else if (isHermesEventRecord(value)) {
			sections.push(
				`${formatHermesEventFieldLabel(key)}\n- ${summarizeHermesEventPayloadValue(value, key, 180)}`
			);
		}
	}
	return sections.join("\n\n");
}

function extractHermesEventActions(payload: unknown): HermesActivityAction[] {
	const actions: HermesActivityAction[] = [];
	const seen = new Set<string>();

	const addAction = (action: HermesActivityAction) => {
		const key = `${action.type}:${action.value.toLowerCase()}`;
		if (seen.has(key) || actions.length >= 8) {
			return;
		}
		seen.add(key);
		actions.push(action);
	};

	const visit = (value: unknown, keyHint = "") => {
		if (typeof value === "string") {
			const text = value.trim();
			if (!text) {
				return;
			}
			if (isHermesArtifactValue(text, keyHint)) {
				addAction({
					type: "artifact",
					label: artifactActionLabel(text),
					value: text,
				});
			}
			for (const match of text.matchAll(HERMES_TASK_ID_REGEX)) {
				const taskId = normalizeHermesTaskId(match[0]);
				addAction({
					type: "task",
					label: `Edit ${taskId}`,
					value: taskId,
				});
			}
			return;
		}
		if (Array.isArray(value)) {
			for (const item of value) {
				visit(item, keyHint);
			}
			return;
		}
		if (isHermesEventRecord(value)) {
			for (const [key, nestedValue] of Object.entries(value)) {
				visit(nestedValue, key);
			}
		}
	};

	visit(payload);
	return actions;
}

function isHermesArtifactValue(value: string, keyHint: string): boolean {
	const lowerKey = keyHint.toLowerCase();
	if (
		HERMES_EVENT_ARTIFACT_KEYS.has(lowerKey) ||
		lowerKey.endsWith("_file") ||
		lowerKey.endsWith("_files") ||
		lowerKey.endsWith("_path") ||
		lowerKey.endsWith("_paths")
	) {
		return true;
	}
	return (
		value.startsWith("/") ||
		value.startsWith("TaskNotes/") ||
		value.startsWith("30 Projects/") ||
		value.startsWith("20 Job-Search/") ||
		value.startsWith("10 Research-Wiki/") ||
		HERMES_EVENT_ARTIFACT_EXTENSIONS.test(value)
	);
}

function artifactActionLabel(path: string): string {
	const basename = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
	return `Open ${compactHermesActivityText(basename, 48)}`;
}

function normalizeHermesTaskId(taskId: string): string {
	return taskId.trim().toLowerCase();
}

export interface TaskEditOptions {
	task: TaskInfo;
	onTaskUpdated?: (task: TaskInfo) => void;
	modalTitle?: string;
	saveButtonText?: string;
	modalFieldsConfig?: ModalFieldsConfigLike;
}

export class TaskEditModal extends TaskModal {
	private task: TaskInfo;
	private options: TaskEditOptions;
	private metadataContainer: HTMLElement;
	private editModalKeyboardHandler: ((e: KeyboardEvent) => void) | null = null;
	// Changed from Set to array for consistency with other state management
	private completedInstancesChanges: string[] = [];
	private initialBlockedBy: TaskDependency[] = [];
	private initialBlockingPaths: string[] = [];
	private pendingBlockingUpdates: BlockingUpdates = { added: [], removed: [], raw: {} };
	private unresolvedBlockingEntries: string[] = [];
	private initialTags = "";
	private isShowingConfirmation = false;
	private pendingClose = false;
	private isConvertingNoteToTask = false;

	constructor(app: App, plugin: TaskNotesPlugin, options: TaskEditOptions) {
		super(app, plugin);
		this.task = options.task;
		this.options = options;
	}

	protected getCurrentTaskPath(): string | undefined {
		return this.task.path;
	}

	getModalTitle(): string {
		return this.options.modalTitle ?? this.t("modals.taskEdit.title");
	}

	protected isEditMode(): boolean {
		return true;
	}

	protected getModalFieldsConfig(): ModalFieldsConfigLike | undefined {
		return this.options.modalFieldsConfig ?? super.getModalFieldsConfig();
	}

	protected getPrimaryActionText(): string | undefined {
		return this.options.saveButtonText;
	}

	protected focusTitleInput(): void {
		if (this.isMobileLikeEnvironment()) {
			return;
		}
		super.focusTitleInput();
	}

	async initializeFormData(): Promise<void> {
		const formState = buildTaskEditFormStateFromTask({
			app: this.app,
			task: this.task,
			details: this.details,
			settings: {
				taskIdentificationMethod: this.plugin.settings.taskIdentificationMethod,
				taskTag: this.plugin.settings.taskTag,
				hideIdentifyingTagsMode: this.plugin.settings.hideIdentifyingTagsMode,
				userFields: this.plugin.settings?.userFields,
			},
			normalizeDetails: (value) => this.normalizeDetails(value),
		});

		this.title = formState.title;
		this.dueDate = formState.dueDate;
		this.scheduledDate = formState.scheduledDate;
		this.priority = formState.priority;
		this.status = formState.status;
		this.contexts = formState.contexts;

		// Initialize projects using the new method that handles both old and new formats
		if (formState.hasValidProjects) {
			this.initializeProjectsFromStrings(formState.projectValues);
		} else {
			this.projects = "";
			this.selectedProjectItems = [];
		}

		this.tags = formState.tags;
		this.initialTags = formState.initialTags;
		this.timeEstimate = formState.timeEstimate;
		this.recurrenceRule = formState.recurrenceRule;
		this.recurrenceAnchor = formState.recurrenceAnchor;
		this.reminders = formState.reminders;
		this.details = formState.details;
		this.originalDetails = formState.originalDetails;
		this.userFields = formState.userFields;

		// Initialize subtasks (tasks that have this task as a project)
		await this.initializeSubtasks();

		this.blockedByItems = (this.task.blockedBy ?? []).map((dependency) =>
			this.createDependencyItemFromDependency(dependency, this.task.path)
		);
		this.initialBlockedBy = this.blockedByItems.map((item) => ({ ...item.dependency }));

		this.blockingItems = (this.task.blocking ?? []).map((path) =>
			this.createDependencyItemFromPath(path)
		);
		this.initialBlockingPaths = this.blockingItems
			.filter((item) => item.path)
			.map((item) => item.path!);
		this.pendingBlockingUpdates = { added: [], removed: [], raw: {} };
		this.unresolvedBlockingEntries = [];
	}

	protected showReminderContextMenu(event: MouseEvent): void {
		// Override parent method to use the actual task with its path
		// Update the task object with current form values before showing menu
		showTaskModalReminderContextMenu(this.getActionMenuContext(), event, this.task);
	}

	onOpen(): void {
		void this.openEditModal();
	}

	private async openEditModal(): Promise<void> {
		// Clear any previous completion changes
		this.completedInstancesChanges = [];

		// Refresh task data from file before opening
		await this.refreshTaskData();

		this.containerEl.addClass("tasknotes-plugin", "minimalist-task-modal", "expanded");
		if (this.plugin.settings.enableModalSplitLayout) {
			this.containerEl.addClass("split-layout-enabled");
		}
		this.modalEl.addClass("mod-tasknotes");

		// Set the modal title using the standard Obsidian approach (preserves close button)
		this.titleEl.setText(this.getModalTitle());

		// Add global keyboard shortcut handler for CMD/Ctrl+Enter
		this.editModalKeyboardHandler = (e: KeyboardEvent) => {
			if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
				e.preventDefault();
				void (async () => {
					await this.handleSave();
					this.forceClose();
				})();
			}
		};
		this.containerEl.addEventListener("keydown", this.editModalKeyboardHandler);

		void this.initializeFormData().then(() => {
			this.createModalContent();
			// Render projects list after modal content is created
			this.renderProjectsList();
			// Update icon states after creating the action bar
			this.updateIconStates();
			this.focusTitleInput();
		});
	}

	private async refreshTaskData(): Promise<void> {
		try {
			const file = this.app.vault.getAbstractFileByPath(this.task.path);
			if (!file || !(file instanceof TFile)) {
				tasknotesLogger.warn("Could not find file for task:", {
					category: "stale-data",
					operation: "find-file-task",
					details: { value: this.task.path },
				});
				return;
			}

			const content = await this.app.vault.read(file);
			this.details = this.extractDetailsFromContent(content);
			this.originalDetails = this.details;

			// Check if this file is actually a task (has task tag/property)
			// If not, keep the original task data (e.g., for "convert note to task" flow)
			const metadata = this.app.metadataCache.getFileCache(file);
			const isRecognizedTask =
				metadata?.frontmatter && this.plugin.cacheManager.isTaskFile(metadata.frontmatter);

			if (!isRecognizedTask) {
				// File is not yet a task - keep the original task data passed to constructor
				// This preserves user's default settings for status/priority during conversion
				this.isConvertingNoteToTask = true;
				this.task.details = this.details;
				return;
			}

			this.isConvertingNoteToTask = false;

			const cachedTaskInfo = await this.plugin.cacheManager.getTaskInfo(this.task.path);

			if (cachedTaskInfo) {
				cachedTaskInfo.details = this.details;
				this.task = cachedTaskInfo;
				this.options.task = cachedTaskInfo;
			} else {
				const freshTaskInfo = extractTaskInfo(
					this.app,
					content,
					this.task.path,
					file,
					this.plugin.fieldMapper,
					this.plugin.settings.storeTitleInFilename,
					this.plugin.settings.defaultTaskStatus
				);

				if (freshTaskInfo) {
					freshTaskInfo.details = this.details;
					this.task = freshTaskInfo;
					this.options.task = freshTaskInfo;
				}
			}
		} catch (error) {
			tasknotesLogger.warn("Could not refresh task data:", {
				category: "stale-data",
				operation: "refresh-task-data",
				error: error,
			});
		}
	}

	/**
	 * Edit modal has no primary input at top - title is in the details section
	 */
	protected createPrimaryInput(container: HTMLElement): void {
		// No-op: Edit modal shows title in the details section, not at top
	}

	/**
	 * Add completions calendar and metadata sections after details
	 */
	protected createAdditionalSections(container: HTMLElement): void {
		this.createHermesActivitySections({
			commentsContainer: this.detailsContainer ?? container,
			readOnlyContainer: this.getHermesReadOnlyActivityContainer(container),
		});
		createCompletionsCalendarSection(container, {
			task: this.task,
			plugin: this.plugin,
			completedInstancesChanges: this.completedInstancesChanges,
			translate: (key, params) => this.t(key, params),
		});
		this.createMetadataSection(container);
	}

	private getHermesReadOnlyActivityContainer(fallbackContainer: HTMLElement): HTMLElement {
		if (!this.splitRightColumn) {
			return this.detailsContainer ?? fallbackContainer;
		}

		this.splitRightColumn.addClass("modal-split-right--with-readonly");
		this.splitContentWrapper?.removeClass("modal-split-content--right-empty");
		return this.splitRightColumn;
	}

	private createHermesActivitySections(containers: HermesActivityContainers): void {
		if (!getHermesTaskIdentity(this.task)) {
			return;
		}

		const { commentsContainer, readOnlyContainer } = containers;
		const commentButtonRef: { el?: HTMLButtonElement } = {};
		let isComposerVisible = false;

		const section = this.createHermesActivitySection(
			commentsContainer,
			"Comments",
			["tn-task-modal__hermes-comments"],
			(setting) => {
				setting.addButton((button) => {
					button.setButtonText("Add comment").setTooltip("Add comment");
					button.buttonEl.addClasses(["tn-btn", "tn-btn--ghost"]);
					commentButtonRef.el = button.buttonEl;
				});
			}
		);

		const commentsList = section.createDiv({
			cls: "task-projects-list tn-task-modal__hermes-comment-list",
		});
		this.renderHermesCommentCards(
			commentsList,
			this.getFallbackHermesCommentsFromTaskDetails()
		);

		const commentInput = section.createEl("textarea", {
			cls: "tn-task-modal__hermes-comment-input title-input-detailed",
			attr: {
				placeholder: "Add a comment... (Enter to submit)",
				rows: "1",
			},
		});
		commentInput.spellcheck = true;
		commentInput.setAttribute("aria-label", "Add a comment");
		commentInput.addClass("tn-task-modal__hermes-comment-input--hidden");
		const updateCommentButtonState = () => {
			const commentButtonEl = commentButtonRef.el;
			if (commentButtonEl) {
				commentButtonEl.disabled =
					isComposerVisible && commentInput.value.trim().length === 0;
			}
		};
		const showCommentComposer = () => {
			isComposerVisible = true;
			commentInput.removeClass("tn-task-modal__hermes-comment-input--hidden");
			if (commentButtonRef.el) {
				commentButtonRef.el.textContent = "Comment";
				commentButtonRef.el.setAttribute("aria-label", "Send comment");
			}
			updateCommentButtonState();
			window.requestAnimationFrame(() => {
				resizeTaskModalTitleTextarea(commentInput);
				commentInput.focus();
			});
		};
		updateCommentButtonState();
		commentInput.addEventListener("input", () => {
			updateCommentButtonState();
			resizeTaskModalTitleTextarea(commentInput);
		});
		commentInput.addEventListener("keydown", (event) => {
			if (event.key !== "Enter" || event.shiftKey || event.metaKey || event.ctrlKey) {
				return;
			}
			event.preventDefault();
			void this.handleHermesCommentSubmit(commentInput, commentButtonRef.el ?? null);
		});
		const commentButtonEl = commentButtonRef.el;
		if (commentButtonEl) {
			commentButtonEl.addEventListener("click", () => {
				if (!isComposerVisible) {
					showCommentComposer();
					return;
				}
				void this.handleHermesCommentSubmit(commentInput, commentButtonRef.el ?? null);
			});
		}

		const runHistorySection = this.createHermesActivitySection(readOnlyContainer, "Run history");
		const runHistoryList = runHistorySection.createDiv({
			cls: "task-projects-list tn-task-modal__hermes-activity-list",
		});
		this.renderHermesActivityCards(runHistorySection, runHistoryList, []);

		const eventsSection = this.createHermesActivitySection(readOnlyContainer, "Events");
		const eventsList = eventsSection.createDiv({
			cls: "task-projects-list tn-task-modal__hermes-activity-list",
		});
		this.renderHermesActivityCards(
			eventsSection,
			eventsList,
			this.getFallbackHermesEventCardsFromTaskDetails()
		);

		void this.loadHermesActivityCards({
			commentsList,
			runHistorySection,
			runHistoryList,
			eventsSection,
			eventsList,
		});
	}

	private createHermesActivitySection(
		container: HTMLElement,
		label: string,
		extraClasses: string[] = [],
		configure?: (setting: Setting) => void
	): HTMLElement {
		const section = container.createDiv({
			cls: ["tn-task-modal__hermes-activity-section", ...extraClasses].join(" "),
		});
		this.createHermesActivityHeader(section, label, configure);
		return section;
	}

	private createHermesActivityHeader(
		section: HTMLElement,
		label: string,
		configure?: (setting: Setting) => void
	): void {
		const setting = new Setting(section).setName(label);
		configure?.(setting);
	}

	private async loadHermesActivityCards(elements: HermesActivityElements): Promise<void> {
		const identity = getHermesTaskIdentity(this.task);
		if (!identity) {
			return;
		}

		try {
			const detail = await new HermesKanbanApiClient().getTask(identity);
			this.renderHermesCommentCards(
				elements.commentsList,
				normalizeHermesComments(detail.comments ?? [])
			);
			this.renderHermesActivityCards(
				elements.runHistorySection,
				elements.runHistoryList,
				this.buildHermesRunHistoryCards(detail)
			);
			this.renderHermesActivityCards(
				elements.eventsSection,
				elements.eventsList,
				this.buildHermesEventCards(detail)
			);
		} catch (error) {
			tasknotesLogger.warn("Failed to load Hermes activity:", {
				category: "provider",
				operation: "load-hermes-activity",
				error,
			});
		}
	}

	private renderHermesCommentCards(listEl: HTMLElement, comments: HermesCommentCard[]): void {
		listEl.empty();
		if (comments.length === 0) {
			return;
		}

		for (const comment of comments.slice(-5)) {
			const fullTitle = hermesActivityText(comment.body);
			this.renderHermesActivityCardItem(listEl, {
				title: compactHermesActivityText(fullTitle, 180),
				fullTitle,
				meta: formatHermesCommentMeta(comment),
			});
		}
	}

	private renderHermesActivityCards(
		section: HTMLElement,
		listEl: HTMLElement,
		cards: HermesActivityCard[]
	): void {
		listEl.empty();
		section.classList.toggle(
			"tn-task-modal__hermes-activity-section--empty",
			cards.length === 0
		);
		if (cards.length === 0) {
			return;
		}

		for (const card of cards) {
			this.renderHermesActivityCardItem(listEl, card);
		}
	}

	private renderHermesActivityCardItem(listEl: HTMLElement, card: HermesActivityCard): void {
		const itemEl = listEl.createDiv({
			cls: "task-project-item task-project-item--task-card tn-task-modal__hermes-activity-item",
		});
		const cardHostEl = itemEl.createDiv({
			cls: "task-project-card-host tn-task-modal__hermes-activity-card-host",
		});
		const cardEl = cardHostEl.createDiv({
			cls: [
				"task-card",
				"task-card--has-details",
				"tn-task-modal__hermes-activity-card",
			].join(" "),
		});
		const mainRowEl = cardEl.createDiv({ cls: "task-card__main-row" });

		const contentEl = mainRowEl.createDiv({ cls: "task-card__content" });
		const titleEl = contentEl.createDiv({ cls: "task-card__title" });
		titleEl.createSpan({
			cls: "task-card__title-text tn-task-modal__hermes-activity-title",
			text: card.title,
		});
		const titleTextEl = titleEl.querySelector<HTMLElement>(
			".tn-task-modal__hermes-activity-title"
		);

		if (card.meta) {
			const metadataEl = contentEl.createDiv({ cls: "task-card__metadata" });
			metadataEl.createSpan({
				cls: "task-card__metadata-item tn-task-modal__hermes-activity-time",
				text: card.meta,
			});
		}

		if (card.details?.length) {
			const detailsEl = contentEl.createDiv({
				cls: "tn-task-modal__hermes-activity-details",
			});
			for (const detail of card.details) {
				const rowEl = detailsEl.createDiv({
					cls: "tn-task-modal__hermes-activity-detail-row",
				});
				rowEl.createSpan({
					cls: "tn-task-modal__hermes-activity-detail-label",
					text: detail.label,
				});
				rowEl.createSpan({
					cls: "tn-task-modal__hermes-activity-detail-value",
					text: detail.value,
				});
			}
		}

		if (card.actions?.length) {
			const actionsEl = contentEl.createDiv({
				cls: "tn-task-modal__hermes-activity-actions",
			});
			for (const action of card.actions) {
				const actionEl = actionsEl.createEl("button", {
					cls: "tn-task-modal__hermes-activity-action",
					text: action.label,
					attr: {
						type: "button",
					},
				});
				actionEl.addEventListener("click", (event) => {
					event.preventDefault();
					event.stopPropagation();
					void this.handleHermesActivityAction(action);
				});
			}
		}

		if (card.body) {
			const bodyEl = contentEl.createDiv({
				cls: "tn-task-modal__hermes-activity-body",
				text: card.body,
			});
			this.attachHermesActivityCardToggle(itemEl, cardEl, titleTextEl, card, bodyEl);
			return;
		}

		this.attachHermesActivityCardToggle(itemEl, cardEl, titleTextEl, card);
	}

	private attachHermesActivityCardToggle(
		itemEl: HTMLElement,
		cardEl: HTMLElement,
		titleTextEl: HTMLElement | null,
		card: HermesActivityCard,
		bodyEl?: HTMLElement
	): void {
		const fullTitle = card.fullTitle?.trim();
		const canExpandTitle = Boolean(fullTitle && fullTitle !== card.title);
		const canExpandBody = Boolean(bodyEl && card.body && card.body.length > 260);
		if (!canExpandTitle && !canExpandBody) {
			return;
		}

		cardEl.addClass("tn-task-modal__hermes-activity-card--expandable");
		cardEl.tabIndex = 0;
		cardEl.setAttribute("role", "button");
		cardEl.setAttribute("aria-expanded", "false");
		setTooltip(cardEl, "Expand activity", { placement: "top" });

		const toggleExpanded = (event: Event) => {
			event.preventDefault();
			event.stopPropagation();
			const expanded = !itemEl.classList.contains(
				"tn-task-modal__hermes-activity-item--expanded"
			);
			itemEl.classList.toggle("tn-task-modal__hermes-activity-item--expanded", expanded);
			cardEl.setAttribute("aria-expanded", String(expanded));
			if (titleTextEl && canExpandTitle) {
				titleTextEl.textContent = expanded ? fullTitle! : card.title;
				titleTextEl.classList.toggle(
					"tn-task-modal__hermes-activity-title--expanded",
					expanded
				);
			}
			if (bodyEl && canExpandBody) {
				bodyEl.classList.toggle("tn-task-modal__hermes-activity-body--expanded", expanded);
			}
			setTooltip(cardEl, expanded ? "Collapse activity" : "Expand activity", {
				placement: "top",
			});
		};

		cardEl.addEventListener("click", toggleExpanded);
		cardEl.addEventListener("keydown", (event) => {
			if (event.key !== "Enter" && event.key !== " ") {
				return;
			}
			toggleExpanded(event);
		});
	}

	private async handleHermesActivityAction(action: HermesActivityAction): Promise<void> {
		try {
			if (action.type === "artifact") {
				await this.plugin.openHermesArtifactPath(action.value);
				return;
			}

			const identity = getHermesTaskIdentity(this.task);
			await this.plugin.openHermesTaskEditModalById(action.value, identity?.board);
		} catch (error) {
			tasknotesLogger.error("Failed to handle Hermes activity action:", {
				category: "internal",
				operation: "hermes-activity-action",
				error,
			});
			new Notice("Could not open activity target.");
		}
	}

	private buildHermesRunHistoryCards(detail: HermesTaskDetailResponse): HermesActivityCard[] {
		return normalizeHermesRuns(detail.runs ?? [])
			.slice(-3)
			.reverse()
			.map((run) => {
				const fullTitle = hermesActivityText(
					run.summary || run.error || "No run summary yet."
				);
				return {
					title: compactHermesActivityText(fullTitle, 180),
					fullTitle,
					meta: formatHermesActivityTimestamp(run.endedAt ?? run.startedAt),
				};
			});
	}

	private buildHermesEventCards(detail: HermesTaskDetailResponse): HermesActivityCard[] {
		return normalizeHermesEvents(detail.events ?? [])
			.slice(-5)
			.reverse()
			.map((event) => formatHermesEventCard(event));
	}

	private getFallbackHermesCommentsFromTaskDetails(): HermesCommentCard[] {
		const sectionBody = this.task.details?.match(
			/^## Latest Comment\s*\n+([\s\S]*?)(?=\n## |\n<!--|$)/m
		)?.[1];
		if (!sectionBody) {
			return [];
		}

		const body = sectionBody.replace(/^\s*-\s*/, "").trim();
		if (!body || /^none$/i.test(body)) {
			return [];
		}

		const authorMatch = body.match(/^([^:\n]{1,80}):\s+([\s\S]+)$/);
		return [
			{
				author: authorMatch?.[1]?.trim() || "Hermes",
				body: authorMatch?.[2]?.trim() || body,
			},
		];
	}

	private getFallbackHermesEventCardsFromTaskDetails(): HermesActivityCard[] {
		const latestEvent = this.getFallbackHermesMarkdownSection("Latest Event");
		if (!latestEvent || /^-\s*none$/i.test(latestEvent)) {
			return [];
		}
		const fullTitle = hermesActivityText(latestEvent.replace(/^\s*-\s*/, ""));
		return [
			{
				title: compactHermesActivityText(fullTitle, 180),
				fullTitle,
			},
		];
	}

	private getFallbackHermesMarkdownSection(heading: string): string {
		const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const sectionBody = this.task.details?.match(
			new RegExp(`^## ${escapedHeading}\\s*\\n+([\\s\\S]*?)(?=\\n## |\\n<!--|$)`, "m")
		)?.[1];
		return sectionBody?.trim() ?? "";
	}

	private getHermesStatus(): string {
		return (this.task.status || "").trim().toLowerCase();
	}

	private hasUnsavedHermesModalChanges(): boolean {
		return (
			Object.keys(this.getChanges()).length > 0 ||
			this.pendingBlockingUpdates.added.length > 0 ||
			this.pendingBlockingUpdates.removed.length > 0 ||
			this.hasSubtaskChanges()
		);
	}

	private async promptHermesActionText(options: {
		title: string;
		placeholder: string;
		confirmText: string;
	}): Promise<string | null> {
		const value = await showTextInputModal(this.app, options);
		const trimmed = value?.trim();
		return trimmed ? trimmed : null;
	}

	private async sendHermesAction(
		actionLabel: string,
		operation: (
			api: HermesKanbanApiClient,
			identity: { board: string; id: string }
		) => Promise<HermesTaskDetailResponse | null>
	): Promise<boolean> {
		if (this.hasUnsavedHermesModalChanges()) {
			new Notice("Save or cancel the current edits before sending an action.");
			return false;
		}

		const identity = getHermesTaskIdentity(this.task);
		if (!identity) {
			new Notice("This task is missing a board or task ID.");
			return false;
		}

		try {
			const api = new HermesKanbanApiClient();
			const detail = await operation(api, identity);
			const updatedTask = detail?.task
				? await this.refreshHermesMirror(identity.board, detail)
				: this.task;
			if (this.options.onTaskUpdated) {
				this.options.onTaskUpdated(updatedTask);
			}
			new Notice(`${actionLabel} sent`);
			this.forceClose();
			return true;
		} catch (error) {
			tasknotesLogger.error("Failed to send board action:", {
				category: "persistence",
				operation: "hermes-action",
				error,
			});
			const message = error instanceof Error && error.message ? error.message : String(error);
			new Notice(`Action failed: ${message}`);
			return false;
		}
	}

	private async refreshHermesMirror(
		board: string,
		detail: HermesTaskDetailResponse
	): Promise<TaskInfo> {
		if (!detail.task) return this.task;
		const { taskInfo } = await createOrUpdateHermesMirrorNote(this.plugin, board, detail.task, {
			parents: detail.links?.parents ?? [],
			children: detail.links?.children ?? [],
		});
		this.task = taskInfo;
		this.options.task = taskInfo;
		return taskInfo;
	}

	private async handleHermesCommentSubmit(
		input: HTMLTextAreaElement,
		button: HTMLButtonElement | null
	): Promise<void> {
		const comment = input.value.trim();
		if (!comment) return;
		input.disabled = true;
		if (button) button.disabled = true;
		const sent = await this.sendHermesAction("Comment", async (api, identity) => {
			await api.addComment(identity, { body: comment, author: "tasknotes" });
			return api.getTask(identity);
		});
		if (!sent) {
			input.disabled = false;
			if (button) button.disabled = input.value.trim().length === 0;
			input.focus();
		}
	}

	/**
	 * Force close the modal without checking for unsaved changes.
	 * Use this after a successful save or when discarding is intentional.
	 */
	forceClose(): void {
		this.pendingClose = true;
		super.close();
	}

	/**
	 * Override close() to detect unsaved changes and prompt user.
	 * This method is synchronous to match Obsidian's Modal.close() signature.
	 */
	close(): void {
		// If we're already forcing close or showing confirmation, proceed
		if (this.pendingClose) {
			this.pendingClose = false;
			super.close();
			return;
		}

		// Prevent re-entrancy if confirmation is already showing
		if (this.isShowingConfirmation) {
			return;
		}

		// Check for unsaved changes
		const changes = this.getChanges();
		const hasChanges = Object.keys(changes).length > 0;

		if (!hasChanges) {
			// No changes, close immediately
			super.close();
			return;
		}

		// Show confirmation modal asynchronously
		void this.showUnsavedChangesConfirmation();
	}

	/**
	 * Show confirmation modal for unsaved changes.
	 * Handles the async flow separately from the synchronous close() method.
	 */
	private async showUnsavedChangesConfirmation(): Promise<void> {
		this.isShowingConfirmation = true;

		try {
			const result = await this.showThreeButtonConfirmation();

			if (result === "save") {
				// User wants to save - attempt save and close on success
				try {
					await this.handleSave();
					this.forceClose();
				} catch (error) {
					// Save failed - stay open so user can fix issues
					// handleSave() already shows a notice with the error
					tasknotesLogger.error("Save failed during close confirmation:", {
						category: "persistence",
						operation: "save-close-confirmation",
						error: error,
					});
				}
			} else if (result === "discard") {
				// User wants to discard changes
				this.forceClose();
			}
			// result === "cancel" - do nothing, user wants to keep editing
		} finally {
			this.isShowingConfirmation = false;
		}
	}

	/**
	 * Show a three-button confirmation dialog for unsaved changes.
	 * Returns: "save" | "discard" | "cancel"
	 */
	private showThreeButtonConfirmation(): Promise<"save" | "discard" | "cancel"> {
		return new Promise((resolve) => {
			const modal = new ConfirmationModal(this.app, {
				title: this.t("modals.task.unsavedChanges.title"),
				message: this.t("modals.task.unsavedChanges.message"),
				confirmText: this.t("modals.task.unsavedChanges.save"),
				cancelText: this.t("modals.task.unsavedChanges.discard"),
				thirdButtonText: this.t("modals.task.unsavedChanges.cancel"),
				defaultToConfirm: true,
				onThirdButton: () => resolve("cancel"),
			});

			void modal.show().then((confirmed) => {
				if (confirmed) {
					resolve("save");
				} else {
					resolve("discard");
				}
			});
		});
	}

	onClose(): void {
		// Clean up keyboard handler
		if (this.editModalKeyboardHandler) {
			this.containerEl.removeEventListener("keydown", this.editModalKeyboardHandler);
			this.editModalKeyboardHandler = null;
		}

		// Base class handles detailsMarkdownEditor cleanup
		super.onClose();
	}

	private createMetadataSection(container: HTMLElement): void {
		this.metadataContainer = container.createDiv("metadata-container");

		const metadataLabel = this.metadataContainer.createDiv("detail-label");
		metadataLabel.textContent = this.t("modals.taskEdit.sections.taskInfo");

		const metadataContent = this.metadataContainer.createDiv("metadata-content");

		// Total tracked time
		const totalTimeSpent = calculateTotalTimeSpent(this.task.timeEntries || []);
		if (totalTimeSpent > 0) {
			const timeDiv = metadataContent.createDiv("metadata-item");
			timeDiv.createSpan("metadata-key").textContent =
				this.t("modals.taskEdit.metadata.totalTrackedTime") + " ";
			timeDiv.createSpan("metadata-value").textContent = formatTime(totalTimeSpent);
		}

		// Created date
		if (this.task.dateCreated) {
			const createdDiv = metadataContent.createDiv("metadata-item");
			createdDiv.createSpan("metadata-key").textContent =
				this.t("modals.taskEdit.metadata.created") + " ";
			createdDiv.createSpan("metadata-value").textContent = formatTimestampForDisplay(
				this.task.dateCreated
			);
		}

		// Modified date
		if (this.task.dateModified) {
			const modifiedDiv = metadataContent.createDiv("metadata-item");
			modifiedDiv.createSpan("metadata-key").textContent =
				this.t("modals.taskEdit.metadata.modified") + " ";
			modifiedDiv.createSpan("metadata-value").textContent = formatTimestampForDisplay(
				this.task.dateModified
			);
		}

		// File path (if available)
		if (this.task.path) {
			const pathDiv = metadataContent.createDiv("metadata-item");
			pathDiv.createSpan("metadata-key").textContent =
				this.t("modals.taskEdit.metadata.file") + " ";
			pathDiv.createSpan("metadata-value").textContent = this.task.path;
		}
	}

	private async handleHermesSave(
		changes: Partial<TaskInfo>,
		hasBlockingChanges: boolean,
		hasSubtaskChanges: boolean
	): Promise<void> {
		const identity = getHermesTaskIdentity(this.task);
		if (!identity) {
			new Notice("This task is missing a board or task ID.");
			return;
		}

		if (hasSubtaskChanges) {
			new Notice("Subtasks are not wired yet. Use blocking / blocked by links.");
			return;
		}

		const api = new HermesKanbanApiClient();
		let didHermesWrite = false;
		const payload = await this.hermesUpdatePayloadFromChanges(changes);
		if (payload === null) {
			return;
		}
		if (Object.keys(payload).length > 0) {
			await api.updateTask(identity, payload);
			didHermesWrite = true;
		}

		if (Object.prototype.hasOwnProperty.call(changes, "blockedBy")) {
			await this.applyHermesBlockedByLinkChanges(api, identity);
			didHermesWrite = true;
		}

		if (hasBlockingChanges) {
			await this.applyHermesBlockingLinkChanges(api, identity);
			didHermesWrite = true;
		}

		if (Object.prototype.hasOwnProperty.call(changes, "details")) {
			new Notice("Details are read-only here for now. Use add comment for updates.");
		}

		if (!didHermesWrite) {
			new Notice("No board-backed changes to save.");
			return;
		}

		const detail = await api.getTask(identity);
		const updatedTask = await this.refreshHermesMirror(identity.board, detail);
		if (this.options.onTaskUpdated) {
			this.options.onTaskUpdated(updatedTask);
		}
		this.pendingBlockingUpdates = { added: [], removed: [], raw: {} };
		this.unresolvedBlockingEntries = [];
		new Notice(`Task updated: ${updatedTask.title}`);
	}

	private async hermesUpdatePayloadFromChanges(changes: Partial<TaskInfo>): Promise<{
		status?: string;
		title?: string;
		priority?: number;
		assignee?: string | null;
		result?: string;
		summary?: string;
		block_reason?: string;
	} | null> {
		const payload: {
			status?: string;
			title?: string;
			priority?: number;
			assignee?: string | null;
			result?: string;
			summary?: string;
			block_reason?: string;
		} = {};
		const assigneePayload = this.hermesAssigneePayloadFromChanges(changes);

		if (typeof changes.title === "string") {
			payload.title = changes.title;
		}
		if (typeof changes.priority === "string") {
			payload.priority = this.hermesPriorityFromTaskNotesPriority(changes.priority);
		}
		if (typeof changes.status === "string") {
			if (changes.status === "running") {
				throw new Error("Running state is claimed by the dispatcher, not TaskNotes.");
			}
			payload.status = changes.status;
			if (changes.status === "blocked" && assigneePayload?.status !== "blocked") {
				const reason = await this.promptHermesActionText({
					title: "Block task",
					placeholder: "Why is this blocked?",
					confirmText: "Block",
				});
				if (!reason) return null;
				payload.block_reason = reason;
			}
			if (changes.status === "done") {
				const result = await this.promptHermesActionText({
					title: "Complete task",
					placeholder: "Result / closeout summary",
					confirmText: "Complete",
				});
				if (!result) return null;
				payload.result = result;
				payload.summary = result;
			}
		}
		if (assigneePayload) {
			Object.assign(payload, assigneePayload);
		}

		return payload;
	}

	private hermesAssigneePayloadFromChanges(
		changes: Partial<TaskInfo>
	): { assignee: string | null; status?: string; block_reason?: string } | null {
		if (Object.prototype.hasOwnProperty.call(changes, "contexts")) {
			return buildHermesAssigneeUpdatePayload(changes.contexts);
		}

		const customFrontmatter = (changes as { customFrontmatter?: Record<string, unknown> })
			.customFrontmatter;
		if (
			!customFrontmatter ||
			!Object.prototype.hasOwnProperty.call(customFrontmatter, "assignee")
		) {
			return null;
		}
		return buildHermesAssigneeUpdatePayload(customFrontmatter.assignee);
	}

	private hermesPriorityFromTaskNotesPriority(priority: string): number {
		if (priority === "high") return 8;
		if (priority === "normal") return 5;
		if (priority === "low") return 2;
		return 0;
	}

	private async applyHermesBlockedByLinkChanges(
		api: HermesKanbanApiClient,
		identity: { board: string; id: string }
	): Promise<void> {
		const before = new Set(
			this.initialBlockedBy.map((dependency) => this.idFromDependency(dependency))
		);
		before.delete("");
		const afterResolution = await this.resolveHermesDependencyItems(
			this.blockedByItems,
			identity.board
		);
		const after = new Set(afterResolution.ids);
		for (const parentId of after) {
			if (!before.has(parentId)) {
				await api.addLink({ board: identity.board, parentId, childId: identity.id });
			}
		}
		for (const parentId of before) {
			if (!after.has(parentId)) {
				await api.deleteLink({ board: identity.board, parentId, childId: identity.id });
			}
		}
		this.noticeUnresolvedHermesLinks(afterResolution.unresolved);
	}

	private async applyHermesBlockingLinkChanges(
		api: HermesKanbanApiClient,
		identity: { board: string; id: string }
	): Promise<void> {
		const added = await this.resolveHermesPaths(
			this.pendingBlockingUpdates.added,
			identity.board
		);
		const removed = await this.resolveHermesPaths(
			this.pendingBlockingUpdates.removed,
			identity.board
		);
		for (const childId of added.ids) {
			await api.addLink({ board: identity.board, parentId: identity.id, childId });
		}
		for (const childId of removed.ids) {
			await api.deleteLink({ board: identity.board, parentId: identity.id, childId });
		}
		this.noticeUnresolvedHermesLinks([...added.unresolved, ...removed.unresolved]);
	}

	private async resolveHermesDependencyItems(
		items: Array<{ path?: string; dependency: TaskDependency }>,
		board: string
	): Promise<{ ids: string[]; unresolved: string[] }> {
		const ids: string[] = [];
		const unresolved: string[] = [];
		for (const item of items) {
			if (item.path) {
				const resolved = await this.resolveHermesPath(item.path, board);
				if (resolved) {
					ids.push(resolved);
					continue;
				}
			}
			const directId = this.idFromDependency(item.dependency);
			if (directId) {
				ids.push(directId);
			} else {
				unresolved.push(item.dependency.uid);
			}
		}
		return { ids: [...new Set(ids)], unresolved };
	}

	private async resolveHermesPaths(
		paths: string[],
		board: string
	): Promise<{ ids: string[]; unresolved: string[] }> {
		const ids: string[] = [];
		const unresolved: string[] = [];
		for (const path of paths) {
			const resolved = await this.resolveHermesPath(path, board);
			if (resolved) {
				ids.push(resolved);
			} else {
				unresolved.push(path);
			}
		}
		return { ids: [...new Set(ids)], unresolved };
	}

	private async resolveHermesPath(path: string, board: string): Promise<string | null> {
		const task = await this.plugin.cacheManager.getTaskInfo(path);
		const identity = task ? getHermesTaskIdentity(task) : null;
		if (identity && identity.board === board) {
			return identity.id;
		}
		const pathMatch = path.match(/^TaskNotes\/Hermes\/([^/]+)\/([^/]+)\.md$/);
		if (pathMatch && pathMatch[1] === board) {
			return pathMatch[2];
		}
		return null;
	}

	private idFromDependency(dependency: TaskDependency): string {
		return dependency.uid.match(/\b(t_[A-Za-z0-9]+)\b/)?.[1] ?? "";
	}

	private noticeUnresolvedHermesLinks(unresolved: string[]): void {
		if (unresolved.length === 0) return;
		new Notice(`Some Hermes links were not changed: ${unresolved.join(", ")}`);
	}

	async handleSave(): Promise<void> {
		if (!this.validateForm()) {
			new Notice(this.t("modals.taskEdit.notices.titleRequired"));
			return;
		}

		try {
			const changes = this.getChanges({ includeConversionWrite: true });
			const hasBlockingChanges =
				this.pendingBlockingUpdates.added.length > 0 ||
				this.pendingBlockingUpdates.removed.length > 0;
			const hasTaskChanges = Object.keys(changes).length > 0;
			const hasSubtaskChanges = this.hasSubtaskChanges();

			if (this.unresolvedBlockingEntries.length > 0 && !hasBlockingChanges) {
				new Notice(
					this.t("modals.taskEdit.notices.blockingUnresolved", {
						entries: this.unresolvedBlockingEntries.join(", "),
					})
				);
				this.unresolvedBlockingEntries = [];
			}

			if (!hasTaskChanges && !hasBlockingChanges && !hasSubtaskChanges) {
				new Notice(this.t("modals.taskEdit.notices.noChanges"));
				this.close();
				return;
			}

			if (getHermesTaskIdentity(this.task)) {
				await this.handleHermesSave(changes, hasBlockingChanges, hasSubtaskChanges);
				return;
			}

			let updatedTask = this.task;

			if (hasTaskChanges) {
				updatedTask = await this.plugin.taskService.updateTask(this.task, changes);
				this.task = updatedTask;
				if (Object.prototype.hasOwnProperty.call(changes, "details")) {
					const updatedDetails = stringifyUnknown(
						(changes as Record<string, unknown>).details
					);
					this.details = updatedDetails;
					this.originalDetails = updatedDetails;
				}
			}

			if (hasBlockingChanges) {
				await this.plugin.taskService.updateBlockingRelationships(
					updatedTask,
					this.pendingBlockingUpdates.added,
					this.pendingBlockingUpdates.removed,
					this.pendingBlockingUpdates.raw
				);

				const refreshed = await this.plugin.cacheManager.getTaskInfo(updatedTask.path);
				if (refreshed) {
					updatedTask = refreshed;
					this.task = refreshed;
				}
			}

			if (hasSubtaskChanges) {
				await this.applySubtaskChanges(updatedTask);
			}

			if (this.unresolvedBlockingEntries.length > 0) {
				new Notice(
					this.t("modals.taskEdit.notices.blockingUnresolved", {
						entries: this.unresolvedBlockingEntries.join(", "),
					})
				);
			}

			if (this.options.onTaskUpdated) {
				this.options.onTaskUpdated(updatedTask);
			}

			if (hasTaskChanges) {
				new Notice(
					this.t("modals.taskEdit.notices.updateSuccess", { title: updatedTask.title })
				);
			} else if (hasBlockingChanges) {
				new Notice(this.t("modals.taskEdit.notices.dependenciesUpdateSuccess"));
			}

			this.pendingBlockingUpdates = { added: [], removed: [], raw: {} };
			this.unresolvedBlockingEntries = [];
		} catch (error) {
			tasknotesLogger.error("Failed to update task:", {
				category: "validation",
				operation: "update-task",
				error: error,
			});
			const message = error instanceof Error && error.message ? error.message : String(error);
			new Notice(this.t("modals.taskEdit.notices.updateFailure", { message }));
		}
	}

	private getChanges(options: { includeConversionWrite?: boolean } = {}): Partial<TaskInfo> {
		const result = buildTaskEditChangesFromModalState({
			app: this.app,
			task: this.task,
			title: this.title,
			dueDate: this.dueDate,
			scheduledDate: this.scheduledDate,
			priority: this.priority,
			status: this.status,
			contexts: this.contexts,
			projects: this.projects,
			tags: this.tags,
			initialTags: this.initialTags,
			timeEstimate: this.timeEstimate,
			recurrenceRule: this.recurrenceRule,
			recurrenceAnchor: this.recurrenceAnchor,
			reminders: this.reminders,
			blockedByItems: this.blockedByItems,
			initialBlockedBy: this.initialBlockedBy,
			blockingItems: this.blockingItems,
			initialBlockingPaths: this.initialBlockingPaths,
			details: this.details,
			originalDetails: this.originalDetails,
			completedInstancesChanges: this.completedInstancesChanges,
			userFields: this.userFields,
			settings: {
				userFields: this.plugin.settings?.userFields,
				taskIdentificationMethod: this.plugin.settings.taskIdentificationMethod,
				taskTag: this.plugin.settings.taskTag,
				hideIdentifyingTagsMode: this.plugin.settings.hideIdentifyingTagsMode,
				maintainDueDateOffsetInRecurring:
					this.plugin.settings.maintainDueDateOffsetInRecurring,
			},
			normalizeDetails: (value) => this.normalizeDetails(value),
		});

		this.pendingBlockingUpdates = result.blockingUpdates;
		this.unresolvedBlockingEntries = result.unresolvedBlockingEntries;

		if (
			options.includeConversionWrite &&
			this.isConvertingNoteToTask &&
			Object.keys(result.changes).length === 0
		) {
			result.changes.dateModified = getCurrentTimestamp();
		}

		return result.changes;
	}

	protected async openTaskNote(): Promise<void> {
		try {
			// Get the file from the task path
			const file = this.app.vault.getAbstractFileByPath(this.task.path);

			if (!(file instanceof TFile)) {
				new Notice(this.t("modals.taskEdit.notices.fileMissing", { path: this.task.path }));
				return;
			}

			// Open the file in a new leaf
			const leaf = this.app.workspace.getLeaf(true);
			await leaf.openFile(file);

			// Close the modal
			this.close();
		} catch (error) {
			tasknotesLogger.error("Failed to open task note:", {
				category: "persistence",
				operation: "open-task-note",
				error: error,
			});
			new Notice(this.t("modals.taskEdit.notices.openNoteFailure"));
		}
	}

	private async archiveTask(): Promise<void> {
		try {
			if (getHermesTaskIdentity(this.task)) {
				await this.archiveHermesTask();
				return;
			}

			const updatedTask = await this.plugin.taskService.toggleArchive(this.task);

			// Update the task reference
			this.task = updatedTask;

			// Notify parent component if callback exists
			if (this.options.onTaskUpdated) {
				this.options.onTaskUpdated(updatedTask);
			}

			// Show success message
			const actionKey = updatedTask.archived
				? "modals.taskEdit.archiveAction.archived"
				: "modals.taskEdit.archiveAction.unarchived";
			const actionText = this.t(actionKey);
			new Notice(this.t("modals.taskEdit.notices.archiveSuccess", { action: actionText }));

			// Close the modal
			this.close();
		} catch (error) {
			tasknotesLogger.error("Failed to archive task:", {
				category: "persistence",
				operation: "archive-task",
				error: error,
			});
			new Notice(this.t("modals.taskEdit.notices.archiveFailure"));
		}
	}

	private async archiveHermesTask(): Promise<void> {
		const identity = getHermesTaskIdentity(this.task);
		if (!identity) {
			new Notice("This task is missing a board or task ID.");
			return;
		}
		const api = new HermesKanbanApiClient();
		const nextStatus =
			this.task.archived || this.getHermesStatus() === "archived" ? "ready" : "archived";
		await api.updateTask(identity, { status: nextStatus });
		const detail = await api.getTask(identity);
		const updatedTask = await this.refreshHermesMirror(identity.board, detail);
		if (this.options.onTaskUpdated) {
			this.options.onTaskUpdated(updatedTask);
		}
		new Notice(nextStatus === "archived" ? "Task archived" : "Task restored");
		this.forceClose();
	}

	private async deleteTask(): Promise<void> {
		const confirmed = await showConfirmationModal(this.app, {
			title: this.t("modals.taskEdit.deleteConfirmation.title"),
			message: this.t("modals.taskEdit.deleteConfirmation.message", {
				title: this.task.title,
			}),
			confirmText: this.t("modals.taskEdit.deleteConfirmation.confirm"),
			cancelText: this.t("common.cancel"),
			isDestructive: true,
		});

		if (!confirmed) {
			return;
		}

		try {
			if (getHermesTaskIdentity(this.task)) {
				const identity = getHermesTaskIdentity(this.task);
				if (!identity) {
					new Notice("This task is missing a board or task ID.");
					return;
				}
				const api = new HermesKanbanApiClient();
				await api.deleteTask(identity);
			}
			await this.plugin.taskService.deleteTask(this.task);
			new Notice(this.t("modals.taskEdit.notices.deleteSuccess", { title: this.task.title }));
			this.forceClose();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			tasknotesLogger.error("Failed to delete task:", {
				category: "persistence",
				operation: "delete-task",
				error: error,
			});
			new Notice(this.t("modals.taskEdit.notices.deleteFailure", { message }));
		}
	}

	protected createActionButtons(container: HTMLElement): void {
		createTaskModalActionButtons(this.getActionButtonContext(), {
			container,
			leadingButtons: [
				{
					className: "tn-task-modal__open-note-button",
					text: this.t("modals.task.buttons.openNote"),
					onClick: () => {
						void this.openTaskNote();
					},
				},
				{
					className: "mod-warning tn-task-modal__archive-button",
					text: this.task.archived
						? this.t("modals.taskEdit.buttons.unarchive")
						: this.t("modals.taskEdit.buttons.archive"),
					onClick: () => {
						void this.archiveTask();
					},
				},
				{
					className: "mod-warning tn-task-modal__delete-button",
					text: this.t("contextMenus.task.delete"),
					onClick: () => {
						void this.deleteTask();
					},
				},
			],
			saveText: this.getPrimaryActionText(),
			onSave: () => this.handleSave(),
			onSaved: () => {
				this.forceClose();
			},
			onCancel: () => {
				this.close();
			},
		});
	}

	protected async initializeSubtasks(): Promise<void> {
		try {
			const taskFile = this.app.vault.getAbstractFileByPath(this.task.path);
			if (!(taskFile instanceof TFile)) return;

			const subtasks =
				await this.plugin.projectSubtasksService.getTasksLinkedToProject(taskFile);
			const sortedSubtasks = this.plugin.projectSubtasksService.sortTasks([...subtasks]);
			this.selectedSubtaskFiles = [];
			this.initialSubtaskFiles = [];

			for (const subtask of sortedSubtasks) {
				const subtaskFile = this.app.vault.getAbstractFileByPath(subtask.path);
				if (subtaskFile) {
					this.selectedSubtaskFiles.push(subtaskFile);
					this.initialSubtaskFiles.push(subtaskFile);
				}
			}
		} catch (error) {
			tasknotesLogger.error("Error initializing subtasks:", {
				category: "persistence",
				operation: "initializing-subtasks",
				error: error,
			});
		}
	}

	protected hasSubtaskChanges(): boolean {
		return hasTaskEditSubtaskChanges(this.initialSubtaskFiles, this.selectedSubtaskFiles);
	}

	protected async applySubtaskChanges(task: TaskInfo): Promise<void> {
		const currentTaskFile = this.app.vault.getAbstractFileByPath(task.path);
		if (!(currentTaskFile instanceof TFile)) return;

		const result = await applyTaskEditSubtaskChanges({
			parentTaskFile: currentTaskFile,
			selectedSubtaskFiles: this.selectedSubtaskFiles,
			initialSubtaskFiles: this.initialSubtaskFiles,
			getTaskInfo: (path) => this.plugin.cacheManager.getTaskInfo(path),
			buildProjectReference: (parentTaskFile, subtaskPath) =>
				this.buildProjectReference(parentTaskFile, subtaskPath),
			updateTaskProjects: (subtaskInfo, updatedProjects) =>
				this.plugin.updateTaskProperty(subtaskInfo, "projects", updatedProjects),
			onAddError: (error) => {
				tasknotesLogger.error("Failed to add subtask relation:", {
					category: "persistence",
					operation: "add-subtask-relation",
					error: error,
				});
			},
			onRemoveError: (error) => {
				tasknotesLogger.error("Failed to remove subtask relation:", {
					category: "persistence",
					operation: "remove-subtask-relation",
					error: error,
				});
			},
		});

		this.initialSubtaskFiles = result.nextInitialSubtaskFiles;
	}

	// Start expanded for edit modal - override parent property
	protected isExpanded = true;
}
