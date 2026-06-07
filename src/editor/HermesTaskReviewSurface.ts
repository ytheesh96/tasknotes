import { Notice, setIcon, setTooltip } from "obsidian";
import type TaskNotesPlugin from "../main";
import type { TaskInfo } from "../types";
import {
	HermesKanbanApiClient,
	getHermesTaskIdentity,
	type HermesTaskIdentity,
} from "../hermes/hermesApiClient";
import { parseHermesComment } from "../hermes/hermesCommentParser";

interface HermesTaskReviewSurfaceOptions {
	plugin: TaskNotesPlugin;
	task: TaskInfo;
	apiClient?: Pick<HermesKanbanApiClient, "addComment" | "updateTask"> | null;
}

type ButtonTone = "primary" | "secondary" | "danger";

interface ReviewAction {
	id: string;
	label: string;
	icon: string;
	tone?: ButtonTone;
	disabled?: string | null;
	onClick: () => Promise<void> | void;
}

interface ActivityRow {
	label: string;
	text: string;
	kind: "comment" | "run" | "event";
}

const HIGH_SIGNAL_EVENT_PATTERN =
	/(review|required|blocked|complete|completed|failed|failure|error|commit|push|test|build|verify|obsidian|handoff|comment)/i;
const LOW_SIGNAL_EVENT_PATTERN = /^(heartbeat|claimed|spawned|status churn)$/i;
const HERMES_WORKTREE_KEYS = ["workspace_path", "workspacePath", "hermesWorkspacePath"];
const HERMES_BRANCH_KEYS = ["branch_name", "branchName", "hermesBranchName"];
const HERMES_COMMIT_KEYS = ["commit", "commit_sha", "commitSha", "hermesCommit"];
const CHANGED_FILE_KEYS = [
	"changed_files",
	"changedFiles",
	"hermesChangedFiles",
	"hermesActivityChangedFiles",
	"hermesRunChangedFiles",
];
const COMMENT_KEYS = ["comments", "hermesComments", "hermesActivityComments"];
const RUN_KEYS = ["runs", "hermesRuns", "hermesActivityRuns"];
const EVENT_KEYS = ["events", "hermesEvents", "hermesActivityEvents"];

export function isHermesManagedTaskNote(task: TaskInfo): boolean {
	return getHermesTaskIdentity(task) !== null;
}

export function createHermesTaskReviewSurface(
	options: HermesTaskReviewSurfaceOptions
): HTMLElement {
	const { plugin, task } = options;
	const identity = getHermesTaskIdentity(task);
	const apiClient = options.apiClient === undefined ? new HermesKanbanApiClient() : options.apiClient;
	const container = activeDocument.createElement("div");
	container.className = "tasknotes-plugin hermes-task-review-surface";
	container.setAttribute("contenteditable", "false");
	container.setAttribute("spellcheck", "false");
	container.setAttribute("data-widget-type", "hermes-task-review");
	container.setAttribute("data-task-path", task.path);

	if (!identity) {
		container.createDiv({
			cls: "hermes-task-review-surface__empty",
			text: "This task note is not managed by Hermes.",
		});
		return container;
	}

	const model = buildReviewModel(plugin, task, identity);
	const refresh = () => plugin.app?.workspace?.trigger?.("tasknotes:refresh-views");
	const runApiAction = async (
		label: string,
		action: () => Promise<unknown>,
		successMessage: string
	) => {
		try {
			await action();
			refresh();
			new Notice(successMessage);
		} catch (error) {
			new Notice(`${label} failed: ${errorMessage(error)}`);
		}
	};

	renderHeader(container, model);
	const split = container.createDiv({ cls: "hermes-task-review-surface__split" });
	const main = split.createDiv({ cls: "hermes-task-review-surface__main" });
	const rail = split.createDiv({ cls: "hermes-task-review-surface__rail" });

	renderBrief(main, model);
	renderChangedFiles(main, model.changedFiles);
	renderComments(main, model, apiClient, runApiAction);
	renderDetails(main, task);
	renderDecisionGroup(rail, buildDecisionActions(identity, model, apiClient, runApiAction));
	renderTaskActions(
		rail,
		buildTaskActions(identity, model, plugin, task, apiClient, runApiAction, refresh)
	);
	renderOpenNext(rail, model);
	renderVerification(rail, model);
	renderActivity(rail, model);
	renderDependencies(rail, model);
	return container;
}

function buildReviewModel(plugin: TaskNotesPlugin, task: TaskInfo, identity: HermesTaskIdentity) {
	const props = task.customProperties ?? {};
	const activity = resolveActivityFromTask(plugin, props);
	const comments = activity.comments.map((raw) => parseHermesComment(raw));
	const runs = activity.runs;
	const events = activity.events;
	const changedFiles = uniqueStrings([
		...collectStringValues(props, CHANGED_FILE_KEYS),
		...activity.changedFiles,
		...comments.flatMap((comment) => collectStringValues(comment.payload, CHANGED_FILE_KEYS)),
	]);
	const latestComment = comments[comments.length - 1];
	const reviewerQuestion =
		latestComment?.kind === "review-required" && latestComment.summary
			? latestComment.summary
			: compact(task.details || task.title, 180);
	const worktree = firstString(props, HERMES_WORKTREE_KEYS);
	const branch = firstString(props, HERMES_BRANCH_KEYS);
	const commit = firstString(props, HERMES_COMMIT_KEYS);
	const assignee = firstString(props, ["hermesAssignee", "assignee"]) ?? "Unassigned";
	const blockedBy = collectStringValues(props, ["blocked_by", "blockedBy", "parents", "hermesParents"]);
	const children = collectStringValues(props, ["children", "hermesChildren"]);
	const board = identity.board;

	return {
		identity,
		title: task.title,
		status: task.status || "unknown",
		assignee,
		board,
		blockedBy,
		children,
		reviewerQuestion,
		whatChanged: summarizeWhatChanged(changedFiles, latestComment?.summary, task.title),
		changedFiles,
		comments,
		runs,
		events,
		activityRows: buildActivityRows(comments, runs, events),
		verificationRows: buildVerificationRows(comments, runs),
		worktree,
		branch,
		commit,
		changedFileCount: changedFiles.length,
		plugin,
	};
}

function renderHeader(container: HTMLElement, model: ReturnType<typeof buildReviewModel>): void {
	const header = container.createDiv({ cls: "hermes-task-review-surface__header" });
	const titleRow = header.createDiv({ cls: "hermes-task-review-surface__title-row" });
	titleRow.createSpan({ cls: `hermes-task-review-surface__status-dot is-${model.status}` });
	const title = titleRow.createDiv({ cls: "hermes-task-review-surface__title" });
	title.createDiv({ cls: "hermes-task-review-surface__task-id", text: model.identity.id });
	title.createDiv({ cls: "hermes-task-review-surface__task-title", text: model.title });
	const chips = header.createDiv({ cls: "hermes-task-review-surface__chips" });
	renderChip(chips, "Status", model.status);
	renderChip(chips, "Assignee", model.assignee);
	renderChip(chips, "Board", model.board);
	renderChip(chips, "Blocked by", String(model.blockedBy.length));
	if (model.commit) renderChip(chips, "Commit", shortValue(model.commit));
	renderChip(chips, "Changed", String(model.changedFileCount));
	header.createDiv({ cls: "hermes-task-review-surface__question", text: model.reviewerQuestion });
}

function renderBrief(container: HTMLElement, model: ReturnType<typeof buildReviewModel>): void {
	const section = container.createDiv({ cls: "hermes-task-review-surface__section" });
	section.createDiv({ cls: "hermes-task-review-surface__section-label", text: "Reviewer question" });
	section.createDiv({ cls: "hermes-task-review-surface__lead", text: model.reviewerQuestion });
	const changed = container.createDiv({ cls: "hermes-task-review-surface__section" });
	changed.createDiv({ cls: "hermes-task-review-surface__section-label", text: "What changed" });
	changed.createDiv({ cls: "hermes-task-review-surface__body-copy", text: model.whatChanged });
}

function renderChangedFiles(container: HTMLElement, changedFiles: string[]): void {
	const section = container.createDiv({ cls: "hermes-task-review-surface__section" });
	section.createDiv({ cls: "hermes-task-review-surface__section-label", text: "Changed files" });
	if (changedFiles.length === 0) {
		section.createDiv({ cls: "hermes-task-review-surface__muted", text: "No changed-file evidence yet." });
		return;
	}
	const list = section.createDiv({ cls: "hermes-task-review-surface__file-list" });
	for (const file of changedFiles.slice(0, 8)) {
		const row = list.createDiv({ cls: "hermes-task-review-surface__file-row" });
		const icon = row.createSpan({ cls: "hermes-task-review-surface__row-icon" });
		setIcon(icon, "file-code");
		row.createSpan({ text: file });
	}
	if (changedFiles.length > 8) {
		list.createDiv({ cls: "hermes-task-review-surface__muted", text: `+${changedFiles.length - 8} more` });
	}
}

function renderComments(
	container: HTMLElement,
	model: ReturnType<typeof buildReviewModel>,
	apiClient: Pick<HermesKanbanApiClient, "addComment" | "updateTask"> | null | undefined,
	runApiAction: (label: string, action: () => Promise<unknown>, successMessage: string) => Promise<void>
): void {
	const section = container.createDiv({ cls: "hermes-task-review-surface__section" });
	section.createDiv({ cls: "hermes-task-review-surface__section-label", text: "Comments" });
	const recent = section.createDiv({ cls: "hermes-task-review-surface__comments" });
	for (const comment of model.comments.slice(-2)) {
		const row = recent.createDiv({ cls: `hermes-task-review-surface__comment is-${comment.severity}` });
		row.createDiv({ cls: "hermes-task-review-surface__comment-meta", text: comment.title });
		row.createDiv({ cls: "hermes-task-review-surface__comment-body", text: comment.summary || comment.raw });
	}
	if (model.comments.length === 0) {
		recent.createDiv({ cls: "hermes-task-review-surface__muted", text: "No review comments yet." });
	}
	const composer = section.createDiv({ cls: "hermes-task-review-surface__composer" });
	const textarea = composer.createEl("textarea", {
		attr: { placeholder: "Add a review comment...", rows: "2", "aria-label": "Add a review comment" },
	});
	const send = composer.createEl("button", {
		cls: "hermes-task-review-surface__send",
		attr: { type: "button", "data-hermes-review-action": "send-comment", "aria-label": "Send comment" },
	});
	setIcon(send, "send");
	if (!apiClient) {
		textarea.disabled = true;
		send.disabled = true;
		setTooltip(send, "Hermes API is unavailable; live comments unavailable.", { placement: "top" });
		composer.createDiv({ cls: "hermes-task-review-surface__muted", text: "Live comments unavailable." });
		return;
	}
	const submit = () => {
		const body = textarea.value.trim();
		if (!body) return;
		void runApiAction(
			"Send comment",
			() => apiClient.addComment(model.identity, { body, author: "tasknotes" }),
			"Comment added to Hermes."
		).then(() => {
			textarea.value = "";
		});
	};
	send.addEventListener("click", (event) => {
		event.preventDefault();
		submit();
	});
	textarea.addEventListener("keydown", (event) => {
		if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
			event.preventDefault();
			submit();
		}
	});
}

function renderDetails(container: HTMLElement, task: TaskInfo): void {
	const detailsText = compact(task.details || "", 1200);
	if (!detailsText || detailsText === task.title) return;
	const details = container.createEl("details", { cls: "hermes-task-review-surface__details" });
	details.createEl("summary", { text: "Details" });
	details.createDiv({ cls: "hermes-task-review-surface__body-copy", text: detailsText });
}

function renderDecisionGroup(container: HTMLElement, actions: ReviewAction[]): void {
	const section = renderRailSection(container, "Review decision");
	const group = section.createDiv({ cls: "hermes-task-review-surface__button-grid" });
	actions.forEach((action) => renderActionButton(group, action));
}

function renderTaskActions(container: HTMLElement, actions: ReviewAction[]): void {
	const section = renderRailSection(container, "Task actions");
	const group = section.createDiv({ cls: "hermes-task-review-surface__button-grid" });
	actions.forEach((action) => renderActionButton(group, action));
}

function renderOpenNext(container: HTMLElement, model: ReturnType<typeof buildReviewModel>): void {
	const section = renderRailSection(container, "Open next");
	renderInfoRow(section, "Worktree", model.worktree ?? "No worktree recorded", "folder-open");
	renderInfoRow(section, "Branch", model.branch ?? "No branch recorded", "git-branch");
	renderInfoRow(section, "Commit", model.commit ?? "No commit recorded", "git-commit");
	renderInfoRow(section, "Changed files", `${model.changedFiles.length} files`, "files");
}

function renderVerification(container: HTMLElement, model: ReturnType<typeof buildReviewModel>): void {
	const section = renderRailSection(container, "Verification");
	if (model.verificationRows.length === 0) {
		renderInfoRow(section, "Not verified", "No structured verification evidence found.", "circle-dashed");
		return;
	}
	for (const row of model.verificationRows.slice(0, 5)) {
		renderInfoRow(section, row.label, row.text, /pass|success|completed/i.test(row.text) ? "check" : "circle-alert");
	}
}

function renderActivity(container: HTMLElement, model: ReturnType<typeof buildReviewModel>): void {
	const section = renderRailSection(container, "Activity timeline");
	const rows = model.activityRows.slice(-5).reverse();
	if (rows.length === 0) {
		renderInfoRow(section, "No activity", "High-signal activity has not synced yet.", "activity");
	} else {
		for (const row of rows) {
			renderInfoRow(section, row.label, row.text, row.kind === "comment" ? "message-square" : "activity");
		}
	}
	const log = section.createEl("details", { cls: "hermes-task-review-surface__worker-log" });
	log.createEl("summary", { text: `Worker log / run history (${model.runs.length})` });
	for (const run of model.runs.slice(-6).reverse()) {
		log.createDiv({ cls: "hermes-task-review-surface__muted", text: run });
	}
}

function renderDependencies(container: HTMLElement, model: ReturnType<typeof buildReviewModel>): void {
	const section = renderRailSection(container, "Dependencies");
	const chips = section.createDiv({ cls: "hermes-task-review-surface__chips" });
	renderChip(chips, "Blocked by", String(model.blockedBy.length));
	renderChip(chips, "Children", String(model.children.length));
	for (const taskId of [...model.blockedBy, ...model.children].slice(0, 6)) {
		renderChip(chips, "Task", taskId);
	}
}

function buildDecisionActions(
	identity: HermesTaskIdentity,
	model: ReturnType<typeof buildReviewModel>,
	apiClient: Pick<HermesKanbanApiClient, "addComment" | "updateTask"> | null | undefined,
	runApiAction: (label: string, action: () => Promise<unknown>, successMessage: string) => Promise<void>
): ReviewAction[] {
	const disabled = apiClient ? null : "Hermes API is unavailable; connect Hermes to submit decisions.";
	const client = apiClient;
	return [
		{
			id: "approve",
			label: "Approve",
			icon: "check-circle-2",
			tone: "primary",
			disabled,
			onClick: () => client ? runApiAction("Approve", async () => { await client.updateTask(identity, { status: "done", summary: "Approved in TaskNotes review surface." }); }, "Approved Hermes task.") : undefined,
		},
		{
			id: "request-changes",
			label: "Request changes",
			icon: "message-square-warning",
			disabled,
			onClick: () => client ? runApiAction("Request changes", () => client.addComment(identity, { author: "tasknotes", body: "Request changes from TaskNotes review surface." }), "Change request sent to Hermes.") : undefined,
		},
		{
			id: "mark-blocked",
			label: "Mark blocked",
			icon: "octagon-alert",
			tone: "danger",
			disabled,
			onClick: () => client ? runApiAction("Mark blocked", async () => { await client.updateTask(identity, { status: "blocked", block_reason: "Marked blocked from TaskNotes review surface." }); }, "Hermes task marked blocked.") : undefined,
		},
	];
}

function buildTaskActions(
	identity: HermesTaskIdentity,
	model: ReturnType<typeof buildReviewModel>,
	plugin: TaskNotesPlugin,
	task: TaskInfo,
	apiClient: Pick<HermesKanbanApiClient, "addComment" | "updateTask"> | null | undefined,
	runApiAction: (label: string, action: () => Promise<unknown>, successMessage: string) => Promise<void>,
	refresh: () => void
): ReviewAction[] {
	const apiDisabled = apiClient ? null : "Hermes API is unavailable; this live task action cannot run.";
	const client = apiClient;
	const openWorktreeDisabled = model.worktree ? null : "No worktree path is recorded for this task.";
	const archiveService = (plugin as TaskNotesPlugin & { taskService?: { toggleArchive?: (task: TaskInfo) => Promise<unknown> } }).taskService;
	const archiveDisabled =
		typeof archiveService?.toggleArchive === "function"
			? null
			: "TaskNotes archive service is unavailable; this TaskNotes build cannot archive from the Hermes review surface.";
	return [
		{
			id: "ready",
			label: "Ready",
			icon: "play",
			disabled: apiDisabled,
			onClick: () => client ? runApiAction("Ready", async () => { await client.updateTask(identity, { status: "ready" }); }, "Hermes task marked ready.") : undefined,
		},
		{
			id: "block",
			label: "Block",
			icon: "ban",
			disabled: apiDisabled,
			onClick: () => client ? runApiAction("Block", async () => { await client.updateTask(identity, { status: "blocked", block_reason: "Blocked from TaskNotes review surface." }); }, "Hermes task blocked.") : undefined,
		},
		{
			id: "complete",
			label: "Complete",
			icon: "check",
			disabled: apiDisabled,
			onClick: () => client ? runApiAction("Complete", async () => { await client.updateTask(identity, { status: "done", summary: "Completed from TaskNotes review surface." }); }, "Hermes task completed.") : undefined,
		},
		{
			id: "archive",
			label: "Archive",
			icon: "archive",
			disabled: archiveDisabled,
			onClick: async () => {
				if (typeof archiveService?.toggleArchive !== "function") return;
				try {
					await archiveService.toggleArchive(task);
					refresh();
					new Notice("Task archived.");
				} catch (error) {
					new Notice(`Archive failed: ${errorMessage(error)}`);
				}
			},
		},
		{
			id: "open-worktree",
			label: "Open worktree",
			icon: "folder-open",
			disabled: openWorktreeDisabled,
			onClick: () => {
				if (model.worktree) {
					window.open(`file://${model.worktree}`);
				}
			},
		},
	];
}

function renderRailSection(container: HTMLElement, title: string): HTMLElement {
	const section = container.createDiv({ cls: "hermes-task-review-surface__rail-section" });
	section.createDiv({ cls: "hermes-task-review-surface__rail-title", text: title });
	return section;
}

function renderActionButton(container: HTMLElement, action: ReviewAction): void {
	const button = container.createEl("button", {
		cls: `hermes-task-review-surface__action is-${action.tone ?? "secondary"}`,
		attr: {
			type: "button",
			"data-hermes-review-action": action.id,
			"aria-label": action.disabled ? `${action.label}: ${action.disabled}` : action.label,
		},
	});
	const icon = button.createSpan({ cls: "hermes-task-review-surface__button-icon" });
	setIcon(icon, action.icon);
	button.createSpan({ text: action.label });
	if (action.disabled) {
		button.disabled = true;
		setTooltip(button, action.disabled, { placement: "top" });
		return;
	}
	button.addEventListener("click", (event) => {
		event.preventDefault();
		void action.onClick();
	});
}

function renderInfoRow(container: HTMLElement, label: string, value: string, iconName: string): void {
	const row = container.createDiv({ cls: "hermes-task-review-surface__info-row" });
	const icon = row.createSpan({ cls: "hermes-task-review-surface__row-icon" });
	setIcon(icon, iconName);
	const text = row.createDiv({ cls: "hermes-task-review-surface__info-text" });
	text.createDiv({ cls: "hermes-task-review-surface__info-label", text: label });
	text.createDiv({ cls: "hermes-task-review-surface__info-value", text: compact(value, 160) });
}

function renderChip(container: HTMLElement, label: string, value: string): void {
	const chip = container.createSpan({ cls: "hermes-task-review-surface__chip" });
	chip.createSpan({ cls: "hermes-task-review-surface__chip-label", text: `${label} ` });
	chip.createSpan({ cls: "hermes-task-review-surface__chip-value", text: value });
}

function buildActivityRows(comments: ReturnType<typeof parseHermesComment>[], runs: string[], events: string[]): ActivityRow[] {
	return [
		...comments.map((comment) => ({ label: comment.title, text: comment.summary || comment.raw, kind: "comment" as const })),
		...runs.filter((run) => !isLowSignal(run)).map((run) => ({ label: "Run", text: run, kind: "run" as const })),
		...events.filter((event) => HIGH_SIGNAL_EVENT_PATTERN.test(event) && !isLowSignal(event)).map((event) => ({ label: "Event", text: event, kind: "event" as const })),
	];
}

function buildVerificationRows(comments: ReturnType<typeof parseHermesComment>[], runs: string[]): Array<{ label: string; text: string }> {
	const rows: Array<{ label: string; text: string }> = [];
	for (const comment of comments) {
		for (const chip of comment.chips) {
			if (/test|typecheck|build|verify|lint|verification/i.test(chip.label)) {
				rows.push({ label: chip.label, text: chip.value });
			}
		}
	}
	for (const run of runs) {
		if (/\b\d+\s*\/\s*\d+\s+tests? passed\b|tests? passed|typecheck|build:test|verify:obsidian|completed|passed/i.test(run)) {
			rows.push({ label: "Run evidence", text: run });
		}
	}
	return rows.length > 0 ? uniqueRows(rows) : [];
}

function summarizeWhatChanged(changedFiles: string[], latestSummary: string | undefined, fallback: string): string {
	if (latestSummary) return latestSummary;
	if (changedFiles.length > 0) {
		return `${changedFiles.length} changed ${changedFiles.length === 1 ? "file" : "files"} synced from Hermes activity.`;
	}
	return `Review requested for ${fallback}.`;
}

function resolveActivityFromTask(
	plugin: TaskNotesPlugin,
	props: Record<string, unknown>
): { comments: string[]; runs: string[]; events: string[]; changedFiles: string[] } {
	const commentValues = collectStringValues(props, COMMENT_KEYS);
	const runValues = collectStringValues(props, RUN_KEYS);
	const eventValues = collectStringValues(props, EVENT_KEYS);
	const comments = commentValues.map((value) => resolveCommentActivityValue(plugin, value) ?? value);
	const resolvedRuns = runValues.map((value) => resolveRunActivityValue(plugin, value));
	const runs = resolvedRuns.map((resolved, index) => resolved?.text ?? runValues[index]);
	const events = eventValues.map((value) => resolveEventActivityValue(plugin, value) ?? value);
	const changedFiles = resolvedRuns.flatMap((resolved) => resolved?.changedFiles ?? []);
	return { comments, runs, events, changedFiles };
}

function resolveCommentActivityValue(plugin: TaskNotesPlugin, value: string): string | null {
	const frontmatter = getLinkedActivityFrontmatter(plugin, value);
	if (!frontmatter) return null;
	return firstString(frontmatter, [
		"hermesCommentSummary",
		"commentSummary",
		"summary",
		"body",
		"comment",
	]);
}

function resolveRunActivityValue(
	plugin: TaskNotesPlugin,
	value: string
): { text: string; changedFiles: string[] } | null {
	const frontmatter = getLinkedActivityFrontmatter(plugin, value);
	if (!frontmatter) return null;
	const summary = firstString(frontmatter, [
		"hermesRunSummary",
		"hermesRunVerification",
		"runSummary",
		"verification",
		"summary",
		"result",
		"error",
	]);
	const verification = firstString(frontmatter, ["hermesRunVerification", "verification"]);
	const text = uniqueStrings([summary, verification].filter((item): item is string => Boolean(item))).join(" — ");
	return {
		text: text || value,
		changedFiles: collectStringValues(frontmatter, [
			"hermesRunChangedFiles",
			"changed_files",
			"changedFiles",
		]),
	};
}

function resolveEventActivityValue(plugin: TaskNotesPlugin, value: string): string | null {
	const frontmatter = getLinkedActivityFrontmatter(plugin, value);
	if (!frontmatter) return null;
	const label = firstString(frontmatter, ["hermesEventLabel", "hermesEventKind", "kind"]);
	const summary = firstString(frontmatter, [
		"hermesEventSummary",
		"eventSummary",
		"summary",
		"message",
		"status",
	]);
	return uniqueStrings([label, summary].filter((item): item is string => Boolean(item))).join(" — ") || null;
}

function getLinkedActivityFrontmatter(
	plugin: TaskNotesPlugin,
	value: string
): Record<string, unknown> | null {
	const path = wikilinkPath(value);
	if (!path) return null;
	const metadataCache = (plugin.app as TaskNotesPlugin["app"] & {
		metadataCache?: { getCache?: (path: string) => { frontmatter?: Record<string, unknown> } | null };
	}).metadataCache;
	for (const candidate of pathCandidates(path)) {
		const frontmatter = metadataCache?.getCache?.(candidate)?.frontmatter;
		if (frontmatter) return frontmatter;
	}
	return null;
}

function wikilinkPath(value: string): string | null {
	const match = value.match(/^\s*\[\[([^|\]]+)(?:\|[^\]]*)?\]\]\s*$/);
	return match?.[1]?.trim() || null;
}

function pathCandidates(path: string): string[] {
	const trimmed = path.trim();
	return trimmed.toLowerCase().endsWith(".md") ? [trimmed] : [`${trimmed}.md`, trimmed];
}

function collectStringValues(record: unknown, keys: readonly string[]): string[] {
	if (!record || typeof record !== "object") return [];
	const source = record as Record<string, unknown>;
	return keys.flatMap((key) => toStringList(source[key]));
}

function firstString(record: unknown, keys: readonly string[]): string | null {
	return collectStringValues(record, keys)[0] ?? null;
}

function toStringList(value: unknown): string[] {
	if (value === null || value === undefined) return [];
	if (Array.isArray(value)) return value.flatMap(toStringList);
	if (typeof value === "string") return value.trim() ? [value.trim()] : [];
	if (typeof value === "number" || typeof value === "boolean") return [String(value)];
	if (typeof value === "object") return [JSON.stringify(value)];
	return [];
}

function isLowSignal(value: string): boolean {
	const trimmed = value.trim().toLowerCase();
	if (LOW_SIGNAL_EVENT_PATTERN.test(trimmed)) return true;
	if (trimmed.startsWith("heartbeat")) return true;
	return trimmed.startsWith("{") && trimmed.endsWith("}");
}

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function uniqueRows(rows: Array<{ label: string; text: string }>): Array<{ label: string; text: string }> {
	const seen = new Set<string>();
	return rows.filter((row) => {
		const key = `${row.label}:${row.text}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function compact(value: string, maxLength: number): string {
	const text = value.trim().replace(/\s+/g, " ");
	return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text;
}

function shortValue(value: string): string {
	const trimmed = value.trim();
	return trimmed.length > 12 ? trimmed.slice(0, 12) : trimmed;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
