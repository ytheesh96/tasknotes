import { Notice, setIcon, setTooltip } from "obsidian";
import type { BasesView, BasesViewFactory } from "obsidian";
import { BasesViewBase } from "./BasesViewBase";
import { identifyTaskNotesFromBasesData } from "./helpers";
import { createTaskCard } from "../ui/TaskCard";
import type { TaskInfo } from "../types";
import type TaskNotesPlugin from "../main";
import type { BasesTaskUpdateSource } from "./basesUpdateEvents";

const AGENT_ROSTER_VIEW_TYPE = "tasknotesAgentRoster";
const DEFAULT_AGENT_PROPERTY = "assignee";
const DEFAULT_AGENT_FALLBACK_PROPERTY = "contexts";
const DEFAULT_BOARD_PROPERTY = "projects";
const DEFAULT_STATUS_PROPERTY = "status";
const DEFAULT_SUBMIT_STATUS = "triage";
const DEFAULT_SUBMIT_TAG = "hermes-submit";
const DEFAULT_BOARD = "default";
const DEFAULT_MAX_TASKS_PER_AGENT = 4;

export type AgentRosterViewOptions = {
	agentProperty: string;
	agentFallbackProperty: string;
	boardProperty: string;
	statusProperty: string;
	submitStatus: string;
	submitTag: string;
	defaultBoard: string;
	maxTasksPerAgent: number;
	readyStatuses: Set<string>;
	busyStatuses: Set<string>;
	reviewStatuses: Set<string>;
	ignoredAgentValues: Set<string>;
};

export type AgentRosterAgent = {
	name: string;
	primaryBoard: string;
	boards: string[];
	tasks: TaskInfo[];
	runningCount: number;
	reviewCount: number;
	blockedCount: number;
	readyCount: number;
	activeCount: number;
	status: "busy" | "review" | "blocked" | "available" | "active";
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

function toConfigNumber(value: unknown, fallback: number, min: number, max: number): number {
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(max, Math.max(min, Math.round(parsed)));
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
		case "file.name":
		case "file.basename":
		case "name":
		case "title":
			return toStringValues(task.title);
		case "status":
			return toStringValues(task.status);
		case "priority":
			return toStringValues(task.priority);
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

function getTaskBoards(task: TaskInfo, options: AgentRosterViewOptions): string[] {
	const boards = [
		...getTaskPropertyValues(task, options.boardProperty),
		...toStringValues(task.customProperties?.hermes_board),
	]
		.map(normalizeBoard)
		.filter((board): board is string => Boolean(board));

	return [...new Set(boards.length > 0 ? boards : [options.defaultBoard])];
}

function getTaskAgents(task: TaskInfo, options: AgentRosterViewOptions): string[] {
	const primaryAgents = getTaskPropertyValues(task, options.agentProperty);
	const fallbackAgents =
		primaryAgents.length > 0
			? []
			: getTaskPropertyValues(task, options.agentFallbackProperty);
	const agents = [...primaryAgents, ...fallbackAgents]
		.map(normalizeDisplayValue)
		.filter((agent) => agent.length > 0)
		.filter((agent) => !options.ignoredAgentValues.has(agent.toLowerCase()));

	return [...new Set(agents.length > 0 ? agents : ["Unassigned"])];
}

function getTaskStatus(task: TaskInfo, options: AgentRosterViewOptions): string {
	return (
		getTaskPropertyValues(task, options.statusProperty)[0] ||
		task.status ||
		""
	).toLowerCase();
}

function sortTasksForRoster(tasks: TaskInfo[], options: AgentRosterViewOptions): TaskInfo[] {
	const rankTask = (task: TaskInfo): number => {
		const status = getTaskStatus(task, options);
		if (options.busyStatuses.has(status)) return 0;
		if (options.reviewStatuses.has(status)) return 1;
		if (status === "blocked" || task.isBlocked) return 2;
		if (options.readyStatuses.has(status)) return 3;
		return 4;
	};

	return [...tasks].sort((left, right) => {
		const rankDelta = rankTask(left) - rankTask(right);
		if (rankDelta !== 0) return rankDelta;
		return left.title.localeCompare(right.title);
	});
}

export function buildAgentRoster(
	tasks: TaskInfo[],
	options: AgentRosterViewOptions
): AgentRosterAgent[] {
	const agents = new Map<string, AgentRosterAgent>();

	for (const task of tasks) {
		if (task.archived) continue;

		const taskAgents = getTaskAgents(task, options);
		const taskBoards = getTaskBoards(task, options);
		const status = getTaskStatus(task, options);
		const isRunning = options.busyStatuses.has(status);
		const isReview = options.reviewStatuses.has(status);
		const isBlocked = status === "blocked" || task.isBlocked === true;
		const isReady = options.readyStatuses.has(status);

		for (const agentName of taskAgents) {
			let agent = agents.get(agentName);
			if (!agent) {
				agent = {
					name: agentName,
					primaryBoard: taskBoards[0] || options.defaultBoard,
					boards: [],
					tasks: [],
					runningCount: 0,
					reviewCount: 0,
					blockedCount: 0,
					readyCount: 0,
					activeCount: 0,
					status: "available",
				};
				agents.set(agentName, agent);
			}

			for (const board of taskBoards) {
				if (!agent.boards.includes(board)) {
					agent.boards.push(board);
				}
			}
			agent.tasks.push(task);
			agent.runningCount += isRunning ? 1 : 0;
			agent.reviewCount += isReview ? 1 : 0;
			agent.blockedCount += isBlocked ? 1 : 0;
			agent.readyCount += isReady ? 1 : 0;
			agent.activeCount += status !== "done" ? 1 : 0;
		}
	}

	return [...agents.values()]
		.map((agent) => {
			const status: AgentRosterAgent["status"] =
				agent.runningCount > 0
					? "busy"
					: agent.reviewCount > 0
						? "review"
						: agent.blockedCount > 0
							? "blocked"
							: agent.activeCount > 0
								? "active"
								: "available";
			return {
				...agent,
				status,
				boards: agent.boards.sort((left, right) => left.localeCompare(right)),
				primaryBoard: agent.primaryBoard || agent.boards[0] || options.defaultBoard,
				tasks: sortTasksForRoster(agent.tasks, options),
			};
		})
		.sort((left, right) => {
			const statusRank: Record<AgentRosterAgent["status"], number> = {
				busy: 0,
				review: 1,
				blocked: 2,
				active: 3,
				available: 4,
			};
			const rankDelta = statusRank[left.status] - statusRank[right.status];
			if (rankDelta !== 0) return rankDelta;
			return left.name.localeCompare(right.name);
		});
}

export class AgentRosterView extends BasesViewBase {
	type = AGENT_ROSTER_VIEW_TYPE;
	private contentEl: HTMLElement | null = null;
	private options: AgentRosterViewOptions = this.buildOptions();

	protected setupContainer(): void {
		super.setupContainer();
		this.rootElement?.addClass("agent-roster-view");
		this.contentEl = this.containerEl.ownerDocument.createElement("div");
		this.contentEl.className = "agent-roster-view__content";
		this.rootElement?.appendChild(this.contentEl);
	}

	private buildOptions(): AgentRosterViewOptions {
		return {
			agentProperty: DEFAULT_AGENT_PROPERTY,
			agentFallbackProperty: DEFAULT_AGENT_FALLBACK_PROPERTY,
			boardProperty: DEFAULT_BOARD_PROPERTY,
			statusProperty: DEFAULT_STATUS_PROPERTY,
			submitStatus: DEFAULT_SUBMIT_STATUS,
			submitTag: DEFAULT_SUBMIT_TAG,
			defaultBoard: DEFAULT_BOARD,
			maxTasksPerAgent: DEFAULT_MAX_TASKS_PER_AGENT,
			readyStatuses: new Set(["triage", "todo", "scheduled", "ready"]),
			busyStatuses: new Set(["running"]),
			reviewStatuses: new Set(["review"]),
			ignoredAgentValues: new Set(["hermes-kanban"]),
		};
	}

	private readViewOptions(): void {
		if (!this.config) return;
		this.options = {
			agentProperty: toConfigString(
				this.config.get("agentProperty"),
				DEFAULT_AGENT_PROPERTY
			),
			agentFallbackProperty: toConfigString(
				this.config.get("agentFallbackProperty"),
				DEFAULT_AGENT_FALLBACK_PROPERTY
			),
			boardProperty: toConfigString(
				this.config.get("boardProperty"),
				DEFAULT_BOARD_PROPERTY
			),
			statusProperty: toConfigString(
				this.config.get("statusProperty"),
				DEFAULT_STATUS_PROPERTY
			),
			submitStatus: toConfigString(this.config.get("submitStatus"), DEFAULT_SUBMIT_STATUS),
			submitTag: toConfigString(this.config.get("submitTag"), DEFAULT_SUBMIT_TAG),
			defaultBoard: toConfigString(this.config.get("defaultBoard"), DEFAULT_BOARD),
			maxTasksPerAgent: toConfigNumber(
				this.config.get("maxTasksPerAgent"),
				DEFAULT_MAX_TASKS_PER_AGENT,
				1,
				12
			),
			readyStatuses: parseCsvSet(this.config.get("readyStatuses"), [
				"triage",
				"todo",
				"scheduled",
				"ready",
			]),
			busyStatuses: parseCsvSet(this.config.get("busyStatuses"), ["running"]),
			reviewStatuses: parseCsvSet(this.config.get("reviewStatuses"), ["review"]),
			ignoredAgentValues: parseCsvSet(this.config.get("ignoredAgentValues"), [
				"hermes-kanban",
			]),
		};
	}

	async render(): Promise<void> {
		if (!this.rootElement || !this.contentEl) return;
		if (this.config) {
			this.readViewOptions();
		}
		this.setupSearch(this.rootElement);
		this.contentEl.empty();

		if (!this.data?.data) {
			return;
		}

		try {
			const dataItems = this.dataAdapter.extractDataItems();
			const taskNotes = await identifyTaskNotesFromBasesData(dataItems, this.plugin);
			const filteredTasks = this.applySearchFilter(taskNotes);
			const roster = buildAgentRoster(filteredTasks, this.options);

			if (roster.length === 0) {
				this.renderEmptyState();
				return;
			}

			this.renderSummary(roster);
			const grid = this.contentEl.createDiv({ cls: "agent-roster-view__grid" });
			for (const agent of roster) {
				this.renderAgentCard(grid, agent);
			}
		} catch (error) {
			this.renderError(error as Error);
		}
	}

	renderError(error: Error): void {
		if (!this.contentEl) return;
		this.contentEl.empty();
		const errorEl = this.contentEl.createDiv({ cls: "tn-bases-error" });
		errorEl.textContent = `Error loading agent roster: ${error.message || "Unknown error"}`;
	}

	protected async handleTaskUpdate(
		task: TaskInfo,
		source?: BasesTaskUpdateSource
	): Promise<void> {
		this.refresh();
	}

	private renderEmptyState(): void {
		if (!this.contentEl) return;
		const empty = this.contentEl.createDiv({ cls: "tn-bases-empty" });
		const icon = empty.createSpan({ cls: "agent-roster-view__empty-icon" });
		setIcon(icon, "users");
		empty.createDiv({ text: "No agents found" });
	}

	private renderSummary(roster: AgentRosterAgent[]): void {
		if (!this.contentEl) return;
		const summary = this.contentEl.createDiv({ cls: "agent-roster-view__summary" });
		this.renderSummaryMetric(summary, "Agents", roster.length);
		this.renderSummaryMetric(
			summary,
			"Running",
			roster.reduce((sum, agent) => sum + agent.runningCount, 0)
		);
		this.renderSummaryMetric(
			summary,
			"Review",
			roster.reduce((sum, agent) => sum + agent.reviewCount, 0)
		);
		this.renderSummaryMetric(
			summary,
			"Blocked",
			roster.reduce((sum, agent) => sum + agent.blockedCount, 0)
		);
	}

	private renderSummaryMetric(container: HTMLElement, label: string, value: number): void {
		const metric = container.createDiv({ cls: "agent-roster-view__summary-metric" });
		metric.createSpan({ cls: "agent-roster-view__summary-value", text: String(value) });
		metric.createSpan({ cls: "agent-roster-view__summary-label", text: label });
	}

	private renderAgentCard(container: HTMLElement, agent: AgentRosterAgent): void {
		const card = container.createDiv({
			cls: `agent-roster-view__agent agent-roster-view__agent--${agent.status}`,
		});
		const header = card.createDiv({ cls: "agent-roster-view__agent-header" });
		const avatar = header.createDiv({ cls: "agent-roster-view__agent-avatar" });
		avatar.textContent = agent.name.charAt(0).toUpperCase();

		const title = header.createDiv({ cls: "agent-roster-view__agent-title" });
		title.createDiv({ cls: "agent-roster-view__agent-name", text: agent.name });
		title.createDiv({ cls: "agent-roster-view__agent-board", text: `Hermes/${agent.primaryBoard}` });

		const status = header.createDiv({
			cls: `agent-roster-view__status agent-roster-view__status--${agent.status}`,
			text: this.formatAgentStatus(agent.status),
		});
		status.setAttribute("aria-label", `Agent status: ${this.formatAgentStatus(agent.status)}`);

		const metrics = card.createDiv({ cls: "agent-roster-view__metrics" });
		this.renderAgentMetric(metrics, "Active", agent.activeCount);
		this.renderAgentMetric(metrics, "Running", agent.runningCount);
		this.renderAgentMetric(metrics, "Review", agent.reviewCount);
		this.renderAgentMetric(metrics, "Blocked", agent.blockedCount);

		const boardActions = card.createDiv({ cls: "agent-roster-view__board-actions" });
		for (const board of agent.boards.length > 0 ? agent.boards : [agent.primaryBoard]) {
			const button = boardActions.createEl("button", {
				cls: "agent-roster-view__submit-button",
				attr: {
					type: "button",
					"aria-label": `Submit task to ${agent.name} on Hermes/${board}`,
				},
			});
			const icon = button.createSpan({ cls: "agent-roster-view__submit-icon" });
			setIcon(icon, "plus");
			button.createSpan({ text: board });
			setTooltip(button, `Submit task to Hermes/${board}`, { placement: "top" });
			button.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				void this.openSubmitTaskModal(agent.name, board);
			});
		}

		const taskList = card.createDiv({ cls: "agent-roster-view__task-list" });
		const visibleTasks = agent.tasks.slice(0, this.options.maxTasksPerAgent);
		for (const task of visibleTasks) {
			const wrapper = taskList.createDiv({ cls: "agent-roster-view__task-card" });
			wrapper.setAttribute("data-task-path", task.path);
			wrapper.appendChild(
				createTaskCard(task, this.plugin, this.getVisibleProperties(), {
					...this.buildTaskCardOptions({ layout: "compact" }),
				})
			);
		}

		const remaining = agent.tasks.length - visibleTasks.length;
		if (remaining > 0) {
			taskList.createDiv({
				cls: "agent-roster-view__more",
				text: `+${remaining} more`,
			});
		}
	}

	private renderAgentMetric(container: HTMLElement, label: string, value: number): void {
		const metric = container.createDiv({ cls: "agent-roster-view__metric" });
		metric.createSpan({ cls: "agent-roster-view__metric-value", text: String(value) });
		metric.createSpan({ cls: "agent-roster-view__metric-label", text: label });
	}

	private formatAgentStatus(status: AgentRosterAgent["status"]): string {
		switch (status) {
			case "busy":
				return "Busy";
			case "review":
				return "Review";
			case "blocked":
				return "Blocked";
			case "active":
				return "Active";
			default:
				return "Available";
		}
	}

	private async openSubmitTaskModal(agentName: string, board: string): Promise<void> {
		if (agentName === "Unassigned") {
			new Notice("Choose a named agent before submitting delegated work.");
			return;
		}

		await this.createFileForView("New Task", (frontmatter) => {
			const statusField = this.plugin.fieldMapper.toUserField("status");
			const contextsField = this.plugin.fieldMapper.toUserField("contexts");
			const projectsField = this.plugin.fieldMapper.toUserField("projects");
			const tags = toStringValues(frontmatter.tags);

			frontmatter[statusField] = this.options.submitStatus;
			frontmatter[contextsField] = [agentName];
			frontmatter[projectsField] = [`Hermes/${board || this.options.defaultBoard}`];
			frontmatter.assignee = agentName;
			frontmatter.hermes_board = board || this.options.defaultBoard;
			frontmatter.hermes_submit = true;
			frontmatter.tags = [...new Set([...tags, this.options.submitTag].filter(Boolean))];
		});
	}

}

export function buildAgentRosterViewFactory(plugin: TaskNotesPlugin): BasesViewFactory {
	return function (controller: unknown, containerEl: HTMLElement): BasesView {
		return new AgentRosterView(controller, containerEl, plugin) as unknown as BasesView;
	};
}
