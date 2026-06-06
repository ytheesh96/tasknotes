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
	isHermesTaskNotFoundError,
	type HermesTaskDetailResponse,
	type HermesTaskRecord,
} from "../hermes/hermesApiClient";
import {
	HERMES_DASHBOARD_START_COMMAND,
	HermesAvailabilityService,
	type HermesAvailabilityHealth,
	type HermesDashboardStartResult,
} from "../hermes/hermesAvailabilityService";
import { HermesWriteGuard } from "../hermes/hermesWriteGuard";
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
import { canonicalHermesTaskPath } from "../hermes/hermesCanonicalTaskNotes";
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
import { getAllTasksFromNoteFirst, getTaskInfoFromNoteFirst } from "../utils/taskInfoRead";
import { resolveDependencyEntry } from "../utils/dependencyUtils";

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
	agent?: string;
	timestamp?: string | number;
	details?: HermesActivityDetail[];
	actions?: HermesActivityAction[];
	body?: string;
	variant?: "default" | "pinned" | "run" | "status";
	sourceId?: string;
	raw?: string;
	signals?: HermesActivitySignal[];
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

interface HermesActivitySignal {
	label: string;
	time?: string;
	variant?: "success" | "warning" | "danger" | "muted";
}

interface HermesActivityMetadataOptions {
	agent?: string;
	timestamp?: string | number;
	fallbackMeta?: string;
	activityLabel?: string;
	pinned?: boolean;
	statusLabel?: string;
	statusVariant?: "success" | "warning" | "danger" | "muted";
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

interface CachedHermesActivityFeed {
	comments: unknown[];
	runs: unknown[];
	events: unknown[];
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
		const metadata = normalizeHermesRunMetadata(record);
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

function normalizeHermesRunMetadata(record: Record<string, unknown>): Record<string, unknown> | undefined {
	const metadata: Record<string, unknown> = isHermesEventRecord(record.metadata)
		? { ...record.metadata }
		: {};
	for (const key of [
		"artifacts",
		"artifact",
		"changed_files",
		"working_files",
		"files",
		"paths",
		"diff_path",
		"qa_report",
		"report",
		"verification",
		"tests_run",
		"tests_passed",
	]) {
		if (!isEmptyHermesEventPayloadValue(record[key]) && isEmptyHermesEventPayloadValue(metadata[key])) {
			metadata[key] = record[key];
		}
	}
	return Object.keys(metadata).length > 0 ? metadata : undefined;
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

function toStringList(value: unknown): string[] {
	if (typeof value === "string") {
		return value.trim() ? [value.trim()] : [];
	}
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter(Boolean);
}

function stripMarkdownFrontmatter(content: string): string {
	return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

function optionalId(value: unknown): string | undefined {
	return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function optionalTimestamp(value: unknown): string | number | undefined {
	return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function hasHermesActivityItems(items: unknown[] | undefined): boolean {
	return Array.isArray(items) && items.length > 0;
}

function extractHermesActivityNotePath(value: unknown): string {
	if (typeof value !== "string") {
		return "";
	}
	const trimmed = value.trim();
	const wikiLinkMatch = trimmed.match(/\[\[([^|\]#]+)(?:#[^|\]]*)?(?:\|[^\]]*)?\]\]/);
	const path = (wikiLinkMatch?.[1] ?? "").trim();
	if (path) {
		return path.replace(/\\/g, "/").replace(/^\/+/, "");
	}
	if (trimmed.includes("/") && !trimmed.includes("\n")) {
		return trimmed.replace(/\\/g, "/").replace(/^\/+/, "");
	}
	return "";
}

function hermesActivityNotePathCandidates(path: string): string[] {
	const normalizedPath = path.replace(/\\/g, "/").replace(/^\/+/, "").trim();
	if (!normalizedPath) {
		return [];
	}
	return normalizedPath.endsWith(".md")
		? [normalizedPath]
		: [normalizedPath, `${normalizedPath}.md`];
}

function copyHermesMetadataValue(
	metadata: Record<string, unknown>,
	key: string,
	value: unknown
): void {
	if (isEmptyHermesEventPayloadValue(value) || !isEmptyHermesEventPayloadValue(metadata[key])) {
		return;
	}
	metadata[key] = value;
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
			agent: extractHermesEventAgent(payload),
			timestamp: event.createdAt,
			sortTimestamp: event.createdAt,
			statusLabel: kindLabel,
			statusSummary,
		statusVariant: hermesEventStatusVariant(event.kind, payload),
	};
}

function extractHermesEventAgent(payload: unknown): string | undefined {
	if (!isHermesEventRecord(payload)) {
		return undefined;
	}
	return (
		optionalString(payload.profile) ||
		optionalString(payload.agent) ||
		optionalString(payload.author) ||
		optionalString(payload.assignee) ||
		optionalString(payload.worker) ||
		undefined
	);
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

function isHermesRunLifecycleEvent(event: HermesEventCard): boolean {
	const normalizedKind = event.kind.toLowerCase();
	return /run|claim|spawn|heartbeat|review|complete|block|fail|success/.test(normalizedKind);
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
	private hermesActivityNoteBodies = new Map<string, string>();
	private hermesActivityRenderGeneration = 0;
	private hermesLiveTaskMissing = false;
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
			const frontmatterTaskInfo =
				(await this.plugin.cacheManager.getTaskInfoFromFrontmatter?.(this.task.path)) ??
				null;

			// Check if this file is actually a task (has task tag/property)
			// If not, keep the original task data (e.g., for "convert note to task" flow)
			const metadata = this.app.metadataCache.getFileCache(file);
			const isRecognizedTask =
				frontmatterTaskInfo !== null ||
				(metadata?.frontmatter && this.plugin.cacheManager.isTaskFile(metadata.frontmatter));

			if (!isRecognizedTask) {
				// File is not yet a task - keep the original task data passed to constructor
				// This preserves user's default settings for status/priority during conversion
				this.isConvertingNoteToTask = true;
				this.task.details = this.details;
				return;
			}

			this.isConvertingNoteToTask = false;

			const cachedTaskInfo =
				frontmatterTaskInfo ?? (await this.plugin.cacheManager.getTaskInfo(this.task.path));

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
		this.renderHermesReadonlyTitleField();
		this.attachHermesLiveEditHandlers();
	}

	private renderHermesReadonlyTitleField(): void {
		if (!getHermesTaskIdentity(this.task) || !this.titleInput) {
			return;
		}

		const titleInput = this.titleInput;
		const readonlyTitleEl = titleInput.ownerDocument.createElement("div");
		readonlyTitleEl.className = "tn-task-modal__hermes-readonly-title";
		readonlyTitleEl.textContent = this.title;
		readonlyTitleEl.setAttribute("aria-label", "Task title");
		titleInput.replaceWith(readonlyTitleEl);
		this.titleInput = undefined;
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

	protected createTagsField(container: HTMLElement): void {
		if (!getHermesTaskIdentity(this.task)) {
			super.createTagsField(container);
			return;
		}
		const tags = this.tags
			.split(",")
			.map((tag) => tag.trim().replace(/^#/, ""))
			.filter(Boolean);
		const setting = new Setting(container);
		setting.settingEl.addClass(
			"tn-task-modal__wide-text-setting",
			"tn-task-modal__hermes-readonly-tags-setting"
		);
		setting.setName(this.t("modals.task.tagsLabel"));
		const tagListEl = setting.controlEl.createDiv({
			cls: "tn-task-modal__hermes-readonly-tag-list",
		});
		for (const tag of tags) {
			tagListEl.createSpan({
				cls: "tn-task-modal__hermes-readonly-tag",
				text: `#${tag}`,
			});
		}
		if (tags.length === 0) {
			tagListEl.createSpan({
				cls: "tn-task-modal__hermes-readonly-tag tn-task-modal__hermes-readonly-tag--empty",
				text: "No tags",
			});
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

		const threadList = activitySection.createDiv({
			cls: "task-projects-list tn-task-modal__hermes-comment-list tn-task-modal__hermes-thread-list",
		});
		this.renderHermesFallbackThread(threadList, visibleComponents);

		let commentInput: HTMLTextAreaElement | undefined;
		if (visibleComponents.comments) {
			const composer = activitySection.createDiv({
				cls: "modal-form__group tn-task-modal__hermes-composer",
			});
			const composerInputContainer = composer.createDiv({
				cls: "modal-form__input-container tn-task-modal__hermes-composer-input",
			});
			commentInput = composerInputContainer.createEl("textarea", {
				cls: "modal-form__input modal-form__input--textarea tn-task-modal__hermes-comment-input",
				attr: {
					placeholder: "Add a review comment...",
					rows: "2",
				},
			});
			commentInput.spellcheck = true;
			commentInput.setAttribute("aria-label", "Add a review comment");
			const commentButton = composerInputContainer.createEl("button", {
				cls: "tn-task-modal__hermes-send-button clickable-icon",
				attr: {
					type: "button",
					"aria-label": "Send comment",
				},
			});
			setIcon(commentButton, "send");
			setTooltip(commentButton, "Send comment", { placement: "top" });
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
			runStatusContainer: null,
			availabilityContainer: containers.availabilityContainer,
			commentInput,
			commentButtonRef,
			visibleComponents,
		};
		this.hermesActivityElements = activityElements;
		this.renderHermesFallbackThread(threadList, visibleComponents);
		void this.refreshHermesAvailabilityForActivity(activityElements, { autoStart: true });
	}

	private renderHermesFallbackThread(
		threadList: HTMLElement,
		visibleComponents: HermesActivityComponentVisibility
	): void {
		const renderGeneration = ++this.hermesActivityRenderGeneration;
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
			void this.hydrateCachedHermesCommentNoteBodies(
				renderGeneration,
				() => this.renderHermesFallbackThread(threadList, visibleComponents)
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

	private async refreshHermesAvailabilityForActivity(
		elements: HermesActivityElements,
		options: { autoStart?: boolean } = {}
	): Promise<void> {
		const health = await this.recheckHermesAvailability();
		this.renderHermesAvailabilitySnapshot(elements.availabilityContainer, health, elements);
		this.applyHermesAvailabilityToActivity(elements, health);
		if (health.status === "connected") {
			await this.refreshHermesLiveOptions();
			await this.loadHermesActivityCards(elements);
			return;
		}
		if (options.autoStart && health.status === "disconnected" && health.canStart) {
			await this.ensureHermesDashboardForActivity(elements);
		}
	}

	public async recheckHermesAvailability(): Promise<HermesAvailabilityHealth> {
		const identity = getHermesTaskIdentity(this.task);
		const health = await this.getHermesAvailabilityService().recheckHealth({
			transport: this.plugin.settings.hermesKanbanTransport,
			board: identity?.board,
		});
		this.hermesAvailabilityHealth = health;
		return health;
	}

	public async startHermesDashboardAndRefreshActivity(
		elements?: HermesActivityElements
	): Promise<HermesDashboardStartResult> {
		const result = await this.plugin.ensureHermesDashboardRunning({
			showNotice: false,
			force: true,
		});
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

	private async ensureHermesDashboardForActivity(
		elements: HermesActivityElements
	): Promise<void> {
		this.renderHermesAvailabilitySnapshot(
			elements.availabilityContainer,
			{
				...(this.hermesAvailabilityHealth ?? {
					rootUrl: "http://127.0.0.1:9119/",
					apiUrl: "http://127.0.0.1:9119/api/plugins/kanban",
					canStart: true,
				}),
				status: "starting",
				mode: "cache-only",
				message: "Starting Hermes dashboard...",
			},
			elements
		);

		try {
			const result = await this.plugin.ensureHermesDashboardRunning({ showNotice: false });
			this.hermesAvailabilityHealth = result.health;
			this.renderHermesAvailabilitySnapshot(
				elements.availabilityContainer,
				result.health,
				elements,
				result
			);
			this.applyHermesAvailabilityToActivity(elements, result.health);
			if (result.health.status === "connected") {
				await this.refreshHermesLiveOptions();
				await this.loadHermesActivityCards(elements);
			}
		} catch (error) {
			tasknotesLogger.warn("Failed to start Hermes dashboard for activity:", {
				category: "provider",
				operation: "ensure-hermes-dashboard-activity",
				error,
			});
		}
	}

	private async refreshHermesLiveOptions(): Promise<void> {
		const identity = getHermesTaskIdentity(this.task);
		const options = await this.getHermesAvailabilityService().getOptions(identity?.board, {
			transport: this.plugin.settings.hermesKanbanTransport,
		});
		if (options.boards.length > 0) {
			this.hermesBoardOptions = uniqueNonEmpty(options.boards);
		}
		if (options.assignees.length > 0) {
			this.hermesAssigneeOptions = uniqueNonEmpty(options.assignees);
		}
	}

	private getHermesAvailabilityService(): HermesAvailabilityService {
		return new HermesAvailabilityService({ transport: this.plugin.settings.hermesKanbanTransport });
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
				? "Add a review comment..."
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
		return (
			!this.hermesLiveTaskMissing &&
			this.hermesAvailabilityHealth?.status === "connected" &&
			this.hermesAvailabilityHealth.mode === "live"
		);
	}

	private async ensureHermesLiveForAction(): Promise<boolean> {
		if (this.hermesLiveTaskMissing) {
			new Notice(
				"This task note no longer has a matching live board task; live controls are disabled."
			);
			return false;
		}
		const health = this.hermesAvailabilityHealth ?? (await this.recheckHermesAvailability());
		if (health.status === "connected" && health.mode === "live") {
			return true;
		}
		new Notice(
			`Hermes is ${this.hermesAvailabilityTitle(health).toLowerCase()}; live controls are disabled. Run ${this.getHermesStartCommand()}, then recheck.`
		);
		return false;
	}

	private async ensureHermesWriteAvailable(): Promise<boolean> {
		if (this.hermesLiveTaskMissing) {
			new Notice(
				"This task note no longer has a matching live board task; live edits are disabled."
			);
			return false;
		}
		const readiness = await new HermesWriteGuard({
			transport: this.plugin.settings.hermesKanbanTransport,
		}).canWriteHermesTask(this.task);
		if (readiness.allowed) {
			this.hermesAvailabilityHealth = readiness.health;
			return true;
		}
		this.hermesAvailabilityHealth = readiness.health;
		if (this.hermesActivityElements) {
			this.renderHermesAvailabilitySnapshot(
				this.hermesActivityElements.availabilityContainer,
				readiness.health,
				this.hermesActivityElements
			);
			this.applyHermesAvailabilityToActivity(this.hermesActivityElements, readiness.health);
		}
		new Notice(readiness.reason);
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
			this.hermesLiveTaskMissing = false;
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
			if (isHermesTaskNotFoundError(error, identity.id)) {
				this.applyMissingHermesTaskState(elements, identity);
				return;
			}
			tasknotesLogger.warn("Failed to load Hermes activity:", {
				category: "provider",
				operation: "load-hermes-activity",
				error,
			});
		}
	}

	private applyMissingHermesTaskState(
		elements: HermesActivityElements,
		identity: { board: string; id: string }
	): void {
		this.hermesLiveTaskMissing = true;
		const health = this.getMissingHermesTaskHealth(identity);
		this.hermesAvailabilityHealth = health;
		this.renderHermesAvailabilitySnapshot(elements.availabilityContainer, health, elements);
		this.applyHermesAvailabilityToActivity(elements, health);
	}

	private getMissingHermesTaskHealth(identity: { board: string; id: string }): HermesAvailabilityHealth {
		const base = this.hermesAvailabilityHealth ?? this.getInitialHermesAvailabilityHealth();
		return {
			...base,
			status: "degraded",
			mode: "cache-only",
			message: `This local mirror no longer has task ${identity.id} on board ${identity.board}. Cached activity is shown.`,
		};
	}

	private getCachedHermesActivityDetail(): HermesTaskDetailResponse | null {
		const snapshot = getHermesActivitySnapshotFromTask(this.plugin, this.task);
		if (!snapshot) {
			return null;
		}
		const feed = this.getCachedHermesActivityFeedFromTask();
		return {
			task: null,
			comments:
				feed && feed.comments.length > 0
					? feed.comments
					: this.hydrateCachedHermesComments(snapshot.comments),
			runs:
				feed && feed.runs.length > 0
					? feed.runs
					: this.hydrateCachedHermesRuns(snapshot.runs),
			events:
				feed && feed.events.length > 0
					? feed.events
					: this.hydrateCachedHermesEvents(snapshot.events),
		};
	}

	private getCachedHermesActivityFeedFromTask(): CachedHermesActivityFeed | null {
		const values = this.getHermesActivityIndexValues(HERMES_ACTIVITY_FIELD_KEYS.feed);
		if (values.length === 0) {
			return null;
		}

		const feed: CachedHermesActivityFeed = {
			comments: [],
			runs: [],
			events: [],
		};
		for (const value of values) {
			const frontmatter = this.getHermesActivityNoteFrontmatter(value);
			if (!isHermesEventRecord(frontmatter)) {
				continue;
			}
			const type = optionalString(frontmatter.type);
			const seed = { link: value };
			if (type === "hermes-comment") {
				feed.comments.push(this.buildCachedHermesCommentRecord(seed, frontmatter));
			} else if (type === "hermes-run") {
				feed.runs.push(this.buildCachedHermesRunRecord(seed, frontmatter));
			} else if (type === "hermes-event") {
				feed.events.push(this.buildCachedHermesEventRecord(seed, frontmatter));
			}
		}

		return feed.comments.length || feed.runs.length || feed.events.length ? feed : null;
	}

	private getHermesActivityIndexValues(key: string): string[] {
		const values = [
			...toStringList(this.task.customProperties?.[key]),
			...toStringList(this.getTaskFrontmatterValue(key)),
		];
		return Array.from(new Set(values));
	}

	private hydrateCachedHermesComments(comments: unknown[]): unknown[] {
		return comments.map((comment) => {
			if (!isHermesEventRecord(comment)) {
				return comment;
			}
			const frontmatter = this.getHermesActivityNoteFrontmatter(
				comment.link ?? comment.path ?? comment.body ?? comment.summary
			);
			if (!isHermesEventRecord(frontmatter)) {
				return comment;
			}
			const type = optionalString(frontmatter.type);
			if (type && type !== "hermes-comment") {
				return comment;
			}
			return this.buildCachedHermesCommentRecord(comment, frontmatter);
		});
	}

	private mergeHermesActivityDetailWithCache(
		detail: HermesTaskDetailResponse
	): HermesTaskDetailResponse {
		const cachedDetail = this.getCachedHermesActivityDetail();
		if (!cachedDetail) {
			return detail;
		}
		return {
			...detail,
			comments: hasHermesActivityItems(detail.comments)
				? detail.comments
				: cachedDetail.comments,
			runs: hasHermesActivityItems(detail.runs) ? detail.runs : cachedDetail.runs,
			events: hasHermesActivityItems(detail.events) ? detail.events : cachedDetail.events,
		};
	}

	private hydrateCachedHermesRuns(runs: unknown[]): unknown[] {
		return runs.map((run) => {
			if (!isHermesEventRecord(run)) {
				return run;
			}
			const frontmatter = this.getHermesActivityNoteFrontmatter(
				run.link ?? run.path ?? run.summary
			);
			if (!isHermesEventRecord(frontmatter)) {
				return run;
			}
			const type = optionalString(frontmatter.type);
			if (type && type !== "hermes-run") {
				return run;
			}
			return this.buildCachedHermesRunRecord(run, frontmatter);
		});
	}

	private hydrateCachedHermesEvents(events: unknown[]): unknown[] {
		return events.map((event) => {
			if (!isHermesEventRecord(event)) {
				return event;
			}
			const frontmatter = this.getHermesActivityNoteFrontmatter(
				event.link ?? event.path ?? event.summary ?? event.kind
			);
			if (!isHermesEventRecord(frontmatter)) {
				return event;
			}
			const type = optionalString(frontmatter.type);
			if (type && type !== "hermes-event") {
				return event;
			}
			return this.buildCachedHermesEventRecord(event, frontmatter);
		});
	}

	private getHermesActivityNoteFrontmatter(value: unknown): Record<string, unknown> | undefined {
		const path = extractHermesActivityNotePath(value);
		if (!path) {
			return undefined;
		}
		const metadataCache = this.app.metadataCache as App["metadataCache"] & {
			getCache?: (path: string) => { frontmatter?: Record<string, unknown> } | null;
			getFirstLinkpathDest?: (linkPath: string, sourcePath: string) => TFile | null;
		};
		for (const candidate of hermesActivityNotePathCandidates(path)) {
			const frontmatter = metadataCache.getCache?.(candidate)?.frontmatter;
			if (frontmatter) {
				return frontmatter;
			}
		}
		const resolvedByLink = metadataCache.getFirstLinkpathDest?.(path, this.task.path);
		if (resolvedByLink instanceof TFile) {
			return this.app.metadataCache.getFileCache(resolvedByLink)?.frontmatter;
		}
		for (const candidate of hermesActivityNotePathCandidates(path)) {
			const directFile = this.app.vault.getAbstractFileByPath(candidate);
			if (directFile instanceof TFile) {
				const frontmatter = this.app.metadataCache.getFileCache(directFile)?.frontmatter;
				if (frontmatter) {
					return frontmatter;
				}
			}
		}
		return undefined;
	}

	private getTaskFrontmatterValue(key: string): unknown {
		const metadataCache = this.app.metadataCache as App["metadataCache"] & {
			getCache?: (path: string) => { frontmatter?: Record<string, unknown> } | null;
		};
		const cachedValue = metadataCache.getCache?.(this.task.path)?.frontmatter?.[key];
		if (cachedValue !== undefined) {
			return cachedValue;
		}
		const file = this.app.vault.getAbstractFileByPath(this.task.path);
		return file instanceof TFile
			? this.app.metadataCache.getFileCache(file)?.frontmatter?.[key]
			: undefined;
	}

	private async hydrateCachedHermesCommentNoteBodies(
		renderGeneration: number,
		rerender: () => void
	): Promise<void> {
		const values = [
			...this.getHermesActivityIndexValues(HERMES_ACTIVITY_FIELD_KEYS.feed),
			...this.getHermesActivityIndexValues(HERMES_ACTIVITY_FIELD_KEYS.comments),
		];
		if (values.length === 0) {
			return;
		}

		let changed = false;
		const seen = new Set<string>();
		for (const value of values) {
			const frontmatter = this.getHermesActivityNoteFrontmatter(value);
			if (optionalString(frontmatter?.type) !== "hermes-comment") {
				continue;
			}
			const noteBody = await this.readHermesActivityNoteBody(value);
			if (!noteBody) {
				continue;
			}
			const key = extractHermesActivityNotePath(value);
			if (!key || seen.has(key)) {
				continue;
			}
			seen.add(key);
			if (this.hermesActivityNoteBodies.get(key) === noteBody) {
				continue;
			}
			this.hermesActivityNoteBodies.set(key, noteBody);
			changed = true;
		}

		if (changed && this.hermesActivityRenderGeneration === renderGeneration) {
			rerender();
		}
	}

	private async readHermesActivityNoteBody(value: unknown): Promise<string> {
		const path = extractHermesActivityNotePath(value);
		if (!path) {
			return "";
		}
		for (const candidate of hermesActivityNotePathCandidates(path)) {
			const file = this.app.vault.getAbstractFileByPath(candidate);
			if (!(file instanceof TFile)) {
				continue;
			}
			const content = await this.app.vault.read(file);
			return stripMarkdownFrontmatter(content).trim();
		}
		return "";
	}

	private buildCachedHermesRunRecord(
		run: Record<string, unknown>,
		frontmatter: Record<string, unknown>
	): Record<string, unknown> {
		const metadata = isHermesEventRecord(run.metadata) ? { ...run.metadata } : {};
		copyHermesMetadataValue(
			metadata,
			"artifacts",
			this.resolveHermesArtifactMetadataValue(frontmatter.hermesRunArtifacts ?? frontmatter.artifacts)
		);
		copyHermesMetadataValue(
			metadata,
			"changed_files",
			frontmatter.hermesRunChangedFiles ?? frontmatter.changed_files ?? frontmatter.changedFiles
		);
		copyHermesMetadataValue(metadata, "verification", frontmatter.hermesRunVerification ?? frontmatter.verification);
		copyHermesMetadataValue(
			metadata,
			"tests_run",
			frontmatter.hermesRunTestsRun ?? frontmatter.tests_run ?? frontmatter.testsRun
		);
		copyHermesMetadataValue(
			metadata,
			"tests_passed",
			frontmatter.hermesRunTestsPassed ?? frontmatter.tests_passed ?? frontmatter.testsPassed
		);

		return {
			...run,
			id: frontmatter.hermesRunId ?? frontmatter.runId ?? frontmatter.run_id ?? run.id,
			profile: frontmatter.hermesRunProfile ?? frontmatter.profile ?? run.profile,
			status: frontmatter.hermesRunStatus ?? frontmatter.status ?? run.status,
			outcome: frontmatter.hermesRunOutcome ?? frontmatter.outcome ?? run.outcome,
			summary: frontmatter.hermesRunSummary ?? frontmatter.summary ?? run.summary,
			startedAt:
				frontmatter.hermesRunStartedAt ??
				frontmatter.startedAt ??
				frontmatter.started_at ??
				run.startedAt,
			endedAt:
				frontmatter.hermesRunEndedAt ??
				frontmatter.endedAt ??
				frontmatter.ended_at ??
				run.endedAt,
			metadata: Object.keys(metadata).length > 0 ? metadata : run.metadata,
		};
	}

	private resolveHermesArtifactMetadataValue(value: unknown): unknown {
		const values = toStringList(value);
		if (values.length === 0) {
			return value;
		}
		return values.map((item) => this.resolveHermesArtifactTarget(item) ?? item);
	}

	private resolveHermesArtifactTarget(value: string): string | null {
		const frontmatter = this.getHermesActivityNoteFrontmatter(value);
		if (!isHermesEventRecord(frontmatter) || optionalString(frontmatter.type) !== "hermes-artifact") {
			return null;
		}
		return (
			optionalString(frontmatter.hermesArtifactStoredPath) ||
			optionalString(frontmatter.hermesArtifactPath) ||
			optionalString(frontmatter.hermesArtifactUrl) ||
			null
		);
	}

	private buildCachedHermesCommentRecord(
		comment: Record<string, unknown>,
		frontmatter: Record<string, unknown>
	): Record<string, unknown> {
		const noteBody = this.getCachedHermesActivityNoteBody(
			comment.link ?? comment.path ?? comment.body ?? comment.summary
		);
		return {
			...comment,
			id:
				frontmatter.hermesCommentId ??
				frontmatter.commentId ??
				frontmatter.comment_id ??
				comment.id,
			author:
				frontmatter.hermesCommentAuthor ??
				frontmatter.author ??
				comment.author ??
				"Hermes",
			body:
				frontmatter.hermesCommentBody ??
				noteBody ??
				frontmatter.hermesCommentSummary ??
				frontmatter.summary ??
				comment.body,
			createdAt:
				frontmatter.hermesCommentCreatedAt ??
				frontmatter.createdAt ??
				frontmatter.created_at ??
				comment.createdAt,
		};
	}

	private getCachedHermesActivityNoteBody(value: unknown): string | undefined {
		const path = extractHermesActivityNotePath(value);
		return path ? this.hermesActivityNoteBodies.get(path) : undefined;
	}

	private buildCachedHermesEventRecord(
		event: Record<string, unknown>,
		frontmatter: Record<string, unknown>
	): Record<string, unknown> {
		return {
			...event,
			id:
				frontmatter.hermesEventId ??
				frontmatter.eventId ??
				frontmatter.event_id ??
				event.id,
			kind:
				frontmatter.hermesEventKind ??
				frontmatter.kind ??
				event.kind ??
				"summary",
			payload:
				event.payload ??
				frontmatter.hermesEventSummary ??
				frontmatter.summary ??
				frontmatter.hermesEventLabel,
			createdAt:
				frontmatter.hermesEventCreatedAt ??
				frontmatter.createdAt ??
				frontmatter.created_at ??
				event.createdAt,
			runId:
				frontmatter.hermesRunId ??
				frontmatter.runId ??
				frontmatter.run_id ??
				event.runId,
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
		const renderGeneration = ++this.hermesActivityRenderGeneration;
		const { visibleComponents } = elements;
		const effectiveDetail = this.mergeHermesActivityDetailWithCache(detail);
		const comments = visibleComponents.comments
			? normalizeHermesComments(effectiveDetail.comments ?? [])
			: [];
		const runs = visibleComponents.runs
			? normalizeHermesRuns(effectiveDetail.runs ?? [])
			: [];
		this.renderHermesReviewThread(
			elements.threadList,
			comments,
			effectiveDetail,
			runs,
			this.buildHermesStatusUpdateCards(effectiveDetail, visibleComponents),
			visibleComponents
		);
		void this.hydrateCachedHermesCommentNoteBodies(
			renderGeneration,
			() => this.renderHermesActivityDetail(elements, detail)
		);
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
			this.renderHermesPinnedReviewCommentCard(listEl, pinned, visibleComponents);
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
		this.renderHermesActivityCardItem(listEl, card, visibleComponents);
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
		const timestamp = formatHermesActivityTimestamp(comment.createdAt);
		if (!isStructured) {
			this.renderHermesPlainCommentCard(listEl, comment, timestamp);
			return;
		}

		const rendered = this.createHermesActivityTaskCard(listEl, {
			cardClasses: [
				"tn-task-modal__hermes-thread-card",
				"tn-task-modal__hermes-thread-card--structured",
				`tn-task-modal__hermes-thread-card--${parsedComment.severity}`,
			],
		});
		const title = this.hermesStructuredCommentTitle(parsedComment);
		const childTaskIds = this.hermesCommentChildTaskIds(comment, parsedComment);
		const metadataOptions: HermesActivityMetadataOptions = {
			agent: comment.author,
			timestamp: comment.createdAt,
			fallbackMeta: timestamp,
			activityLabel: title,
		};
		if (childTaskIds.length > 0) {
			this.renderHermesCommentChildTaskToggle(
				rendered.badgesEl,
				rendered.cardEl,
				childTaskIds
			);
		}

		this.renderStructuredHermesThreadComment(
			rendered.cardEl,
			rendered.contentEl,
			parsedComment,
			[comment.author, timestamp].filter(Boolean).join(" - "),
			visibleComponents,
			childTaskIds,
			metadataOptions
		);
	}

	private renderHermesPlainCommentCard(
		listEl: HTMLElement,
		comment: HermesCommentCard,
		timestamp: string
	): void {
		const rendered = this.createHermesCommentCard(listEl, {
			cardClasses: ["tn-task-modal__hermes-thread-card"],
			agent: comment.author,
			timestamp,
			pinned: false,
		});
		rendered.bodyEl.textContent = comment.body;
		this.attachHermesStructuredThreadDetailModal(rendered.cardEl, {
			title: "Comment",
			meta: [comment.author, timestamp].filter(Boolean).join(" - "),
			body: comment.body,
		});
	}

	private renderHermesPinnedReviewCommentCard(
		listEl: HTMLElement,
		card: HermesActivityCard,
		visibleComponents: HermesActivityComponentVisibility
	): void {
		const visibleCard = this.filterHermesActivityCard(card, visibleComponents);
		const rendered = this.createHermesCommentCard(listEl, {
			cardClasses: [
				"tn-task-modal__hermes-review-card--pinned",
				visibleCard.raw || visibleCard.details?.length || visibleCard.actions?.length
					? "tn-task-modal__hermes-thread-card--openable"
					: "",
			],
			agent: visibleCard.agent,
			timestamp: formatHermesActivityTimestamp(visibleCard.timestamp ?? visibleCard.sortTimestamp) || visibleCard.meta,
			pinned: true,
		});
		const previewBody = this.resolveHermesActivityCardPreviewBody(visibleCard);
		rendered.bodyEl.textContent = previewBody ?? visibleCard.title;
		this.attachHermesActivityCardDetailModal(rendered.cardEl, visibleCard);
	}

	private createHermesCommentCard(
		listEl: HTMLElement,
		options: {
			cardClasses?: string[];
			agent?: string;
			timestamp?: string;
			pinned?: boolean;
		}
	): { cardEl: HTMLElement; contentEl: HTMLElement; bodyEl: HTMLElement } {
		const itemEl = listEl.createDiv({
			cls: "task-project-item task-project-item--task-card tn-task-modal__hermes-activity-item",
		});
		const cardHostEl = itemEl.createDiv({
			cls: "task-project-card-host tn-task-modal__hermes-activity-card-host",
		});
		const cardEl = cardHostEl.createDiv({
			cls: [
				"task-card",
				"tn-task-modal__hermes-comment-card",
				...(options.cardClasses ?? []),
			]
				.filter(Boolean)
				.join(" "),
		});
		const rowEl = cardEl.createDiv({ cls: "tn-task-modal__hermes-comment-row" });
		const avatarEl = rowEl.createDiv({
			cls: "tn-task-modal__hermes-comment-avatar",
			attr: { "aria-hidden": "true" },
		});
		setIcon(avatarEl, "user");
		const contentEl = rowEl.createDiv({ cls: "tn-task-modal__hermes-comment-content" });
		this.renderHermesCommentMetadata(contentEl, {
			agent: options.agent,
			timestamp: options.timestamp,
			pinned: options.pinned,
		});
		const bodyEl = contentEl.createDiv({
			cls: "tn-task-modal__hermes-comment-body tn-task-modal__hermes-thread-body",
		});
		return { cardEl, contentEl, bodyEl };
	}

	private renderHermesCommentMetadata(
		contentEl: HTMLElement,
		options: { agent?: string; timestamp?: string; pinned?: boolean }
	): void {
		const identity = getHermesTaskIdentity(this.task);
		const metadataEl = contentEl.createDiv({ cls: "tn-task-modal__hermes-comment-meta" });
		if (identity?.board) {
			metadataEl.createSpan({
				cls: "task-card__metadata-property task-card__metadata-property--projects",
				text: `+Hermes/${identity.board}`,
			});
		}
		if (options.agent) {
			const contextsEl = metadataEl.createSpan({
				cls: "task-card__metadata-property task-card__metadata-property--contexts",
			});
			contextsEl.createSpan({
				cls: "context-tag context-tag--color-1",
				text: `@${options.agent.replace(/^@/, "")}`,
			});
		}
		if (options.timestamp) {
			metadataEl.createSpan({
				cls: "task-card__metadata-item tn-task-modal__hermes-activity-time",
				text: options.timestamp,
			});
		}
		if (options.pinned) {
			const pinnedEl = metadataEl.createSpan({
				cls: "tn-task-modal__hermes-comment-pin",
				text: "Pinned",
			});
			pinnedEl.setAttribute("aria-label", "Pinned review card");
		}
	}

	private renderStructuredHermesThreadComment(
		cardEl: HTMLElement,
		contentEl: HTMLElement,
		model: HermesCommentPresentationModel,
		meta: string,
		visibleComponents: HermesActivityComponentVisibility,
		childTaskIds: string[],
		metadataOptions: HermesActivityMetadataOptions
	): void {
		const summaryEl = contentEl.createDiv({ cls: "tn-task-modal__hermes-thread-structured" });
		const title = this.hermesStructuredCommentTitle(model);
		if (model.summary) {
			summaryEl.createDiv({
				cls: "tn-task-modal__hermes-activity-body tn-task-modal__hermes-thread-body tn-task-modal__hermes-thread-body--structured",
				text: model.summary,
			});
		}
		this.renderHermesActivityMetadata(summaryEl, metadataOptions);
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
			this.filterHermesActivityActions(model.actions, visibleComponents, {
				excludedTaskIds: childTaskIds,
			})
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
		const toggleEl = headerEl.createDiv({
			cls: "tn-task-modal__hermes-child-toggle task-card__blocking-toggle is-visible",
			attr: {
				role: "button",
				tabindex: "0",
				"aria-expanded": "false",
				"aria-label": toggleLabel,
				"data-tn-no-drag": "true",
				draggable: "false",
			},
		});
		toggleEl.dataset.count = String(childTaskIds.length);
		setIcon(toggleEl, "git-branch");
		setTooltip(toggleEl, toggleLabel, { placement: "top" });
		const activate = (event: Event) => {
			event.preventDefault();
			event.stopPropagation();
			void this.toggleHermesCommentChildTasks(cardEl, toggleEl, childTaskIds);
		};
		toggleEl.addEventListener("click", activate);
		toggleEl.addEventListener("keydown", (event) => {
			if (event.key !== "Enter" && event.key !== " ") {
				return;
			}
			activate(event);
		});
	}

	private getHermesNativeChildTaskPaths(): string[] {
		const dependencies = Array.isArray(this.task.blockedBy) ? this.task.blockedBy : [];
		const paths = dependencies
			.map((dependency) =>
				resolveDependencyEntry(this.app, this.task.path, dependency)?.path ?? ""
			)
			.filter((path) => path.length > 0);
		return Array.from(new Set(paths));
	}

	private renderHermesNativeChildTaskToggle(
		headerEl: HTMLElement,
		cardEl: HTMLElement,
		childTaskPaths: string[]
	): void {
		const toggleLabel = this.hermesChildTaskToggleLabel(childTaskPaths.length, false);
		const toggleEl = headerEl.createEl("button", {
			cls: "tn-task-modal__hermes-child-toggle task-card__blocking-toggle is-visible",
			attr: {
				type: "button",
				"aria-expanded": "false",
				"aria-label": toggleLabel,
				"data-tn-no-drag": "true",
				draggable: "false",
			},
		});
		toggleEl.dataset.count = String(childTaskPaths.length);
		setIcon(toggleEl, "git-branch");
		setTooltip(toggleEl, toggleLabel, { placement: "top" });
		const activate = (event: Event) => {
			event.preventDefault();
			event.stopPropagation();
			void this.toggleHermesNativeChildTasks(cardEl, toggleEl, childTaskPaths);
		};
		toggleEl.addEventListener("click", activate);
		toggleEl.addEventListener("keydown", (event) => {
			if (event.key !== "Enter" && event.key !== " ") {
				return;
			}
			activate(event);
		});
	}

	private async toggleHermesNativeChildTasks(
		cardEl: HTMLElement,
		toggleEl: HTMLElement,
		childTaskPaths: string[]
	): Promise<void> {
		const existing = this.findHermesCommentChildTaskContainer(cardEl);
		if (existing) {
			existing.remove();
			this.updateHermesCommentChildTaskToggle(toggleEl, childTaskPaths.length, false);
			return;
		}

		this.updateHermesCommentChildTaskToggle(toggleEl, childTaskPaths.length, true);
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
			const childTasks = await this.resolveHermesChildTasksByPath(childTaskPaths);
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
			tasknotesLogger.warn("Failed to load Hermes dependency child tasks:", {
				category: "provider",
				operation: "load-hermes-native-child-tasks",
				details: { taskPaths: childTaskPaths },
				error,
			});
			loadingEl.textContent = "Could not load child task notes.";
		}
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
			const isHTMLElement =
				child.instanceOf?.(HTMLElement) ?? HTMLElement.prototype.isPrototypeOf(child);
			if (
				isHTMLElement &&
				child.classList.contains("tn-task-modal__hermes-child-tasks")
			) {
				return child as HTMLElement;
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
				? await getTaskInfoFromNoteFirst(this.plugin, canonicalHermesTaskPath(board, taskId))
				: null;
			if (directTask) {
				resolved.set(taskId, directTask);
			} else {
				missingIds.push(taskId);
			}
		}

		if (missingIds.length > 0) {
			const allTasks = await getAllTasksFromNoteFirst(this.plugin);
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

	private async resolveHermesChildTasksByPath(taskPaths: string[]): Promise<TaskInfo[]> {
		const uniquePaths = Array.from(new Set(taskPaths.filter(Boolean)));
		const tasks: TaskInfo[] = [];
		for (const path of uniquePaths) {
			const task = await getTaskInfoFromNoteFirst(this.plugin, path);
			if (task) {
				tasks.push(task);
			}
		}
		return tasks;
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
			const timestamp = formatHermesActivityTimestamp(reviewComment.createdAt);
			return this.buildHermesReviewCardFromText(reviewComment.body, {
				sourceId: reviewComment.id ?? reviewComment.body,
				meta: [reviewComment.author, timestamp].filter(Boolean).join(" - "),
				agent: reviewComment.author,
				timestamp: reviewComment.createdAt,
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
				agent: latestRun?.profile || normalizeHermesAssignee(this.contexts) || undefined,
				timestamp: latestRun?.endedAt ?? latestRun?.startedAt,
				status: taskStatus === "blocked" ? "Blocked" : "Review required",
				metadata: latestRun?.metadata ?? detail.task?.metadata ?? undefined,
			});
		}
		return null;
	}

	private buildHermesReviewCardFromText(
		text: string,
		options: {
			sourceId?: string;
			meta?: string;
			agent?: string;
			timestamp?: string | number;
			status: string;
			metadata?: Record<string, unknown>;
		}
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
				agent: options.agent,
				timestamp: options.timestamp,
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
		const summary =
			optionalString(payload.verdict) ||
			optionalString(payload.summary) ||
			optionalString(payload.result) ||
			optionalString(payload.outcome) ||
			optionalString(payload.error) ||
			optionalString(payload.feature_commit_summary);
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
		visibleComponents: HermesActivityComponentVisibility,
		options: { excludedTaskIds?: string[] } = {}
	): HermesActivityAction[] {
		const excludedTaskIds = new Set(
			(options.excludedTaskIds ?? []).map((taskId) => normalizeHermesTaskId(taskId))
		);
		return actions.filter((action) => {
			if (!visibleComponents.artifacts && action.type === "artifact") {
				return false;
			}
			if (
				action.type === "task" &&
				excludedTaskIds.has(normalizeHermesTaskId(action.value))
			) {
				return false;
			}
			return true;
		});
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
		if (
			visibleCard.variant === "run" &&
			visibleCard.actions?.some((action) => action.type === "artifact")
		) {
			this.renderHermesArtifactTray(listEl, visibleCard.actions);
			return;
		}
		const rendered = this.createHermesActivityTaskCard(listEl, {
			cardClasses: [
				"task-card--has-details",
				"tn-task-modal__hermes-activity-card",
				visibleCard.variant === "pinned" ? "tn-task-modal__hermes-review-card--pinned" : "",
				visibleCard.variant === "run" ? "tn-task-modal__hermes-run-card" : "",
				visibleCard.variant === "status" ? "tn-task-modal__hermes-activity-card--status" : "",
			],
		});
		const previewBody = this.resolveHermesActivityCardPreviewBody(visibleCard);
		if (previewBody) {
			rendered.contentEl.createDiv({
				cls: "tn-task-modal__hermes-activity-body",
				text: previewBody,
			});
		}
		this.renderHermesActivityMetadata(rendered.contentEl, {
			agent: visibleCard.agent,
			timestamp: visibleCard.timestamp ?? visibleCard.sortTimestamp,
			fallbackMeta: visibleCard.meta,
			activityLabel: this.hermesActivityMetadataLabel(visibleCard),
			pinned: visibleCard.variant === "pinned",
		});

		if (visibleCard.statusLabel) {
			const signalsDrawer = this.createHermesActivityDrawer(
				rendered.cardEl,
				"signals",
				"Run signals"
			);
			this.renderHermesActivitySignals(signalsDrawer, visibleCard);
			this.renderHermesActivityStatusToggle(
				rendered.badgesEl,
				rendered.cardEl,
				visibleCard
			);
		}

		if (visibleCard.variant === "run") {
			const childTaskPaths = this.getHermesNativeChildTaskPaths();
			if (childTaskPaths.length > 0) {
				this.renderHermesNativeChildTaskToggle(
					rendered.badgesEl,
					rendered.cardEl,
					childTaskPaths
				);
			}
		}

		if (visibleCard.details?.length || visibleCard.raw) {
			const detailsDrawer = this.createHermesActivityDrawer(
				rendered.cardEl,
				"details",
				"Run details"
			);
			if (visibleCard.details?.length) {
				this.renderHermesActivityDetails(detailsDrawer, visibleCard.details);
			}
			if (visibleCard.raw) {
				this.renderHermesRawToggle(detailsDrawer, visibleCard.raw);
			}
			this.renderHermesActivityDrawerToggle(rendered.badgesEl, rendered.cardEl, {
				drawerName: "details",
				iconName: "terminal",
				label: "run details",
				count: visibleCard.details?.length,
			});
		}

		if (visibleCard.actions?.length) {
			const actionsDrawer = this.createHermesActivityDrawer(
				rendered.cardEl,
				"actions",
				"Run artifacts"
			);
			this.renderHermesActivityActions(actionsDrawer, visibleCard.actions);
			this.renderHermesActivityDrawerToggle(rendered.badgesEl, rendered.cardEl, {
				drawerName: "actions",
				iconName: "paperclip",
				label: "artifacts",
				count: visibleCard.actions.length,
			});
		}
		this.attachHermesActivityCardDetailModal(rendered.cardEl, visibleCard);
	}

	private renderHermesArtifactTray(listEl: HTMLElement, actions: HermesActivityAction[]): void {
		const artifactActions = actions.filter((action) => action.type === "artifact");
		if (artifactActions.length === 0) {
			return;
		}

		const itemEl = listEl.createDiv({
			cls: "task-project-item tn-task-modal__hermes-activity-item tn-task-modal__hermes-artifact-tray-item",
		});
		const trayEl = itemEl.createDiv({
			cls: "tn-task-modal__hermes-artifact-tray",
			attr: { "aria-label": "Linked artifacts tray" },
		});
		const headerEl = trayEl.createDiv({ cls: "tn-task-modal__hermes-artifact-tray-header" });
		const titleGroupEl = headerEl.createDiv({ cls: "tn-task-modal__hermes-artifact-tray-heading" });
		titleGroupEl.createDiv({
			cls: "tn-task-modal__hermes-artifact-tray-title",
			text: "Artifacts",
		});
		const artifactNoun = artifactActions.length === 1 ? "artifact" : "artifacts";
		titleGroupEl.createDiv({
			cls: "tn-task-modal__hermes-artifact-tray-summary",
			text: `${artifactActions.length} linked ${artifactNoun}`,
		});

		const listContainerEl = trayEl.createDiv({ cls: "tn-task-modal__hermes-artifact-tray-list" });
		for (const action of artifactActions) {
			this.renderHermesArtifactTrayRow(listContainerEl, action);
		}
	}

	private renderHermesArtifactTrayRow(container: HTMLElement, action: HermesActivityAction): void {
		const rowEl = container.createDiv({ cls: "tn-task-modal__hermes-artifact-row" });
		const iconEl = rowEl.createSpan({
			cls: "tn-task-modal__hermes-artifact-row-icon",
			attr: { "aria-hidden": "true" },
		});
		setIcon(iconEl, "file-text");

		const textEl = rowEl.createSpan({ cls: "tn-task-modal__hermes-artifact-row-text" });
		textEl.createSpan({
			cls: "tn-task-modal__hermes-artifact-row-title",
			text: this.hermesArtifactActionTitle(action),
		});
		textEl.createSpan({
			cls: "tn-task-modal__hermes-artifact-row-subtitle",
			text: action.value,
		});

		const buttonEl = rowEl.createEl("button", {
			cls: "tn-task-modal__hermes-artifact-open",
			text: action.label,
			attr: {
				type: "button",
				"aria-label": action.label,
			},
		});
		buttonEl.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			void this.handleHermesActivityAction(action);
		});
	}

	private hermesArtifactActionTitle(action: HermesActivityAction): string {
		return action.label.replace(/^Open\s+/i, "").trim() || action.value;
	}

	private createHermesActivityDrawer(
		cardEl: HTMLElement,
		drawerName: string,
		label: string
	): HTMLElement {
		const drawerEl = cardEl.createDiv({
			cls: "tn-task-modal__hermes-activity-drawer",
			attr: {
				"data-drawer": drawerName,
				"aria-label": label,
			},
		});
		const panelEl = drawerEl.createDiv({
			cls: "tn-task-modal__hermes-activity-drawer-panel",
		});
		for (const eventName of ["click", "dblclick", "contextmenu"]) {
			panelEl.addEventListener(eventName, (event) => event.stopPropagation());
		}
		return panelEl;
	}

	private renderHermesActivitySignals(container: HTMLElement, card: HermesActivityCard): void {
		container.createDiv({
			cls: "tn-task-modal__hermes-activity-drawer-title",
			text: "Signals",
		});
		const signals = card.signals?.length
			? card.signals
			: [
					{
						label: card.statusLabel ?? "Signal",
						time: formatHermesActivityTimestamp(card.timestamp ?? card.sortTimestamp) || card.meta,
						variant: card.statusVariant,
					},
				];
		for (const signal of signals) {
			this.renderHermesActivitySignalRow(container, signal);
		}
		const summary = card.statusSummary?.trim();
		const body = card.body?.trim();
		if (!card.signals?.length && summary && summary !== body && summary !== card.statusLabel) {
			this.renderHermesActivitySignalRow(container, {
				label: summary,
				variant: card.statusVariant,
			});
		}
	}

	private renderHermesActivitySignalRow(
		container: HTMLElement,
		options: {
			label: string;
			time?: string;
			variant?: "success" | "warning" | "danger" | "muted";
		}
	): void {
		const rowEl = container.createDiv({ cls: "tn-task-modal__hermes-signal-row" });
		rowEl.createSpan({
			cls: [
				"tn-task-modal__hermes-signal-dot",
				options.variant ? `tn-task-modal__hermes-signal-dot--${options.variant}` : "",
			]
				.filter(Boolean)
				.join(" "),
		});
		rowEl.createSpan({
			cls: "tn-task-modal__hermes-signal-label",
			text: options.label,
		});
		if (options.time) {
			rowEl.createSpan({
				cls: "tn-task-modal__hermes-signal-time",
				text: options.time,
			});
		}
	}

	private renderHermesActivityStatusToggle(
		badgesEl: HTMLElement,
		cardEl: HTMLElement,
		card: HermesActivityCard
	): void {
		const toggleEl = this.renderHermesActivityDrawerToggle(badgesEl, cardEl, {
			drawerName: "signals",
			label: "run signals",
			statusVariant: card.statusVariant,
		});
		toggleEl.addClass("tn-task-modal__hermes-status-toggle");
	}

	private renderHermesActivityDrawerToggle(
		badgesEl: HTMLElement,
		cardEl: HTMLElement,
		options: {
			drawerName: string;
			iconName?: string;
			label: string;
			count?: number;
			statusVariant?: "success" | "warning" | "danger" | "muted";
		}
	): HTMLElement {
		const drawerEl = cardEl.querySelector<HTMLElement>(
			`.tn-task-modal__hermes-activity-drawer[data-drawer="${options.drawerName}"]`
		);
		const label = this.hermesActivityDrawerToggleLabel(options.label, false);
		const toggleEl = badgesEl.createEl("button", {
			cls: "tn-task-modal__hermes-drawer-toggle task-card__badge-toggle is-visible",
			attr: {
				type: "button",
				"aria-expanded": "false",
				"aria-label": label,
				"data-tn-no-drag": "true",
				draggable: "false",
			},
		});
		toggleEl.dataset.drawerToggle = options.drawerName;
		if (typeof options.count === "number") {
			toggleEl.dataset.count = String(options.count);
		}
		if (options.iconName) {
			setIcon(toggleEl, options.iconName);
		} else {
			toggleEl.createSpan({
				cls: [
					"task-card__status-dot",
					"tn-task-modal__hermes-run-status-dot",
					options.statusVariant
						? `tn-task-modal__hermes-run-status-dot--${options.statusVariant}`
						: "",
				]
					.filter(Boolean)
					.join(" "),
			});
		}
		setTooltip(toggleEl, label, { placement: "top" });

		const activate = (event: Event) => {
			event.preventDefault();
			event.stopPropagation();
			if (!drawerEl) {
				return;
			}
			const willOpen = !drawerEl.classList.contains("is-open");
			this.closeHermesActivityDrawers(cardEl, toggleEl);
			drawerEl.classList.toggle("is-open", willOpen);
			toggleEl.classList.toggle("is-active", willOpen);
			toggleEl.setAttribute("aria-expanded", String(willOpen));
			const nextLabel = this.hermesActivityDrawerToggleLabel(options.label, willOpen);
			toggleEl.setAttribute("aria-label", nextLabel);
			setTooltip(toggleEl, nextLabel, { placement: "top" });
		};
		toggleEl.addEventListener("click", activate);
		toggleEl.addEventListener("keydown", (event) => {
			if (event.key !== "Enter" && event.key !== " ") {
				return;
			}
			activate(event);
		});
		return toggleEl;
	}

	private closeHermesActivityDrawers(cardEl: HTMLElement, exceptToggle?: HTMLElement): void {
		for (const drawerEl of Array.from(
			cardEl.querySelectorAll<HTMLElement>(".tn-task-modal__hermes-activity-drawer.is-open")
		)) {
			drawerEl.removeClass("is-open");
		}
		for (const toggleEl of Array.from(
			cardEl.querySelectorAll<HTMLElement>(".tn-task-modal__hermes-drawer-toggle")
		)) {
			if (toggleEl === exceptToggle) {
				continue;
			}
			toggleEl.removeClass("is-active");
			toggleEl.setAttribute("aria-expanded", "false");
			const drawerLabel = toggleEl.classList.contains("tn-task-modal__hermes-status-toggle")
				? "run signals"
				: toggleEl.dataset.drawerToggle === "details"
					? "run details"
					: "artifacts";
			const nextLabel = this.hermesActivityDrawerToggleLabel(drawerLabel, false);
			toggleEl.setAttribute("aria-label", nextLabel);
			setTooltip(toggleEl, nextLabel, { placement: "top" });
		}
	}

	private hermesActivityDrawerToggleLabel(label: string, expanded: boolean): string {
		return `${expanded ? "Hide" : "Show"} ${label}`;
	}

	private renderHermesActivityMetadata(
		contentEl: HTMLElement,
		options: HermesActivityMetadataOptions
	): HTMLElement | null {
		const identity = getHermesTaskIdentity(this.task);
		const timestamp = formatHermesActivityTimestamp(options.timestamp);
		const fallbackMeta = options.fallbackMeta?.trim();
		const showFallbackMeta = Boolean(fallbackMeta && fallbackMeta !== timestamp);
		const activityLabel = options.activityLabel?.trim();
		const hasMetadata = Boolean(
			identity?.board ||
				options.agent ||
				timestamp ||
				showFallbackMeta ||
				activityLabel ||
				options.pinned ||
				options.statusLabel
		);
		if (!hasMetadata) {
			return null;
		}

		const metadataEl = contentEl.createDiv({ cls: "task-card__metadata" });
		if (identity?.board) {
			metadataEl.createSpan({
				cls: "task-card__metadata-property task-card__metadata-property--projects",
				text: `+Hermes/${identity.board}`,
			});
		}

		if (options.agent) {
			const contextsEl = metadataEl.createSpan({
				cls: "task-card__metadata-property task-card__metadata-property--contexts",
			});
			contextsEl.createSpan({
				cls: "context-tag context-tag--color-1",
				text: `@${options.agent.replace(/^@/, "")}`,
			});
		}

		if (timestamp || showFallbackMeta) {
			metadataEl.createSpan({
				cls: "task-card__metadata-item tn-task-modal__hermes-activity-time",
				text: timestamp || fallbackMeta,
			});
		}

		if (activityLabel) {
			metadataEl.createSpan({
				cls: "task-card__metadata-pill tn-task-modal__hermes-activity-label",
				text: activityLabel,
			});
		}

		if (options.pinned) {
			const labelEl = metadataEl.createSpan({
				cls: "task-card__metadata-pill tn-task-modal__hermes-pinned-label",
				text: "Pinned",
			});
			labelEl.setAttribute("aria-label", "Pinned review card");
		}

		if (options.statusLabel) {
			metadataEl.createSpan({
				cls: [
					"task-card__metadata-pill",
					"tn-task-modal__hermes-status-pill",
					`tn-task-modal__hermes-status-pill--${options.statusVariant ?? "muted"}`,
				].join(" "),
				text: options.statusLabel,
			});
		}
		return metadataEl;
	}

	private hermesActivityMetadataLabel(card: HermesActivityCard): string | undefined {
		if (card.variant !== "pinned") {
			return undefined;
		}
		const title = card.title.trim();
		const body = card.body?.trim();
		return title && title !== body ? title : undefined;
	}

	private resolveHermesActivityCardPreviewBody(card: HermesActivityCard): string | undefined {
		const parts: string[] = [];
		if (card.variant === "status" && card.statusSummary?.trim()) {
			parts.push(card.statusSummary.trim());
		}
		if (card.body?.trim() && !parts.includes(card.body.trim())) {
			parts.push(card.body.trim());
		}
		if (parts.length === 0 && card.variant === "status") {
			const fallback = (card.fullTitle ?? card.title).trim();
			if (fallback && fallback !== card.statusLabel) {
				parts.push(fallback);
			}
		}
		return parts.length > 0 ? parts.join("\n\n") : undefined;
	}

	private createHermesActivityTaskCard(
		listEl: HTMLElement,
		options: { cardClasses?: string[] } = {}
	): { cardEl: HTMLElement; contentEl: HTMLElement; badgesEl: HTMLElement } {
		const itemEl = listEl.createDiv({
			cls: "task-project-item task-project-item--task-card tn-task-modal__hermes-activity-item",
		});
		const cardHostEl = itemEl.createDiv({
			cls: "task-project-card-host tn-task-modal__hermes-activity-card-host",
		});
		const cardEl = cardHostEl.createDiv({
			cls: [
				"task-card",
				"tn-task-modal__hermes-activity-card",
				...(options.cardClasses ?? []),
			]
				.filter(Boolean)
				.join(" "),
		});
		const mainRowEl = cardEl.createDiv({ cls: "task-card__main-row" });
		const contentEl = mainRowEl.createDiv({ cls: "task-card__content" });
		const badgesEl = mainRowEl.createDiv({ cls: "task-card__badges" });
		return { cardEl, contentEl, badgesEl };
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
		const events = normalizeHermesEvents(detail.events ?? []);
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
					agent: run.profile,
					timestamp: run.endedAt ?? run.startedAt,
					details: this.hermesRunDetails(run),
					actions: run.metadata ? extractHermesEventActions(run.metadata) : undefined,
					body: fullTitle,
					variant: "run",
					sourceId: run.id,
					signals: this.hermesRunSignals(run, events),
					sortTimestamp: run.endedAt ?? run.startedAt,
					statusLabel: state.label,
					statusSummary: fullTitle,
					statusVariant: state.variant,
				};
			});
	}

	private hermesRunSignals(
		run: HermesRunCard,
		events: HermesEventCard[]
	): HermesActivitySignal[] {
		const signals: HermesActivitySignal[] = [];
		const addSignal = (signal: HermesActivitySignal) => {
			const key = `${signal.label.toLowerCase()}:${signal.time ?? ""}`;
			if (signals.some((item) => `${item.label.toLowerCase()}:${item.time ?? ""}` === key)) {
				return;
			}
			signals.push(signal);
		};
		for (const event of events) {
			if (/heartbeat|spawn/i.test(event.kind)) {
				continue;
			}
			if (run.id && event.runId && event.runId !== run.id) {
				continue;
			}
			if (!event.runId && !isHermesRunLifecycleEvent(event)) {
				continue;
			}
			const card = formatHermesEventCard(event);
			const label = card.statusSummary
				? `${card.statusLabel}: ${card.statusSummary}`
				: card.statusLabel ?? formatHermesStatusEventLabel(event.kind);
			addSignal({
				label,
				time: formatHermesActivityTimestamp(event.createdAt),
				variant: card.statusVariant,
			});
		}
		const state = this.hermesRunStateLabel(run);
		addSignal({
			label: state.label,
			time: formatHermesActivityTimestamp(run.endedAt ?? run.startedAt),
			variant: state.variant,
		});
		return signals.slice(-4);
	}

	private hermesRunDetails(run: HermesRunCard): HermesActivityDetail[] {
		const details: HermesActivityDetail[] = [
			{ label: "Verification", value: this.hermesVerificationLabel(run) },
		];
		const metadata = run.metadata ?? {};
		for (const key of ["changed_files", "artifacts", "tests_run", "tests_passed", "verification"]) {
			const value = metadata[key];
			if (isEmptyHermesEventPayloadValue(value)) {
				continue;
			}
			if (details.some((detail) => detail.label === formatHermesEventFieldLabel(key))) {
				continue;
			}
			details.push({
				label: key === "tests_run" ? "Tests run" : formatHermesEventFieldLabel(key),
				value: summarizeHermesEventPayloadValue(value, key),
			});
		}
		return details;
	}

	private buildHermesStatusUpdateCards(
		detail: HermesTaskDetailResponse,
		visibleComponents: HermesActivityComponentVisibility
	): HermesActivityCard[] {
		const runCards = visibleComponents.runs ? this.buildHermesRunHistoryCards(detail) : [];
		if (runCards.length > 0) {
			return runCards;
		}
		return visibleComponents.events ? this.buildHermesEventCards(detail) : [];
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
		const specialRegexChars = new Set([".", "*", "+", "?", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\"]);
		const escapedHeading = [...heading]
			.map((char) => (specialRegexChars.has(char) ? `\\${char}` : char))
			.join("");
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

		if (!(await this.ensureHermesWriteAvailable())) {
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
			const refreshed = await getTaskInfoFromNoteFirst(this.plugin, updatedTask.path);
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

				const refreshed = await getTaskInfoFromNoteFirst(this.plugin, updatedTask.path);
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

		if (!(await this.ensureHermesWriteAvailable())) {
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
			getTaskInfo: (path) => getTaskInfoFromNoteFirst(this.plugin, path),
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
