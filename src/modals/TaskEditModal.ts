/* eslint-disable @typescript-eslint/no-non-null-assertion -- Modal lifecycle initializes required controls before event handlers run. */
import { App, Menu, Modal, Notice, setIcon, setTooltip, Setting, TFile } from "obsidian";
import TaskNotesPlugin from "../main";
import { TaskModal } from "./TaskModal";
import { TaskDependency, TaskInfo } from "../types";
import { getCurrentTimestamp } from "../utils/dateUtils";
import { extractTaskInfo } from "../utils/helpers";
import { stringifyUnknown } from "../utils/stringUtils";
import { ConfirmationModal, showConfirmationModal } from "./ConfirmationModal";
import { createCompletionsCalendarSection } from "./taskEditCompletions";
import { BlockingUpdates } from "./taskEditChanges";
import { createTaskModalActionButtons } from "./taskModalActionButtons";
import type { TaskModalActionIconSpec } from "./taskModalActionBar";
import {
	showTaskModalReminderContextMenu,
	type TaskModalActionMenuContext,
} from "./taskModalActionMenus";
import { buildTaskEditChangesFromModalState } from "./taskEditChangeState";
import { buildTaskEditFormStateFromTask } from "./taskEditFormState";
import { applyTaskEditSubtaskChanges, hasTaskEditSubtaskChanges } from "./taskEditSubtasks";
import {
	HermesKanbanApiClient,
	getHermesTaskIdentity,
	type HermesTaskDetailResponse,
	type HermesTaskRecord,
} from "../hermes/hermesApiClient";
import {
	HERMES_DASHBOARD_START_COMMAND,
	HermesAvailabilityService,
	type HermesAvailabilityHealth,
	type HermesDashboardStartResult,
} from "../hermes/hermesAvailabilityService";
import {
	createOrUpdateHermesMirrorNote,
	hermesPriorityToTaskNotesPriority,
	hermesStatusToTaskNotesStatus,
} from "../hermes/hermesMirror";
import {
	buildHermesActivitySnapshot,
	HERMES_ACTIVITY_FIELD_KEYS,
	getHermesActivityFrontmatterStateFromTask,
	getHermesActivitySnapshotFromTask,
	hasHermesActivityFrontmatterPropertiesChanged,
	hasHermesActivityNotesChanged,
} from "../hermes/hermesActivityFrontmatter";
import { normalizeHermesAssignee } from "../hermes/hermesAssignee";
import {
	canonicalHermesBoardProjects,
	defaultHermesAssignees,
	defaultHermesBoards,
	splitHermesList,
	validateHermesAssigneeSelection,
	validateHermesBoardSelection,
} from "../hermes/hermesRouting";
import type { ModalFieldsConfigLike } from "./taskModalFieldConfig";
import { createTaskNotesLogger } from "../utils/tasknotesLogger";
import {
	parseHermesComment,
	type HermesCommentPresentationModel,
} from "../hermes/hermesCommentParser";
import { normalizeTaskModalTitleValue, resizeTaskModalTitleTextarea } from "./taskModalTitleInput";
import { createTaskCard } from "../ui/TaskCard";

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
	metadata?: Record<string, unknown>;
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
	variant?: "default" | "pinned" | "status";
	sourceId?: string;
	raw?: string;
	sortTimestamp?: string | number;
	statusLabel?: string;
	statusSummary?: string;
	statusVariant?: "success" | "warning" | "danger" | "muted";
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

interface HermesActivityDetailModalOptions {
	title: string;
	meta?: string;
	body?: string;
	details?: HermesActivityDetail[];
	actions?: HermesActivityAction[];
	raw?: string;
	onAction: (action: HermesActivityAction) => Promise<void>;
}

interface HermesActivityComponentVisibility {
	comments: boolean;
	runs: boolean;
	events: boolean;
	artifacts: boolean;
	changedFiles: boolean;
}

interface HermesActivityElements {
	activitySection: HTMLElement;
	threadList: HTMLElement;
	runStatusContainer: HTMLElement | null;
	availabilityContainer: HTMLElement | null;
	commentInput?: HTMLTextAreaElement;
	commentButtonRef: { el?: HTMLButtonElement };
	visibleComponents: HermesActivityComponentVisibility;
}

interface HermesActivityContainers {
	readOnlyContainer: HTMLElement;
	availabilityContainer: HTMLElement | null;
}

type HermesThreadEntry =
	| {
			type: "comment";
			comment: HermesCommentCard;
			timestampMs: number | null;
			sequence: number;
	  }
	| {
			type: "status";
			card: HermesActivityCard;
			timestampMs: number | null;
			sequence: number;
	  };

const HERMES_VISIBLE_THREAD_ENTRY_LIMIT = 5;
const HERMES_VISIBLE_ACTIVITY_DETAIL_LIMIT = 2;
const HERMES_VISIBLE_ACTIVITY_ACTION_LIMIT = 2;
const HERMES_AUTO_DECOMPOSER_AUTHOR = "auto-decomposer";
const ACTIVITY_MODAL_FIELD_IDS = new Set<string>(
	Object.values(HERMES_ACTIVITY_FIELD_KEYS)
);

class HermesActivityDetailModal extends Modal {
	constructor(app: App, private readonly options: HermesActivityDetailModalOptions) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("tasknotes-plugin");
		this.modalEl.addClass("tn-task-modal__hermes-activity-detail-modal");
		this.contentEl.empty();
		this.contentEl.addClass("tn-task-modal__hermes-activity-detail-modal-content");

		const headerEl = this.contentEl.createDiv({
			cls: "tn-task-modal__hermes-activity-detail-modal-header",
		});
		headerEl.createEl("h2", {
			cls: "tn-task-modal__hermes-activity-detail-modal-title",
			text: this.options.title,
		});
		if (this.options.meta) {
			headerEl.createDiv({
				cls: "tn-task-modal__hermes-activity-detail-modal-meta",
				text: this.options.meta,
			});
		}

		if (this.options.body) {
			this.contentEl.createDiv({
				cls: "tn-task-modal__hermes-activity-detail-modal-body",
				text: this.options.body,
			});
		}

		this.renderDetails();
		this.renderActions();
		this.renderRaw();
	}

	private renderDetails(): void {
		if (!this.options.details?.length) {
			return;
		}

		const sectionEl = this.contentEl.createDiv({
			cls: "tn-task-modal__hermes-activity-detail-modal-section",
		});
		sectionEl.createDiv({
			cls: "tn-task-modal__hermes-activity-detail-modal-section-title",
			text: "Details",
		});
		const detailsEl = sectionEl.createDiv({
			cls: "tn-task-modal__hermes-activity-details tn-task-modal__hermes-activity-detail-modal-details",
		});
		for (const detail of this.options.details) {
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

	private renderActions(): void {
		if (!this.options.actions?.length) {
			return;
		}

		const sectionEl = this.contentEl.createDiv({
			cls: "tn-task-modal__hermes-activity-detail-modal-section",
		});
		sectionEl.createDiv({
			cls: "tn-task-modal__hermes-activity-detail-modal-section-title",
			text: "Actions",
		});
		const actionsEl = sectionEl.createDiv({
			cls: "tn-task-modal__hermes-activity-actions tn-task-modal__hermes-artifact-list",
		});
		for (const action of this.options.actions) {
			const actionEl = actionsEl.createEl("button", {
				cls: "tn-task-modal__hermes-activity-action tn-task-modal__hermes-artifact-card",
				text: action.label,
				attr: { type: "button" },
			});
			actionEl.addEventListener("click", (event) => {
				event.preventDefault();
				void this.options.onAction(action);
			});
		}
	}

	private renderRaw(): void {
		if (!this.options.raw) {
			return;
		}

		let rawEl: HTMLElement | null = null;
		const buttonEl = this.contentEl.createEl("button", {
			cls: "tn-task-modal__hermes-raw-toggle",
			text: "View raw",
			attr: { type: "button", "aria-expanded": "false" },
		});
		buttonEl.addEventListener("click", (event) => {
			event.preventDefault();
			const expanded = buttonEl.getAttribute("aria-expanded") === "true";
			buttonEl.setAttribute("aria-expanded", String(!expanded));
			buttonEl.textContent = expanded ? "View raw" : "Hide raw";
			if (expanded) {
				rawEl?.remove();
				rawEl = null;
				return;
			}
			rawEl = this.contentEl.createEl("pre", {
				cls: "tn-task-modal__hermes-raw-payload",
				text: this.options.raw,
			});
		});
	}
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
		const metadata = isHermesEventRecord(record.metadata) ? record.metadata : undefined;
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
				metadata,
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

function hermesActivitySortTimestamp(timestamp: string | number | undefined): number | null {
	const date = parseHermesActivityDate(timestamp);
	return date ? date.getTime() : null;
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
	const kindLabel = formatHermesStatusEventLabel(event.kind);
	const payload = normalizeHermesEventPayload(event.payload);
	const details: HermesActivityDetail[] = [];
	const actions = extractHermesEventActions(payload);
	const body = formatHermesEventPayloadBody(payload);
	let fullTitle = kindLabel;
	let statusSummary = "";

	if (isHermesEventRecord(payload)) {
		const primary = HERMES_EVENT_PRIMARY_FIELDS.find((key) => {
			const value = payload[key];
			return !isEmptyHermesEventPayloadValue(value);
		});
		if (primary) {
			statusSummary = summarizeHermesEventPayloadValue(payload[primary], primary, 140);
			fullTitle = `${kindLabel}: ${statusSummary}`;
		}

		for (const key of orderHermesEventPayloadKeys(payload)) {
			if (key === primary || key === "run_id" || details.length >= 5) {
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
		statusSummary = summarizeHermesEventPayloadValue(payload, "payload", 140);
		fullTitle = `${kindLabel}: ${statusSummary}`;
	}

	return {
		title: compactHermesActivityText(fullTitle, 180),
		fullTitle,
		details: details.length > 0 ? details : undefined,
		actions: actions.length > 0 ? actions : undefined,
		body: body || undefined,
		meta: formatHermesActivityTimestamp(event.createdAt),
		sortTimestamp: event.createdAt,
		statusLabel: kindLabel,
		statusSummary,
		statusVariant: hermesEventStatusVariant(event.kind, payload),
	};
}

function hermesEventStatusVariant(
	kind: string,
	payload: unknown
): "success" | "warning" | "danger" | "muted" {
	const normalizedKind = kind.toLowerCase();
	if (/fail|error|crash|timed/.test(normalizedKind)) return "danger";
	if (/block|review|required|warning/.test(normalizedKind)) return "warning";
	if (/accepted|complete|completed|done|success|verified/.test(normalizedKind)) {
		return "success";
	}

	const statusText = [
		isHermesEventRecord(payload)
			? HERMES_EVENT_PRIMARY_FIELDS.map((key) => hermesActivityText(payload[key])).join(" ")
			: hermesActivityText(payload),
	]
		.join(" ")
		.toLowerCase();
	if (/fail|error|crash|timed/.test(statusText)) return "danger";
	if (/block|review|required|warning/.test(statusText)) return "warning";
	if (/accepted|complete|completed|done|success|verified/.test(statusText)) return "success";
	return "muted";
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

function formatHermesStatusEventLabel(kind: string): string {
	const normalized = kind.replace(/[_-]+/g, " ").trim().toLowerCase();
	const withoutRunPrefix = normalized.replace(/^run\s+/, "");
	return formatHermesEventKind(withoutRunPrefix || normalized || kind);
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

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
	if (left.length !== right.length) {
		return false;
	}
	return left.every((value, index) => value === right[index]);
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
	private hermesBoardOptions: string[] | null = null;
	private hermesAssigneeOptions: string[] | null = null;
	private hermesAvailabilityHealth: HermesAvailabilityHealth | null = null;
	private hermesActivityElements: HermesActivityElements | null = null;
	private hermesLiveEditHandlersAttached = false;
	private hermesLiveSaveTimer: number | null = null;
	private hermesLiveSaveChain: Promise<boolean> = Promise.resolve(false);

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

	protected createFieldsFromConfig(container: HTMLElement, config: ModalFieldsConfigLike): void {
		super.createFieldsFromConfig(container, this.getFieldConfigWithoutActivityFields(config));
	}

	private getFieldConfigWithoutActivityFields(
		config: ModalFieldsConfigLike
	): ModalFieldsConfigLike {
		return {
			...config,
			fields: config.fields?.filter((field) => !ACTIVITY_MODAL_FIELD_IDS.has(field.id)),
		};
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
		const hermesIdentity = getHermesTaskIdentity(this.task);
		if (hermesIdentity) {
			this.projects = canonicalHermesBoardProjects(hermesIdentity.board);
			this.initializeProjectsFromStrings([this.projects]);
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

	protected getActionMenuContext(): TaskModalActionMenuContext {
		const context = super.getActionMenuContext();
		if (!getHermesTaskIdentity(this.task)) {
			return context;
		}

		return {
			...context,
			onChange: () => {
				context.onChange();
				this.scheduleHermesLiveSave(0);
			},
		};
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
					if (getHermesTaskIdentity(this.task)) {
						await this.flushHermesLiveSave({ showSuccessNotice: true });
						return;
					}
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

	protected createModalContent(): void {
		super.createModalContent();
		this.attachHermesLiveEditHandlers();
	}

	protected createContextsField(container: HTMLElement): void {
		const identity = getHermesTaskIdentity(this.task);
		if (!identity) {
			super.createContextsField(container);
			return;
		}
	}

	protected createProjectsField(container: HTMLElement): void {
		const identity = getHermesTaskIdentity(this.task);
		if (!identity) {
			super.createProjectsField(container);
			return;
		}
	}

	private attachHermesLiveEditHandlers(): void {
		if (this.hermesLiveEditHandlersAttached || !getHermesTaskIdentity(this.task)) {
			return;
		}

		this.hermesLiveEditHandlersAttached = true;
		const titleInput = this.titleInput;
		titleInput?.addEventListener("input", () => {
			this.title = normalizeTaskModalTitleValue(titleInput.value);
			this.scheduleHermesLiveSave();
		});

		const scheduleDependencySave = (event: MouseEvent) => {
			const target = event.target instanceof Element ? event.target : null;
			if (target?.closest(".task-project-remove")) {
				this.scheduleHermesLiveSave(0);
			}
		};
		this.blockedByList?.addEventListener("click", scheduleDependencySave, { capture: true });
		this.blockingList?.addEventListener("click", scheduleDependencySave, { capture: true });
	}

	protected addBlockedByDependency(dependency: TaskDependency): void {
		const beforeCount = this.blockedByItems.length;
		super.addBlockedByDependency(dependency);
		if (getHermesTaskIdentity(this.task) && this.blockedByItems.length !== beforeCount) {
			this.scheduleHermesLiveSave(0);
		}
	}

	protected addBlockingTaskFromPath(path: string): void {
		const beforeCount = this.blockingItems.length;
		super.addBlockingTaskFromPath(path);
		if (getHermesTaskIdentity(this.task) && this.blockingItems.length !== beforeCount) {
			this.scheduleHermesLiveSave(0);
		}
	}

	protected getCoreActionIconSpecs(): TaskModalActionIconSpec[] {
		const specs = super.getCoreActionIconSpecs();
		if (!getHermesTaskIdentity(this.task)) {
			return specs;
		}

		return [
			{
				iconName: "columns-3",
				tooltip: this.getHermesBoardTooltip(),
				onClick: (_, event) => {
					void this.showHermesBoardContextMenu(event);
				},
				dataType: "hermes-board",
			},
			{
				iconName: "user",
				tooltip: this.getHermesAssigneeTooltip(),
				onClick: (_, event) => {
					void this.showHermesAssigneeContextMenu(event);
				},
				dataType: "hermes-assignee",
			},
			...specs,
		];
	}

	private getHermesBoardTooltip(): string {
		const identity = getHermesTaskIdentity(this.task);
		return identity ? `Board: ${identity.board}` : "Board";
	}

	private getHermesAssigneeTooltip(): string {
		const assignee = normalizeHermesAssignee(this.contexts);
		return assignee ? `Assignee: ${assignee}` : "Assignee: Unassigned";
	}

	private async showHermesBoardContextMenu(event: UIEvent): Promise<void> {
		const identity = getHermesTaskIdentity(this.task);
		if (!identity) {
			return;
		}

		const boards = uniqueNonEmpty([identity.board, ...(await this.resolveHermesBoardOptions())]);
		const menu = new Menu();
		for (const board of boards) {
			menu.addItem((item) => {
				const isSelected = board === identity.board;
				item.setTitle(isSelected ? `Board/${board}` : `Board/${board} (move unavailable)`);
				item.setIcon(isSelected ? "check" : "columns-3");
				item.setChecked(isSelected);
				if (!isSelected) {
					item.setDisabled(true);
				}
			});
		}

		this.showMenuForEvent(menu, event);
	}

	private async showHermesAssigneeContextMenu(event: UIEvent): Promise<void> {
		const identity = getHermesTaskIdentity(this.task);
		if (!identity) {
			return;
		}

		const currentAssignee = normalizeHermesAssignee(this.contexts);
		const assignees = uniqueNonEmpty([
			...(currentAssignee ? [currentAssignee] : []),
			...(await this.resolveHermesAssigneeOptions(identity.board)),
		]);
		const menu = new Menu();
		menu.addItem((item) => {
			const isSelected = !currentAssignee;
			item.setTitle("Unassigned");
			item.setIcon(isSelected ? "check" : "user-x");
			item.setChecked(isSelected);
			item.onClick(() => {
				this.setHermesAssignee("");
			});
		});
		for (const assignee of assignees) {
			menu.addItem((item) => {
				const isSelected = assignee === currentAssignee;
				item.setTitle(assignee);
				item.setIcon(isSelected ? "check" : "user");
				item.setChecked(isSelected);
				item.onClick(() => {
					this.setHermesAssignee(assignee);
				});
			});
		}

		this.showMenuForEvent(menu, event);
	}

	private setHermesAssignee(assignee: string): void {
		this.contexts = assignee;
		if (this.contextsInput) {
			this.contextsInput.value = assignee;
		}
		this.updateIconStates();
		this.scheduleHermesLiveSave(0);
	}

	private scheduleHermesLiveSave(delayMs = 650): void {
		if (!getHermesTaskIdentity(this.task)) {
			return;
		}

		if (this.hermesLiveSaveTimer) {
			window.clearTimeout(this.hermesLiveSaveTimer);
		}
		this.hermesLiveSaveTimer = window.setTimeout(() => {
			this.hermesLiveSaveTimer = null;
			void this.flushHermesLiveSave();
		}, delayMs);
	}

	private async flushHermesLiveSave(
		options: { showSuccessNotice?: boolean } = {}
	): Promise<boolean> {
		if (!getHermesTaskIdentity(this.task)) {
			return false;
		}

		if (this.hermesLiveSaveTimer) {
			window.clearTimeout(this.hermesLiveSaveTimer);
			this.hermesLiveSaveTimer = null;
		}

		const saveRun = this.hermesLiveSaveChain
			.catch(() => false)
			.then(() => this.saveHermesLiveChanges(options));
		this.hermesLiveSaveChain = saveRun;
		return saveRun;
	}

	private async saveHermesLiveChanges(
		options: { showSuccessNotice?: boolean } = {}
	): Promise<boolean> {
		if (!this.validateForm()) {
			new Notice(this.t("modals.taskEdit.notices.titleRequired"));
			return false;
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
				return false;
			}

			return await this.handleHermesSave(changes, hasBlockingChanges, hasSubtaskChanges, {
				showSuccessNotice: options.showSuccessNotice === true,
			});
		} catch (error) {
			tasknotesLogger.error("Failed to update Hermes task from live modal:", {
				category: "validation",
				operation: "hermes-live-update-task",
				error,
			});
			const message = error instanceof Error && error.message ? error.message : String(error);
			new Notice(this.t("modals.taskEdit.notices.updateFailure", { message }));
			return false;
		}
	}

	private showMenuForEvent(menu: Menu, event: UIEvent): void {
		if (event.instanceOf(MouseEvent)) {
			menu.showAtMouseEvent(event);
			return;
		}

		const target =
			event.currentTarget instanceof HTMLElement
				? event.currentTarget
				: event.target instanceof HTMLElement
					? event.target
					: null;
		const rect = target?.getBoundingClientRect();
		menu.showAtPosition({
			x: rect?.left ?? window.innerWidth / 2,
			y: rect ? rect.bottom + 4 : window.innerHeight / 2,
		});
	}

	protected updateIconStates(): void {
		super.updateIconStates();

		const identity = getHermesTaskIdentity(this.task);
		this.updateHermesRoutingIconState(
			"hermes-board",
			this.getHermesBoardTooltip(),
			Boolean(identity)
		);
		this.updateHermesRoutingIconState(
			"hermes-assignee",
			this.getHermesAssigneeTooltip(),
			Boolean(normalizeHermesAssignee(this.contexts))
		);
	}

	private updateHermesRoutingIconState(
		dataType: string,
		tooltip: string,
		hasValue: boolean
	): void {
		const icon = this.actionBar?.querySelector<HTMLElement>(`[data-type="${dataType}"]`);
		if (!icon) {
			return;
		}

		icon.classList.toggle("has-value", hasValue);
		icon.setAttribute("aria-label", tooltip);
		icon.setAttribute("data-initial-tooltip", tooltip);
		setTooltip(icon, tooltip, { placement: "top" });
	}

	/**
	 * Add completions calendar and metadata sections after details
	 */
	protected createAdditionalSections(container: HTMLElement): void {
		const visibleComponents = this.getHermesActivityComponentVisibility(this.getModalFieldsConfig());
		if (this.hasVisibleHermesActivityComponents(visibleComponents)) {
			this.createHermesActivitySections(
				{
					readOnlyContainer: this.getHermesReadOnlyActivityContainer(container),
					availabilityContainer: null,
				},
				visibleComponents
			);
		}
		createCompletionsCalendarSection(container, {
			task: this.task,
			plugin: this.plugin,
			completedInstancesChanges: this.completedInstancesChanges,
			translate: (key, params) => this.t(key, params),
		});
	}

	private getHermesActivityComponentVisibility(
		config: ModalFieldsConfigLike | undefined
	): HermesActivityComponentVisibility {
		return {
			comments: this.shouldShowHermesActivityField(HERMES_ACTIVITY_FIELD_KEYS.comments, config),
			runs: this.shouldShowHermesActivityField(HERMES_ACTIVITY_FIELD_KEYS.runs, config),
			events: this.shouldShowHermesActivityField(HERMES_ACTIVITY_FIELD_KEYS.events, config),
			artifacts: this.shouldShowHermesActivityField(HERMES_ACTIVITY_FIELD_KEYS.artifacts, config),
			changedFiles: this.shouldShowHermesActivityField(
				HERMES_ACTIVITY_FIELD_KEYS.changedFiles,
				config
			),
		};
	}

	private shouldShowHermesActivityField(
		fieldId: string,
		config: ModalFieldsConfigLike | undefined
	): boolean {
		if (!config?.fields) {
			return true;
		}
		const field = config?.fields?.find((candidate) => candidate.id === fieldId);
		if (!field) {
			return true;
		}
		return field.enabled !== false && field.visibleInEdit !== false;
	}

	private hasVisibleHermesActivityComponents(
		visibleComponents: HermesActivityComponentVisibility
	): boolean {
		return Object.values(visibleComponents).some(Boolean);
	}

	private createHermesAvailabilitySnapshot(
		container: HTMLElement,
		elements?: HermesActivityElements
	): HTMLElement | null {
		if (!getHermesTaskIdentity(this.task)) {
			return null;
		}
		const section = container.createDiv({
			cls: "tn-task-modal__hermes-availability tn-task-modal__hermes-availability--starting",
		});
		section.setAttribute("role", "status");
		section.setAttribute("aria-live", "polite");
		if (elements) {
			elements.availabilityContainer = section;
		}
		this.renderHermesAvailabilitySnapshot(
			section,
			this.hermesAvailabilityHealth ?? this.getInitialHermesAvailabilityHealth(),
			elements
		);
		return section;
	}

	private getInitialHermesAvailabilityHealth(): HermesAvailabilityHealth {
		return {
			status: "starting",
			mode: "cache-only",
			rootUrl: "http://127.0.0.1:9119/",
			apiUrl: "http://127.0.0.1:9119/api/plugins/kanban",
			canStart: false,
			message: "Checking Hermes availability...",
		};
	}

	private getHermesReadOnlyActivityContainer(fallbackContainer: HTMLElement): HTMLElement {
		if (!this.splitRightColumn) {
			return this.detailsContainer ?? fallbackContainer;
		}

		this.splitRightColumn.addClass("modal-split-right--with-readonly");
		this.splitContentWrapper?.removeClass("modal-split-content--right-empty");
		return this.splitRightColumn;
	}

	private createHermesActivitySections(
		containers: HermesActivityContainers,
		visibleComponents: HermesActivityComponentVisibility
	): void {
		if (!getHermesTaskIdentity(this.task)) {
			return;
		}

		const { readOnlyContainer } = containers;
		const commentButtonRef: { el?: HTMLButtonElement } = {};

		const activitySection = this.createHermesActivitySection(
			readOnlyContainer,
			"Activity",
			["tn-task-modal__hermes-review-thread"]
		);

		const runStatusContainer = visibleComponents.runs
			? activitySection.createDiv({
					cls: "tn-task-modal__hermes-run-status-strip",
				})
			: null;
		const threadList = activitySection.createDiv({
			cls: "task-projects-list tn-task-modal__hermes-comment-list tn-task-modal__hermes-thread-list",
		});
		this.renderHermesFallbackThread(threadList, visibleComponents);

		let commentInput: HTMLTextAreaElement | undefined;
		if (visibleComponents.comments) {
			const composer = activitySection.createDiv({
				cls: "tn-task-modal__hermes-composer",
			});
			commentInput = composer.createEl("textarea", {
				cls: "tn-task-modal__hermes-comment-input title-input-detailed",
				attr: {
					placeholder: "Add a review comment... (Enter to submit, Shift+Enter for newline)",
					rows: "2",
				},
			});
			commentInput.spellcheck = true;
			commentInput.setAttribute("aria-label", "Add a review comment");
			const commentButton = composer.createEl("button", {
				cls: "tn-task-modal__hermes-send-button tn-btn tn-btn--primary",
				text: "Send",
				attr: {
					type: "button",
					"aria-label": "Send comment",
				},
			});
			commentButtonRef.el = commentButton;
			const updateCommentButtonState = () => {
				const commentButtonEl = commentButtonRef.el;
				if (commentButtonEl && commentInput) {
					commentButtonEl.disabled =
						!this.isHermesLiveAvailability() || commentInput.value.trim().length === 0;
				}
			};
			updateCommentButtonState();
			commentInput.addEventListener("input", () => {
				updateCommentButtonState();
				if (commentInput) {
					resizeTaskModalTitleTextarea(commentInput);
				}
			});
			commentInput.addEventListener("keydown", (event) => {
				if (event.key !== "Enter" || event.shiftKey || event.metaKey || event.ctrlKey) {
					return;
				}
				event.preventDefault();
				if (commentInput) {
					void this.handleHermesCommentSubmit(commentInput, commentButtonRef.el ?? null);
				}
			});
			commentButton.addEventListener("click", () => {
				if (commentInput) {
					void this.handleHermesCommentSubmit(commentInput, commentButtonRef.el ?? null);
				}
			});
		}

		const activityElements: HermesActivityElements = {
			activitySection,
			threadList,
			runStatusContainer,
			availabilityContainer: containers.availabilityContainer,
			commentInput,
			commentButtonRef,
			visibleComponents,
		};
		this.hermesActivityElements = activityElements;
		void this.loadHermesActivityCards(activityElements);
		void this.refreshHermesAvailabilityForActivity(activityElements);
	}

	private renderHermesFallbackThread(
		threadList: HTMLElement,
		visibleComponents: HermesActivityComponentVisibility
	): void {
		threadList.empty();
		const cachedDetail = this.getCachedHermesActivityDetail();
		if (cachedDetail) {
			this.renderHermesReviewThread(
				threadList,
				visibleComponents.comments ? normalizeHermesComments(cachedDetail.comments ?? []) : [],
				cachedDetail,
				visibleComponents.runs ? normalizeHermesRuns(cachedDetail.runs ?? []) : [],
				this.buildHermesStatusUpdateCards(cachedDetail, visibleComponents),
				visibleComponents
			);
			return;
		}

		const fallbackEntries = this.sortHermesThreadEntries(
			this.buildHermesThreadEntries(
				visibleComponents.comments ? this.getFallbackHermesCommentsFromTaskDetails() : [],
				visibleComponents.events ? this.getFallbackHermesEventCardsFromTaskDetails() : []
			)
		);
		this.renderHermesThreadEntries(threadList, fallbackEntries, visibleComponents);
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
		(setting as unknown as { nameEl?: HTMLElement }).nameEl?.addClass(
			"tn-task-modal__hermes-activity-heading"
		);
		configure?.(setting);
	}

	private async refreshHermesAvailabilityForActivity(elements: HermesActivityElements): Promise<void> {
		const health = await this.recheckHermesAvailability();
		this.renderHermesAvailabilitySnapshot(elements.availabilityContainer, health, elements);
		this.applyHermesAvailabilityToActivity(elements, health);
		if (health.status === "connected") {
			await this.refreshHermesLiveOptions();
			await this.loadHermesActivityCards(elements);
		}
	}

	public async recheckHermesAvailability(): Promise<HermesAvailabilityHealth> {
		const health = await this.getHermesAvailabilityService().recheckHealth();
		this.hermesAvailabilityHealth = health;
		return health;
	}

	public async startHermesDashboardAndRefreshActivity(
		elements?: HermesActivityElements
	): Promise<HermesDashboardStartResult> {
		const result = await this.plugin.startHermesDashboard({ showNotice: false });
		this.hermesAvailabilityHealth = result.health;
		if (elements) {
			this.renderHermesAvailabilitySnapshot(elements.availabilityContainer, result.health, elements, result);
			this.applyHermesAvailabilityToActivity(elements, result.health);
		}
		const health = await this.recheckHermesAvailability();
		if (elements) {
			this.renderHermesAvailabilitySnapshot(elements.availabilityContainer, health, elements, result);
			this.applyHermesAvailabilityToActivity(elements, health);
		}
		if (health.status === "connected") {
			await this.refreshHermesLiveOptions();
			if (elements) {
				await this.loadHermesActivityCards(elements);
			}
		}
		return { ...result, health };
	}

	private async refreshHermesLiveOptions(): Promise<void> {
		const identity = getHermesTaskIdentity(this.task);
		const options = await this.getHermesAvailabilityService().getOptions(identity?.board);
		if (options.boards.length > 0) {
			this.hermesBoardOptions = uniqueNonEmpty(options.boards);
		}
		if (options.assignees.length > 0) {
			this.hermesAssigneeOptions = uniqueNonEmpty(options.assignees);
		}
	}

	private getHermesAvailabilityService(): HermesAvailabilityService {
		return new HermesAvailabilityService();
	}

	private renderHermesAvailabilitySnapshot(
		container: HTMLElement | null,
		health: HermesAvailabilityHealth,
		elements?: HermesActivityElements,
		startResult?: HermesDashboardStartResult
	): void {
		if (!container) return;
		container.empty();
		container.className = `tn-task-modal__hermes-availability tn-task-modal__hermes-availability--${health.status}`;
		const copy = this.hermesAvailabilityCopy(health, startResult);
		const badge = this.hermesAvailabilityBadge(health);
		const title = this.hermesAvailabilityTitle(health);
		const tooltip = [
			`${badge}: ${title}`,
			copy,
			health.warning,
			health.mode !== "live" ? `Manual start: ${this.getHermesStartCommand()}` : "",
		]
			.filter(Boolean)
			.join("\n");
		container.setAttribute("title", tooltip);
		container.setAttribute("aria-label", `${badge}: ${title}`);
		const chipEl = container.createDiv({ cls: "tn-task-modal__hermes-availability-chip" });
		chipEl.createSpan({ cls: "tn-task-modal__hermes-availability-dot" });
		chipEl.createSpan({ cls: "tn-task-modal__hermes-availability-kicker", text: badge });
		chipEl.createSpan({ cls: "tn-task-modal__hermes-availability-title", text: title });
		if (health.mode !== "live") {
			chipEl.createSpan({ cls: "tn-task-modal__hermes-availability-mode", text: health.mode });
		}
		const actionsEl = container.createDiv({ cls: "tn-task-modal__hermes-availability-actions" });
		if (health.status === "disconnected" && health.canStart) {
			const startButton = actionsEl.createEl("button", {
				cls: "tn-btn tn-btn--primary",
				text: "Start",
				attr: { type: "button", "aria-label": ["Start", "Hermes", "dashboard"].join(" ") },
			});
			startButton.addEventListener("click", () => {
				void this.handleHermesStartClick(elements, startButton);
			});
		}
		const recheckButton = actionsEl.createEl("button", {
			cls: "tn-btn tn-btn--ghost",
			text: "Recheck",
			attr: { type: "button", "aria-label": ["Recheck", "Hermes", "availability"].join(" ") },
		});
		recheckButton.addEventListener("click", () => {
			if (elements) {
				void this.refreshHermesAvailabilityForActivity(elements);
			}
		});
	}

	private async handleHermesStartClick(
		elements: HermesActivityElements | undefined,
		button: HTMLButtonElement
	): Promise<void> {
		button.disabled = true;
		if (elements?.availabilityContainer) {
			this.renderHermesAvailabilitySnapshot(elements.availabilityContainer, {
				...(this.hermesAvailabilityHealth ?? {
					rootUrl: "http://127.0.0.1:9119/",
					apiUrl: "http://127.0.0.1:9119/api/plugins/kanban",
					canStart: true,
				}),
				status: "starting",
				mode: "cache-only",
				message: "Starting Hermes dashboard...",
			}, elements);
		}
		await this.startHermesDashboardAndRefreshActivity(elements);
	}

	private applyHermesAvailabilityToActivity(
		elements: HermesActivityElements,
		health: HermesAvailabilityHealth
	): void {
		const live = health.status === "connected" && health.mode === "live";
		if (elements.commentInput) {
			elements.commentInput.disabled = !live;
			elements.commentInput.placeholder = live
				? "Add a review comment... (Enter to submit, Shift+Enter for newline)"
				: "Hermes is disconnected; comments are cache-only until reconnected.";
		}
		const commentButton = elements.commentButtonRef.el;
		if (commentButton && elements.commentInput) {
			commentButton.disabled = !live || elements.commentInput.value.trim().length === 0;
			commentButton.title = live ? "Send comment" : "Hermes is disconnected";
		}
		this.setHermesActivityHeaderLabel(
			elements.activitySection,
			live ? "Activity" : "Activity (cache-only)"
		);
		if (elements.runStatusContainer) {
			elements.runStatusContainer.empty();
			elements.runStatusContainer.createSpan({
				cls: `tn-task-modal__hermes-run-chip tn-task-modal__hermes-run-chip--${live ? "success" : "warning"}`,
				text: live ? "Live Hermes activity" : "Cached Hermes activity",
			});
		}
	}

	private setHermesActivityHeaderLabel(section: HTMLElement, label: string): void {
		const labelEl =
			section.querySelector<HTMLElement>(".tn-task-modal__hermes-activity-heading") ??
			section.firstElementChild?.firstElementChild;
		if (labelEl instanceof HTMLElement) {
			labelEl.textContent = label;
		}
	}

	private isHermesLiveAvailability(): boolean {
		return this.hermesAvailabilityHealth?.status === "connected" && this.hermesAvailabilityHealth.mode === "live";
	}

	private async ensureHermesLiveForAction(): Promise<boolean> {
		const health = this.hermesAvailabilityHealth ?? (await this.recheckHermesAvailability());
		if (health.status === "connected" && health.mode === "live") {
			return true;
		}
		new Notice(
			`Hermes is ${this.hermesAvailabilityTitle(health).toLowerCase()}; live controls are disabled. Run ${this.getHermesStartCommand()}, then recheck.`
		);
		return false;
	}

	private getHermesStartCommand(): string {
		return this.plugin.getHermesDashboardStartCommand?.() ?? HERMES_DASHBOARD_START_COMMAND;
	}

	private hermesAvailabilityBadge(health: HermesAvailabilityHealth): string {
		if (health.status === "connected") return "Hermes live";
		if (health.status === "degraded") return "Hermes degraded";
		if (health.status === "starting") return "Hermes starting";
		return health.mode === "read-only" ? "Hermes read-only" : "Cache only";
	}

	private hermesAvailabilityTitle(health: HermesAvailabilityHealth): string {
		if (health.status === "connected") return "Connected";
		if (health.status === "degraded") return "Degraded";
		if (health.status === "starting") return "Starting";
		return health.mode === "read-only" ? "Disconnected - read-only" : "Disconnected";
	}

	private hermesAvailabilityCopy(
		health: HermesAvailabilityHealth,
		startResult?: HermesDashboardStartResult
	): string {
		if (startResult?.error) {
			return `${startResult.error.message} ${startResult.error.action}`;
		}
		if (health.message) return health.message;
		if (health.status === "connected") return `Live board, profile, status, and comment controls are enabled from ${health.apiUrl}.`;
		if (health.status === "degraded") return "Hermes is reachable but live Kanban data is degraded; cached mirror values are shown.";
		if (health.status === "starting") return "Starting Hermes; use Recheck when the dashboard is ready.";
		return "Hermes API is disconnected; live board, profile, status, and comment controls are disabled.";
	}

	private async loadHermesActivityCards(elements: HermesActivityElements): Promise<void> {
		const identity = getHermesTaskIdentity(this.task);
		if (!identity) {
			return;
		}

		try {
			const detail = await new HermesKanbanApiClient().getTask(identity);
			this.renderHermesActivityDetail(elements, detail);
			if (detail.task && this.shouldSyncHermesDetailToTaskFrontmatter(identity.board, detail)) {
				void this.refreshHermesMirror(identity.board, detail).catch((error) => {
					tasknotesLogger.warn("Loaded Hermes activity but failed to sync task frontmatter:", {
						category: "persistence",
						operation: "sync-hermes-activity-frontmatter",
						error,
					});
				});
			}
		} catch (error) {
			tasknotesLogger.warn("Failed to load Hermes activity:", {
				category: "provider",
				operation: "load-hermes-activity",
				error,
			});
		}
	}

	private getCachedHermesActivityDetail(): HermesTaskDetailResponse | null {
		const snapshot = getHermesActivitySnapshotFromTask(this.plugin, this.task);
		if (!snapshot) {
			return null;
		}
		return {
			task: null,
			comments: snapshot.comments,
			runs: snapshot.runs,
			events: snapshot.events,
		};
	}

	private shouldSyncHermesDetailToTaskFrontmatter(
		board: string,
		detail: HermesTaskDetailResponse
	): boolean {
		if (!detail.task) {
			return false;
		}
		const existingActivity = getHermesActivitySnapshotFromTask(this.plugin, this.task);
		const existingActivityFrontmatter = getHermesActivityFrontmatterStateFromTask(
			this.plugin,
			this.task
		);
		const nextActivity = buildHermesActivitySnapshot(detail, { existing: existingActivity });
		return (
			this.hasHermesTaskRecordChanged(board, detail.task) ||
			hasHermesActivityFrontmatterPropertiesChanged(existingActivityFrontmatter, nextActivity, {
				board,
				taskId: detail.task.id,
			}) ||
			hasHermesActivityNotesChanged(this.plugin, nextActivity, {
				board,
				taskId: detail.task.id,
			})
		);
	}

	private hasHermesTaskRecordChanged(board: string, record: HermesTaskRecord): boolean {
		if (this.task.title !== record.title) {
			return true;
		}
		if (this.task.status !== hermesStatusToTaskNotesStatus(record.status)) {
			return true;
		}
		if (this.task.priority !== hermesPriorityToTaskNotesPriority(record.priority)) {
			return true;
		}
		const assignee = record.assignee?.trim();
		const contexts = assignee && assignee !== "none" ? [assignee] : [];
		if (!sameStringList(this.task.contexts ?? [], contexts)) {
			return true;
		}
		if (!sameStringList(this.task.projects ?? [], [`Hermes/${board}`])) {
			return true;
		}
		const hasArchivedTag = (this.task.tags ?? []).includes("archived");
		return (record.status === "archived") !== hasArchivedTag;
	}

	private renderHermesActivityDetail(
		elements: HermesActivityElements,
		detail: HermesTaskDetailResponse
	): void {
		const { visibleComponents } = elements;
		const comments = visibleComponents.comments ? normalizeHermesComments(detail.comments ?? []) : [];
		const runs = visibleComponents.runs ? normalizeHermesRuns(detail.runs ?? []) : [];
		if (elements.runStatusContainer && visibleComponents.runs) {
			this.renderHermesRunStatusStrip(elements.runStatusContainer, runs);
		}
		this.renderHermesReviewThread(
			elements.threadList,
			comments,
			detail,
			runs,
			this.buildHermesStatusUpdateCards(detail, visibleComponents),
			visibleComponents
		);
	}

	private renderHermesRunStatusStrip(container: HTMLElement, runs: HermesRunCard[]): void {
		container.empty();
		const latestRun = runs.length > 0 ? runs[runs.length - 1] : undefined;
		if (!latestRun) {
			return;
		}
		const state = this.hermesRunStateLabel(latestRun);
		container.createSpan({
			cls: `tn-task-modal__hermes-run-chip tn-task-modal__hermes-run-chip--${state.variant}`,
			text: state.label,
		});
		container.createSpan({
			cls: "tn-task-modal__hermes-run-chip",
			text: this.hermesVerificationLabel(latestRun),
		});
		container.createSpan({
			cls: "tn-task-modal__hermes-run-chip tn-task-modal__hermes-run-chip--muted",
			text: [latestRun.id ? `Run ${latestRun.id}` : "Run", latestRun.profile, formatHermesActivityTimestamp(latestRun.endedAt ?? latestRun.startedAt)]
				.filter(Boolean)
				.join(" · "),
		});
	}

	private renderHermesReviewThread(
		listEl: HTMLElement,
		comments: HermesCommentCard[],
		detail: HermesTaskDetailResponse,
		runs: HermesRunCard[],
		statusCards: HermesActivityCard[],
		visibleComponents: HermesActivityComponentVisibility
	): void {
		listEl.empty();
		const pinned = this.buildPinnedHermesReviewCard(comments, detail, runs);
		if (pinned) {
			this.renderHermesActivityCardItem(listEl, pinned, visibleComponents);
		}
		const entries = this.sortHermesThreadEntries(
			this.buildHermesThreadEntries(comments, statusCards, pinned?.sourceId)
		);
		this.renderHermesThreadEntries(listEl, entries, visibleComponents);
		if (!pinned && entries.length === 0) {
			listEl.createDiv({
				cls: "tn-task-modal__hermes-empty-state",
				text: "No activity yet.",
			});
		}
	}

	private buildHermesThreadEntries(
		comments: HermesCommentCard[],
		statusCards: HermesActivityCard[],
		excludeCommentId?: string
	): HermesThreadEntry[] {
		const entries: HermesThreadEntry[] = [];
		const visibleComments = excludeCommentId
			? comments.filter((comment) => (comment.id ?? comment.body) !== excludeCommentId)
			: comments;
		for (const [index, comment] of visibleComments.entries()) {
			entries.push({
				type: "comment",
				comment,
				timestampMs: hermesActivitySortTimestamp(comment.createdAt),
				sequence: index,
			});
		}

		const statusSequenceOffset = visibleComments.length;
		for (const [index, card] of statusCards.entries()) {
			entries.push({
				type: "status",
				card: {
					...card,
					variant: card.variant ?? "status",
				},
				timestampMs: hermesActivitySortTimestamp(card.sortTimestamp),
				sequence: statusSequenceOffset + index,
			});
		}
		return entries;
	}

	private sortHermesThreadEntries(entries: HermesThreadEntry[]): HermesThreadEntry[] {
		return [...entries].sort((a, b) => {
			const aTime = a.timestampMs ?? Number.NEGATIVE_INFINITY;
			const bTime = b.timestampMs ?? Number.NEGATIVE_INFINITY;
			if (aTime !== bTime) {
				return aTime - bTime;
			}
			return a.sequence - b.sequence;
		});
	}

	private renderHermesThreadEntries(
		listEl: HTMLElement,
		entries: HermesThreadEntry[],
		visibleComponents: HermesActivityComponentVisibility
	): void {
		const visibleEntries = entries.slice(-HERMES_VISIBLE_THREAD_ENTRY_LIMIT);
		const earlierEntries = entries.slice(0, Math.max(0, entries.length - visibleEntries.length));
		if (earlierEntries.length > 0) {
			const earlierButton = listEl.createEl("button", {
				cls: "tn-task-modal__hermes-earlier-activity",
				text: `Show earlier activity (${earlierEntries.length})`,
				attr: {
					type: "button",
					"aria-expanded": "false",
				},
			});
			const earlierListEl = listEl.createDiv({
				cls: "tn-task-modal__hermes-earlier-activity-list",
			});
			earlierListEl.hidden = true;
			for (const entry of earlierEntries) {
				this.renderHermesThreadEntry(earlierListEl, entry, visibleComponents);
			}
			earlierButton.addEventListener("click", () => {
				const expanded = earlierButton.getAttribute("aria-expanded") === "true";
				earlierButton.setAttribute("aria-expanded", String(!expanded));
				earlierButton.textContent = expanded
					? `Show earlier activity (${earlierEntries.length})`
					: "Hide earlier activity";
				earlierListEl.hidden = expanded;
			});
		}

		for (const entry of visibleEntries) {
			this.renderHermesThreadEntry(listEl, entry, visibleComponents);
		}
	}

	private renderHermesThreadEntry(
		listEl: HTMLElement,
		entry: HermesThreadEntry,
		visibleComponents: HermesActivityComponentVisibility
	): void {
		if (entry.type === "comment") {
			this.renderHermesThreadCommentCard(listEl, entry.comment, visibleComponents);
			return;
		}
		this.renderHermesStatusUpdateItem(listEl, entry.card, visibleComponents);
	}

	private renderHermesStatusUpdateItem(
		listEl: HTMLElement,
		card: HermesActivityCard,
		visibleComponents: HermesActivityComponentVisibility
	): void {
		const visibleCard = this.filterHermesActivityCard(card, visibleComponents);
		const itemEl = listEl.createDiv({
			cls: [
				"tn-task-modal__hermes-status-item",
				`tn-task-modal__hermes-status-item--${visibleCard.statusVariant ?? "muted"}`,
			].join(" "),
		});
		itemEl.createSpan({ cls: "tn-task-modal__hermes-status-indicator" });
		const contentEl = itemEl.createDiv({ cls: "tn-task-modal__hermes-status-content" });
		const lineEl = contentEl.createDiv({ cls: "tn-task-modal__hermes-status-line" });
		lineEl.createSpan({
			cls: "tn-task-modal__hermes-status-label",
			text: visibleCard.statusLabel ?? this.hermesStatusLabelFromTitle(visibleCard.title),
		});
		if (visibleCard.meta) {
			lineEl.createSpan({
				cls: "tn-task-modal__hermes-status-meta",
				text: visibleCard.meta,
			});
		}
		const summary =
			visibleCard.statusSummary ?? this.hermesStatusSummaryFromTitle(visibleCard.title);
		if (summary) {
			contentEl.createDiv({
				cls: "tn-task-modal__hermes-status-summary",
				text: summary,
			});
		}

		const details = visibleCard.details?.filter((detail) => detail.label !== "Run") ?? [];
		if (details.length) {
			const detailsEl = contentEl.createDiv({
				cls: "tn-task-modal__hermes-activity-details tn-task-modal__hermes-status-details",
			});
			for (const detail of details) {
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

		if (visibleCard.actions?.length) {
			this.renderHermesActivityActions(contentEl, visibleCard.actions);
		}

		if (visibleCard.body) {
			contentEl.createDiv({
				cls: "tn-task-modal__hermes-activity-body tn-task-modal__hermes-status-body",
				text: visibleCard.body,
			});
		}
	}

	private hermesStatusLabelFromTitle(title: string): string {
		const [label] = title.split(/:\s*/, 1);
		return label.trim() || "Activity";
	}

	private hermesStatusSummaryFromTitle(title: string): string {
		const colonIndex = title.indexOf(":");
		return colonIndex >= 0 ? title.slice(colonIndex + 1).trim() : "";
	}

	private renderHermesThreadCommentCard(
		listEl: HTMLElement,
		comment: HermesCommentCard,
		visibleComponents: HermesActivityComponentVisibility
	): void {
		const parsedComment = parseHermesComment(comment.body, {
			author: comment.author,
			createdAt: comment.createdAt,
		});
		const isStructured = parsedComment.kind !== "comment";
		const cardEl = listEl.createDiv({
			cls: [
				"tn-task-modal__hermes-thread-card",
				isStructured ? "tn-task-modal__hermes-thread-card--structured" : "",
				isStructured ? `tn-task-modal__hermes-thread-card--${parsedComment.severity}` : "",
			]
				.filter(Boolean)
				.join(" "),
		});
		cardEl.createDiv({
			cls: "tn-task-modal__hermes-thread-avatar",
			text: this.hermesAuthorInitials(comment.author),
		});
		const contentEl = cardEl.createDiv({ cls: "tn-task-modal__hermes-thread-content" });
		const headerEl = contentEl.createDiv({ cls: "tn-task-modal__hermes-thread-header" });
		headerEl.createSpan({ cls: "tn-task-modal__hermes-thread-author", text: comment.author });
		const timestamp = formatHermesActivityTimestamp(comment.createdAt);
		if (timestamp) {
			headerEl.createSpan({ cls: "tn-task-modal__hermes-thread-time", text: ` - ${timestamp}` });
		}
		const childTaskIds = this.hermesCommentChildTaskIds(comment, parsedComment);
		if (childTaskIds.length > 0) {
			this.renderHermesCommentChildTaskToggle(headerEl, cardEl, childTaskIds);
		}

		if (!isStructured) {
			contentEl.createDiv({ cls: "tn-task-modal__hermes-thread-body", text: comment.body });
			const actions = this.filterHermesActivityActions(parsedComment.actions, visibleComponents);
			if (actions.length > 0) {
				this.renderHermesActivityActions(contentEl, actions);
			}
			return;
		}

		this.renderStructuredHermesThreadComment(
			cardEl,
			contentEl,
			parsedComment,
			[comment.author, timestamp].filter(Boolean).join(" - "),
			visibleComponents
		);
	}

	private renderStructuredHermesThreadComment(
		cardEl: HTMLElement,
		contentEl: HTMLElement,
		model: HermesCommentPresentationModel,
		meta: string,
		visibleComponents: HermesActivityComponentVisibility
	): void {
		const summaryEl = contentEl.createDiv({ cls: "tn-task-modal__hermes-thread-structured" });
		const titleRowEl = summaryEl.createDiv({ cls: "tn-task-modal__hermes-thread-structured-title-row" });
		const title = this.hermesStructuredCommentTitle(model);
		titleRowEl.createSpan({
			cls: "tn-task-modal__hermes-thread-structured-title",
			text: title,
		});
		if (model.summary) {
			summaryEl.createDiv({
				cls: "tn-task-modal__hermes-thread-body tn-task-modal__hermes-thread-body--structured",
				text: model.summary,
			});
		}
		const details = this.filterHermesActivityDetails(
			this.hermesCommentDetails(model) ?? [],
			visibleComponents
		);
		if (details.length > 0) {
			this.renderHermesActivityDetails(summaryEl, details, [
				"tn-task-modal__hermes-thread-structured-details",
			]);
		}
		this.renderHermesActivityActions(
			summaryEl,
			this.filterHermesActivityActions(model.actions, visibleComponents)
		);
		this.renderHermesRawToggle(summaryEl, model.raw);
		this.attachHermesStructuredThreadDetailModal(cardEl, {
			title,
			meta,
			body: model.summary,
			details: this.filterHermesActivityDetails(
				this.hermesCommentDetails(model, { includeBookkeeping: true }) ?? [],
				visibleComponents
			),
			actions: this.filterHermesActivityActions(model.actions, visibleComponents),
			raw: model.raw,
		});
	}

	private hermesCommentChildTaskIds(
		comment: HermesCommentCard,
		model: HermesCommentPresentationModel
	): string[] {
		if (!this.isHermesAutoDecomposerComment(comment)) {
			return [];
		}

		const taskIds = model.actions
			.filter((action) => action.type === "task")
			.map((action) => normalizeHermesTaskId(action.value))
			.filter(Boolean);
		return Array.from(new Set(taskIds));
	}

	private isHermesAutoDecomposerComment(comment: HermesCommentCard): boolean {
		const author = comment.author.trim().toLowerCase();
		const body = comment.body.toLowerCase();
		return (
			author === HERMES_AUTO_DECOMPOSER_AUTHOR ||
			author.includes("decomposer") ||
			/\bdecomposed\s+into\b/.test(body)
		);
	}

	private renderHermesCommentChildTaskToggle(
		headerEl: HTMLElement,
		cardEl: HTMLElement,
		childTaskIds: string[]
	): void {
		const toggleLabel = this.hermesChildTaskToggleLabel(childTaskIds.length, false);
		const toggleEl = headerEl.createEl("button", {
			cls: "tn-task-modal__hermes-child-toggle task-card__blocking-toggle is-visible",
			attr: {
				type: "button",
				"aria-expanded": "false",
				"aria-label": toggleLabel,
			},
		});
		toggleEl.dataset.count = String(childTaskIds.length);
		setIcon(toggleEl, "git-branch");
		setTooltip(toggleEl, toggleLabel, { placement: "top" });
		toggleEl.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			void this.toggleHermesCommentChildTasks(cardEl, toggleEl, childTaskIds);
		});
	}

	private async toggleHermesCommentChildTasks(
		cardEl: HTMLElement,
		toggleEl: HTMLElement,
		childTaskIds: string[]
	): Promise<void> {
		const existing = this.findHermesCommentChildTaskContainer(cardEl);
		if (existing) {
			existing.remove();
			this.updateHermesCommentChildTaskToggle(toggleEl, childTaskIds.length, false);
			return;
		}

		this.updateHermesCommentChildTaskToggle(toggleEl, childTaskIds.length, true);
		const container = cardEl.createDiv({
			cls: "task-card__blocking tn-task-modal__hermes-child-tasks",
		});
		for (const eventName of ["click", "dblclick", "contextmenu"]) {
			container.addEventListener(eventName, (event) => event.stopPropagation());
		}

		const loadingEl = container.createDiv({
			cls: "task-card__blocking-loading",
			text: "Loading child tasks...",
		});

		try {
			const childTasks = await this.resolveHermesChildTasks(childTaskIds);
			loadingEl.remove();
			if (childTasks.length === 0) {
				container.createDiv({
					cls: "task-card__blocking-empty",
					text: "No child task notes found.",
				});
				return;
			}

			for (const childTask of childTasks) {
				const childCard = createTaskCard(childTask, this.plugin, undefined, {
					layout: "compact",
					enableHoverPreview: false,
					showSecondaryBadges: false,
					expandedRelationshipFilterMode: "show-all",
				});
				childCard.classList.add("task-card--dependency");
				container.appendChild(childCard);
			}
		} catch (error) {
			tasknotesLogger.warn("Failed to load Hermes child tasks:", {
				category: "provider",
				operation: "load-hermes-child-tasks",
				details: { taskIds: childTaskIds },
				error,
			});
			loadingEl.textContent = "Could not load child task notes.";
		}
	}

	private updateHermesCommentChildTaskToggle(
		toggleEl: HTMLElement,
		count: number,
		expanded: boolean
	): void {
		toggleEl.classList.toggle("task-card__blocking-toggle--expanded", expanded);
		toggleEl.setAttribute("aria-expanded", String(expanded));
		const label = this.hermesChildTaskToggleLabel(count, expanded);
		toggleEl.setAttribute("aria-label", label);
		setTooltip(toggleEl, label, { placement: "top" });
	}

	private hermesChildTaskToggleLabel(count: number, expanded: boolean): string {
		const noun = count === 1 ? "child task" : "child tasks";
		return `${expanded ? "Hide" : "Show"} ${count} ${noun}`;
	}

	private findHermesCommentChildTaskContainer(cardEl: HTMLElement): HTMLElement | null {
		for (const child of Array.from(cardEl.children)) {
			if (
				child.instanceOf(HTMLElement) &&
				child.classList.contains("tn-task-modal__hermes-child-tasks")
			) {
				return child;
			}
		}
		return null;
	}

	private async resolveHermesChildTasks(taskIds: string[]): Promise<TaskInfo[]> {
		const identity = getHermesTaskIdentity(this.task);
		const board = identity?.board;
		const normalizedIds = Array.from(
			new Set(taskIds.map((taskId) => normalizeHermesTaskId(taskId)).filter(Boolean))
		);
		const resolved = new Map<string, TaskInfo>();
		const missingIds: string[] = [];

		for (const taskId of normalizedIds) {
			const directTask = board
				? await this.plugin.cacheManager.getTaskInfo(`TaskNotes/${board}/${taskId}.md`)
				: null;
			if (directTask) {
				resolved.set(taskId, directTask);
			} else {
				missingIds.push(taskId);
			}
		}

		if (missingIds.length > 0) {
			const allTasks = await this.plugin.cacheManager.getAllTasks();
			for (const taskId of missingIds) {
				const sameBoardTask = allTasks.find((task) => {
					const taskIdentity = getHermesTaskIdentity(task);
					return taskIdentity?.id === taskId && (!board || taskIdentity.board === board);
				});
				const anyBoardTask =
					sameBoardTask ??
					allTasks.find((task) => getHermesTaskIdentity(task)?.id === taskId);
				if (anyBoardTask) {
					resolved.set(taskId, anyBoardTask);
				}
			}
		}

		return normalizedIds
			.map((taskId) => resolved.get(taskId))
			.filter((task): task is TaskInfo => Boolean(task));
	}

	private hermesRunStateLabel(
		run: HermesRunCard
	): { label: string; variant: "success" | "warning" | "danger" | "muted" } {
		const value = (run.outcome || run.status || "unknown").toLowerCase();
		if (value.includes("running")) return { label: "Running", variant: "warning" };
		if (value.includes("block") || value.includes("review")) return { label: "Review required", variant: "warning" };
		if (value.includes("fail") || value.includes("crash") || value.includes("timed")) {
			return { label: formatHermesEventKind(value), variant: "danger" };
		}
		if (value.includes("done") || value.includes("complete") || value.includes("success")) {
			return { label: "Completed", variant: "success" };
		}
		return { label: formatHermesEventKind(value), variant: "muted" };
	}

	private hermesVerificationLabel(run: HermesRunCard): string {
		const metadata = run.metadata ?? {};
		const testsRun = metadata.tests_run;
		const testsPassed = metadata.tests_passed;
		if (typeof testsRun === "number" && typeof testsPassed === "number" && testsRun === testsPassed) {
			return "all checks passed";
		}
		const text = `${run.summary ?? ""} ${stringifyUnknown(metadata)}`.toLowerCase();
		if (/blocked|could not|failed|failure|not run|did not run|verification blocked/.test(text)) {
			return "verification blocked";
		}
		if (/partial|skipped/.test(text)) return "partial verification";
		if (/all checks passed|checks passed|tests? passed|build passed|typecheck passed|lint passed/.test(text)) {
			return "checks passed";
		}
		return "not verified";
	}

	private buildPinnedHermesReviewCard(
		comments: HermesCommentCard[],
		detail: HermesTaskDetailResponse,
		runs: HermesRunCard[]
	): HermesActivityCard | null {
		const reviewComment = [...comments]
			.reverse()
			.find((comment) => this.isHermesReviewHandoffText(comment.body));
		if (reviewComment) {
			return this.buildHermesReviewCardFromText(reviewComment.body, {
				sourceId: reviewComment.id ?? reviewComment.body,
				meta: formatHermesCommentMeta(reviewComment),
				status: "Review required",
			});
		}

		const taskStatus = detail.task?.status?.toLowerCase() || this.getHermesStatus();
		const latestRun = runs.length > 0 ? runs[runs.length - 1] : undefined;
		if (taskStatus === "blocked" || taskStatus.includes("review")) {
			const taskText =
				detail.task?.latest_summary ||
				detail.task?.result ||
				detail.task?.body ||
				latestRun?.summary ||
				latestRun?.error ||
				detail.task?.title ||
				"Task is blocked.";
			return this.buildHermesReviewCardFromText(taskText, {
				meta: latestRun ? formatHermesActivityTimestamp(latestRun.endedAt ?? latestRun.startedAt) : undefined,
				status: taskStatus === "blocked" ? "Blocked" : "Review required",
				metadata: latestRun?.metadata ?? detail.task?.metadata ?? undefined,
			});
		}
		return null;
	}

	private buildHermesReviewCardFromText(
		text: string,
		options: { sourceId?: string; meta?: string; status: string; metadata?: Record<string, unknown> }
	): HermesActivityCard {
		const model = parseHermesComment(text, { metadata: options.metadata });
		const cleanedText = text.replace(/^review-required\s+handoff:\s*/i, "").replace(/^review-required:\s*/i, "").trim();
		const details = this.hermesCommentDetails(model);
		const body = model.payload
			? this.hermesReviewBody(model.payload, cleanedText)
			: compactHermesActivityText(cleanedText, 260);
		return {
			title:
				model.kind === "comment"
					? this.hermesReviewTitle(cleanedText, options.status)
					: model.title,
			fullTitle: cleanedText,
			meta: options.meta,
			details,
			actions: model.actions,
			body,
			variant: "pinned",
			sourceId: options.sourceId,
			raw: model.raw,
		};
	}

	private isHermesReviewHandoffText(text: string): boolean {
		return parseHermesComment(text).kind === "review-required";
	}

	private hermesCommentDetails(
		model: HermesCommentPresentationModel,
		options: { includeBookkeeping?: boolean } = {}
	): HermesActivityDetail[] | undefined {
		const details = model.chips
			.filter((chip) => options.includeBookkeeping || (chip.label !== "Run" && chip.label !== "Profile"))
			.map((chip) => ({ label: chip.label, value: chip.value }));
		return details.length > 0 ? details : undefined;
	}

	private parseHermesStructuredPayload(text: string): Record<string, unknown> | null {
		const start = text.indexOf("{");
		const end = text.lastIndexOf("}");
		if (start < 0 || end <= start) return null;
		try {
			const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
			return isHermesEventRecord(parsed) ? parsed : null;
		} catch {
			return null;
		}
	}

	private hermesReviewActions(text: string, payload: Record<string, unknown> | undefined | null): HermesActivityAction[] {
		const actions = payload ? extractHermesEventActions(payload) : [];
		const seen = new Set(actions.map((action) => `${action.type}:${action.value.toLowerCase()}`));
		for (const match of text.matchAll(HERMES_TASK_ID_REGEX)) {
			const taskId = normalizeHermesTaskId(match[0]);
			const key = `task:${taskId}`;
			if (!seen.has(key)) {
				seen.add(key);
				actions.push({ type: "task", label: `Edit ${taskId}`, value: taskId });
			}
		}
		return actions;
	}

	private hermesReviewDetails(payload: Record<string, unknown> | undefined | null): HermesActivityDetail[] | undefined {
		if (!payload) return undefined;
		const details: HermesActivityDetail[] = [];
		for (const key of ["changed_files", "tests_run", "tests_passed", "verification", "decisions"]) {
			const value = payload[key];
			if (isEmptyHermesEventPayloadValue(value)) continue;
			details.push({
				label: key === "tests_run" ? "Tests run" : formatHermesEventFieldLabel(key),
				value: summarizeHermesEventPayloadValue(value, key),
			});
		}
		return details.length > 0 ? details : undefined;
	}

	private hermesReviewBody(payload: Record<string, unknown>, fallback: string): string {
		const summary = optionalString(payload.summary) || optionalString(payload.result) || optionalString(payload.error);
		const decisions = Array.isArray(payload.decisions)
			? payload.decisions.map((item) => hermesActivityText(item)).filter(Boolean).slice(0, 2).join(" ")
			: "";
		return compactHermesActivityText([summary, decisions].filter(Boolean).join("\n") || fallback, 360);
	}

	private hermesReviewTitle(text: string, fallback: string): string {
		const trimmed = text.trim();
		if (trimmed.startsWith("{") || trimmed.startsWith("[")) return fallback;
		const firstHeading = trimmed.match(/^#+\s+(.+)$/m)?.[1]?.trim();
		if (firstHeading) return compactHermesActivityText(firstHeading, 120);
		const firstSentence = trimmed.split(/[\n.]/).map((part) => part.trim()).find(Boolean);
		return compactHermesActivityText(firstSentence || fallback, 120);
	}

	private hermesStructuredCommentTitle(model: HermesCommentPresentationModel): string {
		if (model.kind === "handoff") return "Agent handoff";
		if (model.kind === "review-required") return "Review required";
		if (model.kind === "run-summary") return "Run summary";
		if (model.kind === "artifact-report") return "Artifact report";
		return model.title || "Hermes comment";
	}

	private hermesAuthorInitials(author: string): string {
		const initials = author
			.split(/[-_\s]+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((part) => part[0]?.toUpperCase())
			.join("");
		return initials || "H";
	}

	private filterHermesActivityCard(
		card: HermesActivityCard,
		visibleComponents: HermesActivityComponentVisibility
	): HermesActivityCard {
		return {
			...card,
			details: card.details
				? this.filterHermesActivityDetails(card.details, visibleComponents)
				: undefined,
			actions: card.actions
				? this.filterHermesActivityActions(card.actions, visibleComponents)
				: undefined,
		};
	}

	private filterHermesActivityDetails(
		details: HermesActivityDetail[],
		visibleComponents: HermesActivityComponentVisibility
	): HermesActivityDetail[] {
		return details.filter((detail) => {
			const label = detail.label.toLowerCase();
			if (!visibleComponents.changedFiles && label.includes("changed file")) {
				return false;
			}
			if (!visibleComponents.artifacts && label.includes("artifact")) {
				return false;
			}
			return true;
		});
	}

	private filterHermesActivityActions(
		actions: HermesActivityAction[],
		visibleComponents: HermesActivityComponentVisibility
	): HermesActivityAction[] {
		return actions.filter((action) => visibleComponents.artifacts || action.type !== "artifact");
	}

	private renderHermesActivityDetails(
		container: HTMLElement,
		details: HermesActivityDetail[],
		extraClasses: string[] = []
	): boolean {
		if (details.length === 0) {
			return false;
		}

		const detailsEl = container.createDiv({
			cls: ["tn-task-modal__hermes-activity-details", ...extraClasses].join(" "),
		});
		const hasOverflow = details.length > HERMES_VISIBLE_ACTIVITY_DETAIL_LIMIT;
		for (const [index, detail] of details.entries()) {
			const rowEl = detailsEl.createDiv({
				cls: [
					"tn-task-modal__hermes-activity-detail-row",
					index >= HERMES_VISIBLE_ACTIVITY_DETAIL_LIMIT
						? "tn-task-modal__hermes-activity-detail-row--overflow"
						: "",
				]
					.filter(Boolean)
					.join(" "),
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
		if (hasOverflow) {
			detailsEl.createDiv({
				cls: "tn-task-modal__hermes-activity-overflow-summary",
				text: `+${details.length - HERMES_VISIBLE_ACTIVITY_DETAIL_LIMIT} more`,
			});
		}
		return hasOverflow;
	}

	private renderHermesActivityActions(
		container: HTMLElement,
		actions: HermesActivityAction[]
	): boolean {
		if (actions.length === 0) {
			return false;
		}

		const actionsEl = container.createDiv({
			cls: "tn-task-modal__hermes-activity-actions tn-task-modal__hermes-artifact-list",
		});
		const hasOverflow = actions.length > HERMES_VISIBLE_ACTIVITY_ACTION_LIMIT;
		for (const [index, action] of actions.entries()) {
			const actionEl = actionsEl.createEl("button", {
				cls: [
					"tn-task-modal__hermes-activity-action",
					"tn-task-modal__hermes-artifact-card",
					index >= HERMES_VISIBLE_ACTIVITY_ACTION_LIMIT
						? "tn-task-modal__hermes-activity-action--overflow"
						: "",
				]
					.filter(Boolean)
					.join(" "),
				text: action.label,
				attr: { type: "button" },
			});
			actionEl.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				void this.handleHermesActivityAction(action);
			});
		}
		if (hasOverflow) {
			actionsEl.createDiv({
				cls: "tn-task-modal__hermes-activity-overflow-summary",
				text: `+${actions.length - HERMES_VISIBLE_ACTIVITY_ACTION_LIMIT} more`,
			});
		}
		return hasOverflow;
	}

	private renderHermesRawToggle(container: HTMLElement, raw: string): void {
		let rawEl: HTMLElement | null = null;
		const buttonEl = container.createEl("button", {
			cls: "tn-task-modal__hermes-raw-toggle",
			text: "View raw",
			attr: { type: "button", "aria-expanded": "false" },
		});
		buttonEl.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			const expanded = buttonEl.getAttribute("aria-expanded") === "true";
			buttonEl.setAttribute("aria-expanded", String(!expanded));
			buttonEl.textContent = expanded ? "View raw" : "Hide raw";
			if (expanded) {
				rawEl?.remove();
				rawEl = null;
				return;
			}
			rawEl = container.createEl("pre", {
				cls: "tn-task-modal__hermes-raw-payload",
				text: raw,
			});
		});
	}

	private renderHermesActivityCardItem(
		listEl: HTMLElement,
		card: HermesActivityCard,
		visibleComponents: HermesActivityComponentVisibility
	): void {
		const visibleCard = this.filterHermesActivityCard(card, visibleComponents);
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
				visibleCard.variant === "pinned" ? "tn-task-modal__hermes-review-card--pinned" : "",
			]
				.filter(Boolean)
				.join(" "),
		});
		const mainRowEl = cardEl.createDiv({ cls: "task-card__main-row" });

		const contentEl = mainRowEl.createDiv({ cls: "task-card__content" });
		const titleEl = contentEl.createDiv({ cls: "task-card__title" });
		if (visibleCard.variant === "pinned") {
			const labelEl = titleEl.createSpan({
				cls: "tn-task-modal__hermes-pinned-label",
				text: "PINNED",
			});
			labelEl.setAttribute("aria-label", "Pinned review card");
		}
		titleEl.createSpan({
			cls: "task-card__title-text tn-task-modal__hermes-activity-title",
			text: visibleCard.title,
		});

		if (visibleCard.meta) {
			const metadataEl = contentEl.createDiv({ cls: "task-card__metadata" });
			metadataEl.createSpan({
				cls: "task-card__metadata-item tn-task-modal__hermes-activity-time",
				text: visibleCard.meta,
			});
		}

		if (visibleCard.body) {
			contentEl.createDiv({
				cls: "tn-task-modal__hermes-activity-body",
				text: visibleCard.body,
			});
		}

		if (visibleCard.details) {
			this.renderHermesActivityDetails(contentEl, visibleCard.details);
		}
		this.renderHermesActivityActions(contentEl, visibleCard.actions ?? []);

		if (visibleCard.raw) {
			this.renderHermesRawToggle(contentEl, visibleCard.raw);
		}
		this.attachHermesActivityCardDetailModal(cardEl, visibleCard);
	}

	private attachHermesActivityCardDetailModal(
		cardEl: HTMLElement,
		card: HermesActivityCard
	): void {
		cardEl.addClass("tn-task-modal__hermes-activity-card--openable");
		cardEl.tabIndex = 0;
		cardEl.setAttribute("role", "button");
		cardEl.setAttribute("aria-haspopup", "dialog");
		cardEl.setAttribute("aria-label", `Open ${card.title} details`);
		setTooltip(cardEl, "Open activity details", { placement: "top" });

		const openDetails = (event: Event) => {
			event.preventDefault();
			event.stopPropagation();
			this.openHermesActivityDetailModal({
				title: card.title,
				meta: card.meta,
				body: this.resolveHermesActivityModalBody(card),
				details: card.details,
				actions: card.actions,
				raw: card.raw,
			});
		};

		cardEl.addEventListener("click", openDetails);
		cardEl.addEventListener("keydown", (event) => {
			if (event.key !== "Enter" && event.key !== " ") {
				return;
			}
			openDetails(event);
		});
	}

	private attachHermesStructuredThreadDetailModal(
		cardEl: HTMLElement,
		options: Omit<HermesActivityDetailModalOptions, "onAction">
	): void {
		cardEl.addClass("tn-task-modal__hermes-thread-card--openable");
		cardEl.tabIndex = 0;
		cardEl.setAttribute("role", "button");
		cardEl.setAttribute("aria-haspopup", "dialog");
		cardEl.setAttribute("aria-label", `Open ${options.title} details`);
		setTooltip(cardEl, "Open activity details", { placement: "top" });

		const openDetails = (event: Event) => {
			event.preventDefault();
			event.stopPropagation();
			this.openHermesActivityDetailModal(options);
		};

		cardEl.addEventListener("click", openDetails);
		cardEl.addEventListener("keydown", (event) => {
			if (event.key !== "Enter" && event.key !== " ") {
				return;
			}
			openDetails(event);
		});
	}

	private resolveHermesActivityModalBody(card: HermesActivityCard): string | undefined {
		const fullTitle = card.fullTitle?.trim();
		if (fullTitle && fullTitle !== card.title && !card.raw) {
			return fullTitle;
		}
		return card.body;
	}

	private openHermesActivityDetailModal(
		options: Omit<HermesActivityDetailModalOptions, "onAction">
	): void {
		new HermesActivityDetailModal(this.app, {
			...options,
			onAction: (action) => this.handleHermesActivityAction(action),
		}).open();
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
			.map((run) => {
				const state = this.hermesRunStateLabel(run);
				const fullTitle = hermesActivityText(
					run.summary || run.error || "No run summary yet."
				);
				return {
					title: compactHermesActivityText(fullTitle, 180),
					fullTitle,
					meta: formatHermesActivityTimestamp(run.endedAt ?? run.startedAt),
					details: [
						{ label: "Verification", value: this.hermesVerificationLabel(run) },
					],
					sortTimestamp: run.endedAt ?? run.startedAt,
					statusLabel: state.label,
					statusSummary: fullTitle,
					statusVariant: state.variant,
				};
			});
	}

	private buildHermesStatusUpdateCards(
		detail: HermesTaskDetailResponse,
		visibleComponents: HermesActivityComponentVisibility
	): HermesActivityCard[] {
		return [
			...(visibleComponents.runs ? this.buildHermesRunHistoryCards(detail) : []),
			...(visibleComponents.events ? this.buildHermesEventCards(detail) : []),
		];
	}

	private buildHermesEventCards(detail: HermesTaskDetailResponse): HermesActivityCard[] {
		return normalizeHermesEvents(detail.events ?? [])
			.slice(-5)
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
				statusLabel: "Latest event",
				statusSummary: compactHermesActivityText(fullTitle, 180),
				statusVariant: "muted",
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

	private async sendHermesAction(
		actionLabel: string,
		operation: (
			api: HermesKanbanApiClient,
			identity: { board: string; id: string }
		) => Promise<HermesTaskDetailResponse | null>
	): Promise<boolean> {
		if (this.hasUnsavedHermesModalChanges()) {
			await this.flushHermesLiveSave();
			if (this.hasUnsavedHermesModalChanges()) {
				new Notice("Finish the current live edits before sending an action.");
				return false;
			}
		}

		const identity = getHermesTaskIdentity(this.task);
		if (!identity) {
			new Notice("This task is missing a board or task ID.");
			return false;
		}
		if (!(await this.ensureHermesLiveForAction())) {
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
		const existingActivity = getHermesActivitySnapshotFromTask(this.plugin, this.task);
		const activity = buildHermesActivitySnapshot(detail, { existing: existingActivity });
		const { taskInfo } = await createOrUpdateHermesMirrorNote(this.plugin, board, detail.task, {
			parents: detail.links?.parents ?? [],
			children: detail.links?.children ?? [],
			activity,
		});
		this.task = taskInfo;
		this.options.task = taskInfo;
		return taskInfo;
	}

	private syncHermesEditBaselines(updatedTask: TaskInfo): void {
		this.initialBlockedBy = (updatedTask.blockedBy ?? []).map((dependency) => ({
			...dependency,
		}));
		this.initialBlockingPaths = [...(updatedTask.blocking ?? [])];
		this.initialTags = (updatedTask.tags ?? []).join(", ");
		this.originalDetails = this.details;
	}

	private async handleHermesCommentSubmit(
		input: HTMLTextAreaElement,
		button: HTMLButtonElement | null
	): Promise<void> {
		const comment = input.value.trim();
		if (!comment) return;
		if (this.hasUnsavedHermesModalChanges()) {
			await this.flushHermesLiveSave();
			if (this.hasUnsavedHermesModalChanges()) {
				new Notice("Finish the current live edits before sending a comment.");
				return;
			}
		}

		const identity = getHermesTaskIdentity(this.task);
		if (!identity) {
			new Notice("This task is missing a board or task ID.");
			return;
		}
		if (!(await this.ensureHermesLiveForAction())) {
			return;
		}

		input.disabled = true;
		if (button) button.disabled = true;
		const api = new HermesKanbanApiClient();
		try {
			await api.addComment(identity, { body: comment, author: "tasknotes" });
		} catch (error) {
			tasknotesLogger.error("Failed to send board comment:", {
				category: "persistence",
				operation: "hermes-comment",
				error,
			});
			const message = error instanceof Error && error.message ? error.message : String(error);
			new Notice(`Comment failed: ${message}`);
			input.disabled = false;
			if (button) button.disabled = input.value.trim().length === 0;
			input.focus();
			return;
		}

		input.value = "";
		resizeTaskModalTitleTextarea(input);
		input.disabled = false;
		if (button) button.disabled = true;

		try {
			const detail = await api.getTask(identity);
			const updatedTask = detail.task
				? await this.refreshHermesMirror(identity.board, detail)
				: this.task;
			if (this.options.onTaskUpdated) {
				this.options.onTaskUpdated(updatedTask);
			}
			if (this.hermesActivityElements) {
				this.renderHermesActivityDetail(this.hermesActivityElements, detail);
			}
			new Notice("Comment sent");
		} catch (error) {
			tasknotesLogger.warn("Hermes comment sent but refresh failed:", {
				category: "provider",
				operation: "hermes-comment-refresh",
				error,
			});
			const message = error instanceof Error && error.message ? error.message : String(error);
			new Notice(`Comment sent, but refresh failed: ${message}`);
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

		if (getHermesTaskIdentity(this.task)) {
			if (!this.hasUnsavedHermesModalChanges()) {
				super.close();
				return;
			}

			void (async () => {
				await this.flushHermesLiveSave();
				if (!this.hasUnsavedHermesModalChanges()) {
					this.forceClose();
				}
			})();
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
		if (this.hermesLiveSaveTimer) {
			window.clearTimeout(this.hermesLiveSaveTimer);
			this.hermesLiveSaveTimer = null;
		}

		// Clean up keyboard handler
		if (this.editModalKeyboardHandler) {
			this.containerEl.removeEventListener("keydown", this.editModalKeyboardHandler);
			this.editModalKeyboardHandler = null;
		}

		// Base class handles detailsMarkdownEditor cleanup
		super.onClose();
	}

	private async handleHermesSave(
		changes: Partial<TaskInfo>,
		hasBlockingChanges: boolean,
		hasSubtaskChanges: boolean,
		options: { showSuccessNotice?: boolean } = {}
	): Promise<boolean> {
		const identity = getHermesTaskIdentity(this.task);
		if (!identity) {
			new Notice("This task is missing a board or task ID.");
			return false;
		}

		const routing = await this.validateHermesEditRouting(identity);
		if (routing.error) {
			new Notice(routing.error);
			return false;
		}

		let updatedTask = this.task;
		const hasTaskChanges = Object.keys(changes).length > 0;

		if (hasTaskChanges) {
			if (changes.status === "running") {
				new Notice("Running state is claimed by the dispatcher, not tasknotes.");
				return false;
			}
			updatedTask = await this.plugin.taskService.updateTask(this.task, changes);
			this.task = updatedTask;
			this.options.task = updatedTask;
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
				this.options.task = refreshed;
			}
		}

		if (hasSubtaskChanges) {
			await this.applySubtaskChanges(updatedTask);
		}

		if (!hasTaskChanges && !hasBlockingChanges && !hasSubtaskChanges) {
			new Notice("No tasknotes-backed changes to save.");
			return false;
		}

		if (this.options.onTaskUpdated) {
			this.options.onTaskUpdated(updatedTask);
		}
		this.pendingBlockingUpdates = { added: [], removed: [], raw: {} };
		this.unresolvedBlockingEntries = [];
		this.syncHermesEditBaselines(updatedTask);
		this.updateIconStates();
		if (options.showSuccessNotice !== false) {
			new Notice(`Task updated: ${updatedTask.title}`);
		}
		return true;
	}

	private async validateHermesEditRouting(identity: {
		board: string;
		id: string;
	}): Promise<{ error?: string }> {
		const acceptedBoards = await this.resolveHermesBoardOptions();
		const boardResult = validateHermesBoardSelection(
			this.projects,
			acceptedBoards,
			identity.board
		);
		if (boardResult.error) {
			return { error: boardResult.error };
		}

		const acceptedAssignees = await this.resolveHermesAssigneeOptions(identity.board);
		const assigneeResult = validateHermesAssigneeSelection(this.contexts, acceptedAssignees);
		if (assigneeResult.error) {
			return { error: assigneeResult.error };
		}
		return {};
	}

	private async resolveHermesBoardOptions(): Promise<string[]> {
		try {
			const boards = (await new HermesKanbanApiClient().listBoards())
				.filter((board) => !board.archived)
				.map((board) => board.slug);
			if (boards.length > 0) {
				this.hermesBoardOptions = uniqueNonEmpty(boards);
				return this.hermesBoardOptions;
			}
		} catch (error) {
			tasknotesLogger.warn("Failed to load Hermes boards:", {
				category: "provider",
				operation: "load-hermes-boards",
				error,
			});
		}
		this.hermesBoardOptions = uniqueNonEmpty([
			...(this.hermesBoardOptions ?? []),
			...defaultHermesBoards(),
		]);
		return this.hermesBoardOptions;
	}

	private async resolveHermesAssigneeOptions(board?: string): Promise<string[]> {
		try {
			const assignees = (await new HermesKanbanApiClient().listAssignees(board))
				.map((assignee) => assignee.name)
				.filter(Boolean);
			if (assignees.length > 0) {
				this.hermesAssigneeOptions = uniqueNonEmpty(assignees);
				return this.hermesAssigneeOptions;
			}
		} catch (error) {
			tasknotesLogger.warn("Failed to load Hermes assignees:", {
				category: "provider",
				operation: "load-hermes-assignees",
				error,
			});
		}
		this.hermesAssigneeOptions = uniqueNonEmpty([
			...(this.hermesAssigneeOptions ?? []),
			...defaultHermesAssignees(),
			...splitHermesList(this.contexts),
		]);
		return this.hermesAssigneeOptions;
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
			const updatedTask = await this.plugin.taskService.toggleArchive(this.task);

			// Update the task reference
			this.task = updatedTask;
			this.options.task = updatedTask;

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

	private isHermesTaskBlocked(): boolean {
		return this.getHermesStatus() === "blocked";
	}

	private syncHermesBlockToggleButton(button: HTMLButtonElement): void {
		const isBlocked = this.isHermesTaskBlocked();
		button.textContent = isBlocked ? "Unblock" : "Block";
		button.title = isBlocked
			? "Move this Hermes task back to ready"
			: "Mark this Hermes task as blocked";
		button.classList.toggle("mod-warning", !isBlocked);
		button.classList.toggle("mod-cta", isBlocked);
		button.classList.toggle("tn-task-modal__hermes-block-toggle-button--blocked", isBlocked);
	}

	private async toggleHermesBlockedStatus(button?: HTMLButtonElement): Promise<void> {
		if (this.hasUnsavedHermesModalChanges()) {
			await this.flushHermesLiveSave();
			if (this.hasUnsavedHermesModalChanges()) {
				new Notice("Finish the current live edits before changing block state.");
				return;
			}
		}

		if (!getHermesTaskIdentity(this.task)) {
			new Notice("This task is missing a board or task ID.");
			return;
		}

		const isBlocked = this.isHermesTaskBlocked();
		const nextStatus = isBlocked ? "ready" : "blocked";

		if (button) {
			button.disabled = true;
		}

		try {
			const updatedTask = await this.plugin.taskService.updateTask(this.task, {
				status: nextStatus,
			});
			this.task = updatedTask;
			this.options.task = updatedTask;
			this.status = updatedTask.status || nextStatus;
			this.syncHermesEditBaselines(updatedTask);
			if (this.options.onTaskUpdated) {
				this.options.onTaskUpdated(updatedTask);
			}
			this.updateIconStates();
			if (button) {
				this.syncHermesBlockToggleButton(button);
			}
			new Notice(isBlocked ? "Task unblocked" : "Task blocked");
		} catch (error) {
			tasknotesLogger.error("Failed to toggle Hermes block state:", {
				category: "persistence",
				operation: "hermes-block-toggle",
				error,
			});
			const message = error instanceof Error && error.message ? error.message : String(error);
			new Notice(`Block state update failed: ${message}`);
		} finally {
			if (button) {
				button.disabled = false;
				this.syncHermesBlockToggleButton(button);
			}
		}
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
		const leadingButtons = [
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
		];

		if (getHermesTaskIdentity(this.task)) {
			const buttonContainer = container.createDiv({
				cls: "modal-button-container tn-task-modal__button-bar tn-task-modal__button-bar--hermes-live",
			});
			this.createHermesAvailabilitySnapshot(buttonContainer, this.hermesActivityElements ?? undefined);

			const openNoteButton = buttonContainer.createEl("button", {
				cls: "tn-task-modal__open-note-button",
				text: this.t("modals.task.buttons.openNote"),
			});
			openNoteButton.addEventListener("click", () => {
				void this.openTaskNote();
			});

			const blockToggleButton = buttonContainer.createEl("button", {
				cls: "tn-task-modal__hermes-block-toggle-button",
			});
			this.syncHermesBlockToggleButton(blockToggleButton);
			blockToggleButton.addEventListener("click", () => {
				void this.toggleHermesBlockedStatus(blockToggleButton);
			});
			return;
		}

		createTaskModalActionButtons(this.getActionButtonContext(), {
			container,
			leadingButtons,
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

function uniqueNonEmpty(values: readonly string[]): string[] {
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
