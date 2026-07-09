import { Notice, TFile, setIcon, setTooltip } from "obsidian";
import type { BasesView, BasesViewFactory, OpenViewState } from "obsidian";
import { BasesViewBase } from "./BasesViewBase";
import { identifyTaskNotesFromBasesData } from "./helpers";
import type { TaskInfo } from "../types";
import type TaskNotesPlugin from "../main";
import type { BasesTaskUpdateSource } from "./basesUpdateEvents";
import {
	HermesKanbanApiClient,
	type HermesBoardRecord,
} from "../hermes/hermesApiClient";
import {
	archiveHermesBoardRegistryRecord,
	createOrUpdateHermesBoardRegistryRecord,
	importHermesBoardsIntoRegistry,
	readHermesBoardRegistry,
	type HermesBoardRegistryRecord,
} from "../hermes/hermesBoardRegistry";
import {
	getHermesBoardKanbanViewPath,
	getHermesBoardKanbanViewName,
	provisionHermesBoardSurfaces,
	summarizeHermesBoardProvisionResult,
} from "../hermes/hermesBoardProvisioning";
import {
	HERMES_ASSIGNEE_FRONTMATTER,
	HERMES_BOARD_FRONTMATTER,
	canonicalHermesBoardValue,
	readHermesArchivedFrontmatter,
} from "../hermes/hermesCanonicalTaskNotes";
import { showConfirmationModal } from "../modals/ConfirmationModal";
import { showTextInputModal } from "../modals/TextInputModal";
import {
	deleteLocalHermesMirrorsForBoard,
	formatDeletedBoardNotice,
	getLocalHermesMirrorTasksForBoard,
} from "./hermesBoardMirrors";

const HERMES_BOARDS_VIEW_TYPE = "tasknotesHermesBoards";
const DEFAULT_BOARD_PROPERTY = "projects";
const DEFAULT_STATUS_PROPERTY = "status";
const DEFAULT_AGENT_PROPERTY = "contexts";
const DEFAULT_BOARD = "default";
const HERMES_BOARD_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export type HermesBoardsViewOptions = {
	boardProperty: string;
	statusProperty: string;
	agentProperty: string;
	defaultBoard: string;
	doneStatuses: Set<string>;
	busyStatuses: Set<string>;
	reviewStatuses: Set<string>;
};

export type HermesBoardSummary = {
	slug: string;
	source: "live" | "local" | "both";
	taskCount: number;
	activeCount: number;
	doneCount: number;
	runningCount: number;
	reviewCount: number;
	blockedCount: number;
	mirrorCount: number;
	agents: string[];
};

type HermesBoardSummarySourceRecord = Pick<HermesBoardRecord, "slug" | "archived"> & {
	source?: "live" | "registry";
};

function parseCsvSet(value: unknown, fallback: string[]): Set<string> {
	if (typeof value !== "string") {
		return new Set(fallback.map((item) => item.toLowerCase()));
	}
	const values = value
		.split(",")
		.map((item) => item.trim().toLowerCase())
		.filter((item) => item.length > 0);
	return new Set((values.length > 0 ? values : fallback).map((item) => item.toLowerCase()));
}

function toConfigString(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function stripPropertyPrefix(property: string): string {
	return property.replace(/^(note\.|task\.|formula\.)/, "");
}

function normalizeDisplayValue(value: string): string {
	const trimmed = value.trim();
	const wikiMatch = trimmed.match(/^\[\[([^|\]]+)(?:\|([^\]]+))?\]\]$/);
	if (wikiMatch) {
		return (wikiMatch[2] || wikiMatch[1]).trim();
	}
	return trimmed;
}

function toStringValues(value: unknown): string[] {
	if (value === null || value === undefined) return [];
	if (Array.isArray(value)) {
		return value.flatMap((item) => toStringValues(item));
	}
	if (typeof value === "string") {
		const displayValue = normalizeDisplayValue(value);
		return displayValue ? [displayValue] : [];
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return [String(value)];
	}
	return [];
}

function getTaskPropertyValues(task: TaskInfo, propertyId: string): string[] {
	const property = stripPropertyPrefix(propertyId);
	const taskRecord = task as unknown as Record<string, unknown>;
	switch (property) {
		case "status":
			return toStringValues(task.status);
		case "contexts":
			return toStringValues(task.contexts);
		case "projects":
			return toStringValues(task.projects);
		case "tags":
		case "file.tags":
			return toStringValues(task.tags);
		default:
			return toStringValues(taskRecord[property] ?? task.customProperties?.[property]);
	}
}

function normalizeBoard(value: string): string | null {
	const normalized = normalizeDisplayValue(value);
	const match = normalized.match(/Hermes\/([^|\]\s)]+)/);
	if (match?.[1]) {
		return match[1].trim();
	}
	return normalized.length > 0 ? normalized : null;
}

function getTaskBoards(task: TaskInfo, options: HermesBoardsViewOptions): string[] {
	const canonicalBoard = canonicalHermesBoardValue(
		task.customProperties?.[HERMES_BOARD_FRONTMATTER]
	);
	if (canonicalBoard) {
		return [canonicalBoard];
	}
	const boards = [
		...getTaskPropertyValues(task, options.boardProperty),
		...toStringValues(task.customProperties?.hermes_board),
	]
		.map(normalizeBoard)
		.filter((board): board is string => Boolean(board));

	return [...new Set(boards.length > 0 ? boards : [options.defaultBoard])];
}

function getTaskAgents(task: TaskInfo, options: HermesBoardsViewOptions): string[] {
	const canonicalAssignee = toStringValues(task.customProperties?.[HERMES_ASSIGNEE_FRONTMATTER])
		.map(normalizeDisplayValue)
		.filter((agent) => agent.length > 0 && agent !== "none");
	const agents = [
		...canonicalAssignee,
		...getTaskPropertyValues(task, options.agentProperty),
		...toStringValues(task.customProperties?.assignee),
	]
		.map(normalizeDisplayValue)
		.filter((agent) => agent.length > 0 && agent !== "hermes-kanban" && agent !== "none");
	return [...new Set(agents)];
}

function getTaskStatus(task: TaskInfo, options: HermesBoardsViewOptions): string {
	return (
		getTaskPropertyValues(task, options.statusProperty)[0] ||
		task.status ||
		""
	).toLowerCase();
}

function emptySummary(slug: string, source: HermesBoardSummary["source"]): HermesBoardSummary {
	return {
		slug,
		source,
		taskCount: 0,
		activeCount: 0,
		doneCount: 0,
		runningCount: 0,
		reviewCount: 0,
		blockedCount: 0,
		mirrorCount: 0,
		agents: [],
	};
}

function mergeSource(
	left: HermesBoardSummary["source"],
	right: HermesBoardSummary["source"]
): HermesBoardSummary["source"] {
	return left === right ? left : "both";
}

function isHermesBoardFixtureSlug(slug: string): boolean {
	return /(?:^e2e[-_]|[-_]e2e[-_]|[-_]e2e$|[-_]fixture$|^fixture[-_])/.test(slug);
}

export function buildHermesBoardSummaries(
	tasks: readonly TaskInfo[],
	boardRecords: readonly HermesBoardSummarySourceRecord[],
	options: HermesBoardsViewOptions
): HermesBoardSummary[] {
	const summaries = new Map<string, HermesBoardSummary>();
	const archivedRegistryBoards = new Set<string>();

	for (const board of boardRecords) {
		if (isHermesBoardFixtureSlug(board.slug)) {
			continue;
		}
		if (board.source === "registry" && board.archived) {
			archivedRegistryBoards.add(board.slug);
		}
	}

	for (const board of boardRecords) {
		if (isHermesBoardFixtureSlug(board.slug)) {
			continue;
		}
		if (board.archived) {
			continue;
		}
		if (board.source !== "registry" && archivedRegistryBoards.has(board.slug)) {
			continue;
		}
		const source: HermesBoardSummary["source"] = board.source === "registry" ? "local" : "live";
		const existing = summaries.get(board.slug);
		if (existing) {
			existing.source = mergeSource(existing.source, source);
		} else {
			summaries.set(board.slug, emptySummary(board.slug, source));
		}
	}

	for (const task of tasks) {
		const status = getTaskStatus(task, options);
		const done = options.doneStatuses.has(status);
		const running = options.busyStatuses.has(status);
		const review = options.reviewStatuses.has(status);
		const blocked = status === "blocked" || task.isBlocked === true;
		const archived =
			readHermesArchivedFrontmatter(task.customProperties) ?? task.archived === true;
		const active = !archived && !done;
		const agents = getTaskAgents(task, options);

		for (const board of getTaskBoards(task, options)) {
			if (isHermesBoardFixtureSlug(board)) {
				continue;
			}
			if (archivedRegistryBoards.has(board)) {
				continue;
			}
			let summary = summaries.get(board);
			if (!summary) {
				summary = emptySummary(board, "local");
				summaries.set(board, summary);
			} else {
				summary.source = mergeSource(summary.source, "local");
			}
			summary.taskCount += 1;
			summary.activeCount += active ? 1 : 0;
			summary.doneCount += done ? 1 : 0;
			summary.runningCount += running ? 1 : 0;
			summary.reviewCount += review ? 1 : 0;
			summary.blockedCount += blocked ? 1 : 0;
			for (const agent of agents) {
				if (!summary.agents.includes(agent)) {
					summary.agents.push(agent);
				}
			}
		}
	}

	for (const summary of summaries.values()) {
		summary.mirrorCount = getLocalHermesMirrorTasksForBoard(tasks, summary.slug).length;
		summary.agents.sort((left, right) => left.localeCompare(right));
	}

	return [...summaries.values()].sort((left, right) => {
		const score = (summary: HermesBoardSummary): number =>
			summary.runningCount * 1000 +
			summary.reviewCount * 800 +
			summary.blockedCount * 700 +
			summary.activeCount * 100 +
			(summary.source === "local" ? 25 : 0);
		const scoreDelta = score(right) - score(left);
		if (scoreDelta !== 0) return scoreDelta;
		return left.slug.localeCompare(right.slug);
	});
}

export function getHermesBoardKanbanOpenPath(board: string): string | null {
	const slug = normalizeBoardSlugInput(board);
	return slug ? getHermesBoardKanbanViewPath(slug) : null;
}

function getHermesBoardKanbanOpenState(slug: string): OpenViewState {
	const viewPath = getHermesBoardKanbanViewPath(slug);
	return {
		active: true,
		state: {
			file: viewPath,
			viewName: getHermesBoardKanbanViewName(slug),
		},
	};
}

export class HermesBoardsView extends BasesViewBase {
	type = HERMES_BOARDS_VIEW_TYPE;
	private contentEl: HTMLElement | null = null;
	private options: HermesBoardsViewOptions = this.buildOptions();

	protected setupContainer(): void {
		super.setupContainer();
		this.rootElement?.addClass("hermes-boards-view");
		this.contentEl = this.containerEl.ownerDocument.createElement("div");
		this.contentEl.className = "hermes-boards-view__content";
		this.rootElement?.appendChild(this.contentEl);
	}

	private buildOptions(): HermesBoardsViewOptions {
		return {
			boardProperty: DEFAULT_BOARD_PROPERTY,
			statusProperty: DEFAULT_STATUS_PROPERTY,
			agentProperty: DEFAULT_AGENT_PROPERTY,
			defaultBoard: DEFAULT_BOARD,
			doneStatuses: new Set(["done", "completed"]),
			busyStatuses: new Set(["running"]),
			reviewStatuses: new Set(["review"]),
		};
	}

	private readViewOptions(): void {
		if (!this.config) return;
		this.options = {
			boardProperty: toConfigString(this.config.get("boardProperty"), DEFAULT_BOARD_PROPERTY),
			statusProperty: toConfigString(this.config.get("statusProperty"), DEFAULT_STATUS_PROPERTY),
			agentProperty: toConfigString(this.config.get("agentProperty"), DEFAULT_AGENT_PROPERTY),
			defaultBoard: toConfigString(this.config.get("defaultBoard"), DEFAULT_BOARD),
			doneStatuses: parseCsvSet(this.config.get("doneStatuses"), ["done", "completed"]),
			busyStatuses: parseCsvSet(this.config.get("busyStatuses"), ["running"]),
			reviewStatuses: parseCsvSet(this.config.get("reviewStatuses"), ["review"]),
		};
	}

	async render(): Promise<void> {
		if (!this.rootElement || !this.contentEl) return;
		if (this.config) {
			this.readViewOptions();
		}
		this.contentEl.empty();

		let registry = await this.loadBoardRegistry();
		const live = await this.loadLiveBoards();
		registry = await this.backfillLiveBoardsToRegistry(live.boards, registry);
		const tasks = await this.resolveTasks();
		const summaries = buildHermesBoardSummaries(
			tasks,
			[...registry, ...live.boards.map((board) => ({ ...board, source: "live" as const }))],
			this.options
		);

		this.renderToolbar(live.error);
		this.renderSummary(summaries, tasks.length);
		if (summaries.length === 0) {
			this.renderEmptyState();
			return;
		}

		const grid = this.contentEl.createDiv({ cls: "hermes-boards-view__grid" });
		for (const summary of summaries) {
			this.renderBoardCard(grid, summary);
		}
	}

	renderError(error: Error): void {
		if (!this.contentEl) return;
		this.contentEl.empty();
		const errorEl = this.contentEl.createDiv({ cls: "tn-bases-error" });
		errorEl.textContent = `Error loading Hermes boards: ${error.message || "Unknown error"}`;
	}

	private async resolveTasks(): Promise<TaskInfo[]> {
		if (this.data?.data) {
			const dataItems = this.dataAdapter.extractDataItems();
			return identifyTaskNotesFromBasesData(dataItems, this.plugin);
		}
		return [];
	}

	private async loadBoardRegistry(): Promise<HermesBoardRegistryRecord[]> {
		try {
			return await readHermesBoardRegistry(this.plugin, { includeArchived: true });
		} catch {
			return [];
		}
	}

	private async loadLiveBoards(): Promise<{ boards: HermesBoardRecord[]; error: string | null }> {
		try {
			const boards = await new HermesKanbanApiClient().listBoards();
			return { boards, error: null };
		} catch (error) {
			return { boards: [], error: getErrorMessage(error) };
		}
	}

	private async backfillLiveBoardsToRegistry(
		boards: HermesBoardRecord[],
		fallback: HermesBoardRegistryRecord[]
	): Promise<HermesBoardRegistryRecord[]> {
		if (boards.length === 0) {
			return fallback;
		}
		try {
			await importHermesBoardsIntoRegistry(this.plugin, boards);
			return await readHermesBoardRegistry(this.plugin, { includeArchived: true });
		} catch {
			return fallback;
		}
	}

	private renderToolbar(error: string | null): void {
		if (!this.contentEl) return;
		const toolbar = this.contentEl.createDiv({ cls: "hermes-boards-view__toolbar" });
		const title = toolbar.createDiv({ cls: "hermes-boards-view__title" });
		title.createDiv({ cls: "hermes-boards-view__heading", text: "Hermes boards" });
		title.createDiv({
			cls: "hermes-boards-view__subheading",
			text: error
				? "Live board list unavailable; showing TaskNotes board registry."
				: "TaskNotes board registry with optional live sync.",
		});

		const actions = toolbar.createDiv({ cls: "hermes-boards-view__toolbar-actions" });
		this.renderToolbarButton(actions, "Refresh", "refresh-cw", "Refresh Hermes boards", () => {
			this.refresh();
		});
		this.renderToolbarButton(actions, "Create", "plus", "Create Hermes board", () => {
			void this.createBoard();
		});
	}

	private renderToolbarButton(
		container: HTMLElement,
		label: string,
		iconName: string,
		tooltip: string,
		onClick: () => void
	): void {
		const button = container.createEl("button", {
			cls: "hermes-boards-view__toolbar-button",
			attr: { type: "button", "aria-label": tooltip },
		});
		const icon = button.createSpan({ cls: "hermes-boards-view__button-icon" });
		setIcon(icon, iconName);
		button.createSpan({ text: label });
		setTooltip(button, tooltip, { placement: "top" });
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			onClick();
		});
	}

	private renderSummary(summaries: HermesBoardSummary[], taskNoteCount: number): void {
		if (!this.contentEl) return;
		const summary = this.contentEl.createDiv({ cls: "hermes-boards-view__summary" });
		const boardCount = summaries.length;
		const mirrorCount = summaries.reduce((total, board) => total + board.mirrorCount, 0);
		this.renderSummaryMetric(summary, "Boards", boardCount);
		this.renderSummaryMetric(
			summary,
			"Active",
			summaries.reduce((total, board) => total + board.activeCount, 0)
		);
		this.renderSummaryMetric(
			summary,
			"Running",
			summaries.reduce((total, board) => total + board.runningCount, 0)
		);
		this.renderSummaryMetric(summary, "Mirrors", mirrorCount);
		summary.createDiv({
			cls: "hermes-boards-view__summary-copy",
			text: `${boardCount} boards from ${taskNoteCount} TaskNotes · ${mirrorCount} local mirrors`,
		});
	}

	private renderSummaryMetric(container: HTMLElement, label: string, value: number): void {
		const metric = container.createDiv({ cls: "hermes-boards-view__summary-metric" });
		metric.createSpan({ cls: "hermes-boards-view__summary-value", text: String(value) });
		metric.createSpan({ cls: "hermes-boards-view__summary-label", text: label });
	}

	private renderEmptyState(): void {
		if (!this.contentEl) return;
		const empty = this.contentEl.createDiv({ cls: "tn-bases-empty" });
		const icon = empty.createSpan({ cls: "hermes-boards-view__empty-icon" });
		setIcon(icon, "columns-3");
		empty.createDiv({ text: "No Hermes boards found" });
	}

	private renderBoardCard(container: HTMLElement, summary: HermesBoardSummary): void {
		const card = container.createDiv({ cls: "hermes-boards-view__board" });

		const header = card.createDiv({ cls: "hermes-boards-view__board-header" });
		const title = header.createDiv({ cls: "hermes-boards-view__board-title" });
		const titleButton = title.createEl("button", {
			cls: "hermes-boards-view__board-name hermes-boards-view__title-link",
			attr: { type: "button", "aria-label": `Open Hermes/${summary.slug} Kanban` },
			text: summary.slug,
		});
		titleButton.addEventListener("click", (event) => {
			event.preventDefault();
			void this.openBoardKanban(summary.slug);
		});
		title.createDiv({
			cls: "hermes-boards-view__board-source",
			text: this.formatSource(summary.source),
		});
		const actions = header.createEl("details", {
			cls: "hermes-boards-view__board-actions",
		});
		const actionsSummary = actions.createEl("summary", {
			cls: "hermes-boards-view__actions-toggle",
			attr: { "aria-label": `Board actions for Hermes/${summary.slug}` },
			text: "Actions",
		});
		setTooltip(actionsSummary, `Board actions for Hermes/${summary.slug}`, { placement: "top" });
		const deleteButton = actions.createEl("button", {
			cls: "hermes-boards-view__delete-button hermes-boards-view__secondary-action",
			attr: {
				type: "button",
				"aria-label": `Delete Hermes/${summary.slug}`,
			},
		});
		deleteButton.disabled = this.isProtectedBoard(summary.slug);
		const deleteIcon = deleteButton.createSpan({ cls: "hermes-boards-view__button-icon" });
		setIcon(deleteIcon, "trash-2");
		deleteButton.createSpan({ text: "Delete board" });
		setTooltip(
			deleteButton,
			this.isProtectedBoard(summary.slug)
				? "The default Hermes board cannot be deleted"
				: `Delete Hermes/${summary.slug}`,
			{ placement: "top" }
		);
		deleteButton.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			void this.deleteBoard(summary.slug);
		});

		const metrics = card.createDiv({ cls: "hermes-boards-view__metrics" });
		this.renderBoardMetric(metrics, "Active", summary.activeCount);
		this.renderBoardMetric(metrics, "Running", summary.runningCount);
		this.renderBoardMetric(metrics, "Review", summary.reviewCount);
		this.renderBoardMetric(metrics, "Blocked", summary.blockedCount);
		this.renderBoardMetric(metrics, this.formatSource(summary.source), summary.source === "live" ? 0 : summary.mirrorCount);
		this.renderBoardMetric(metrics, "Done", summary.doneCount, true);
		this.renderBoardMetric(metrics, "Mirrors", summary.mirrorCount, true);

		card.createDiv({
			cls: "hermes-boards-view__agents",
			text:
				summary.agents.length > 0
					? `Agents: ${summary.agents.join(", ")}`
					: "No assigned agents",
		});

		const openButton = card.createEl("button", {
			cls: "hermes-boards-view__open-button",
			attr: { type: "button", "aria-label": `Open Hermes/${summary.slug} kanban` },
			text: "Open kanban",
		});
		openButton.addEventListener("click", (event) => {
			event.preventDefault();
			void this.openBoardKanban(summary.slug);
		});
	}

	private renderBoardMetric(
		container: HTMLElement,
		label: string,
		value: number,
		secondary = false
	): void {
		const metric = container.createDiv({
			cls: secondary
				? "hermes-boards-view__metric hermes-boards-view__metric--secondary"
				: "hermes-boards-view__metric",
		});
		metric.createSpan({ cls: "hermes-boards-view__metric-value", text: String(value) });
		metric.createSpan({ cls: "hermes-boards-view__metric-label", text: label });
	}

	private formatSource(source: HermesBoardSummary["source"]): string {
		if (source === "both") return "Live + local";
		if (source === "live") return "Live";
		return "Local only";
	}

	private async createBoard(): Promise<void> {
		const input = await showTextInputModal(this.plugin.app, {
			title: "Create Hermes board",
			placeholder: "new-board",
			confirmText: "Create board",
		});
		if (!input) {
			return;
		}

		const slug = normalizeBoardSlugInput(input);
		if (!slug) {
			new Notice(
				"Board names must start with a letter or number and use letters, numbers, hyphens, or underscores."
			);
			return;
		}

		try {
			await createOrUpdateHermesBoardRegistryRecord(this.plugin, {
				slug,
				name: input.trim(),
				archived: false,
			});
			const provisionResult = await provisionHermesBoardSurfaces(this.plugin, [slug]);
			this.plugin.app.workspace.trigger("tasknotes:refresh-views");
			this.refresh();
			new Notice(
				`Created Hermes board "${slug}". ${summarizeHermesBoardProvisionResult(provisionResult)}`
			);
		} catch (error) {
			new Notice(`Could not create Hermes board: ${getErrorMessage(error)}`);
		}
	}

	private async openBoardKanban(board: string): Promise<void> {
		const slug = normalizeBoardSlugInput(board);
		if (!slug) {
			new Notice(`Could not open Hermes/${board}: invalid board name.`);
			return;
		}
		const viewPath = getHermesBoardKanbanViewPath(slug);

		try {
			await provisionHermesBoardSurfaces(this.plugin, [slug]);
			const file = this.plugin.app.vault.getAbstractFileByPath(viewPath);
			if (!(file instanceof TFile)) {
				new Notice(`Could not open Hermes/${board}: Kanban view was not created.`);
				return;
			}
			await this.plugin.app.workspace.getLeaf("tab").openFile(file, getHermesBoardKanbanOpenState(slug));
		} catch (error) {
			new Notice(`Could not open Hermes/${board}: ${getErrorMessage(error)}`);
		}
	}

	private async deleteBoard(board: string): Promise<void> {
		if (this.isProtectedBoard(board)) {
			new Notice("The default board cannot be deleted.");
			return;
		}

		const confirmed = await showConfirmationModal(this.plugin.app, {
			title: "Delete Hermes board",
			message: `Delete "${board}" from active Hermes boards? TaskNotes archives the board record so it can be recovered. Local TaskNotes mirror notes for this board will be removed.`,
			confirmText: "Delete board",
			isDestructive: true,
		});
		if (!confirmed) {
			return;
		}

		try {
			await archiveHermesBoardRegistryRecord(this.plugin, board);
			const deletedMirrors = await deleteLocalHermesMirrorsForBoard(this.plugin, board);
			this.plugin.app.workspace.trigger("tasknotes:refresh-views");
			this.refresh();
			new Notice(formatDeletedBoardNotice(board, deletedMirrors));
		} catch (error) {
			new Notice(`Could not delete Hermes board: ${getErrorMessage(error)}`);
		}
	}

	protected async handleTaskUpdate(
		task: TaskInfo,
		source?: BasesTaskUpdateSource
	): Promise<void> {
		this.refresh();
	}

	private isProtectedBoard(board: string): boolean {
		return board === DEFAULT_BOARD || board === this.options.defaultBoard;
	}
}

function normalizeBoardSlugInput(input: string): string | null {
	const slug = input.trim().toLowerCase().replace(/\s+/g, "-");
	if (!HERMES_BOARD_SLUG_PATTERN.test(slug)) {
		return null;
	}
	return slug;
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

export function buildHermesBoardsViewFactory(plugin: TaskNotesPlugin): BasesViewFactory {
	return function (controller: unknown, containerEl: HTMLElement): BasesView {
		return new HermesBoardsView(controller, containerEl, plugin) as unknown as BasesView;
	};
}
