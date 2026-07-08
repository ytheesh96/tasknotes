import type TaskNotesPlugin from "../main";
import { requireApiVersion } from "obsidian";
import { buildTaskListViewFactory } from "./TaskListView";
import { buildKanbanViewFactory } from "./KanbanView";
import { buildAgentRosterViewFactory } from "./AgentRosterView";
import { buildHermesBoardsViewFactory } from "./HermesBoardsView";
import { buildCalendarViewFactory } from "./CalendarView";
import { buildMiniCalendarViewFactory } from "./MiniCalendarView";
import { registerBasesView, unregisterBasesView } from "./api";
import { buildCalendarViewOptions, buildMiniCalendarViewOptions } from "./calendarViewOptions";
import { createTaskNotesLogger } from "../utils/tasknotesLogger";

const KANBAN_CARD_LAYOUT_OPTIONS: Record<string, string> = {
	default: "Default",
	compact: "Compact",
};

const TASK_LIST_DEFAULT_COLLAPSED_STATE_OPTIONS: Record<string, string> = {
	Expanded: "Expanded",
	Collapsed: "Collapsed",
};

const EXPANDED_RELATIONSHIP_FILTER_MODE_OPTIONS: Record<string, string> = {
	inherit: "Inherit",
	"show-all": "Show all",
};

function isNoteTaskOrFormulaProperty(prop: string): boolean {
	return prop.startsWith("note.") || prop.startsWith("task.") || prop.startsWith("formula.");
}

/**
 * Register TaskNotes views with Bases plugin
 * Requires Obsidian 1.10.1+ (public Bases API with groupBy support)
 */
export async function registerBasesTaskList(plugin: TaskNotesPlugin): Promise<void> {
	if (!plugin.settings.enableBases) return;
	// All views now require Obsidian 1.10.1+ (public Bases API with groupBy support)
	if (!requireApiVersion("1.10.1")) return;
	const logger = createTaskNotesLogger({
		tag: "Bases/Registration",
		isDebugEnabled: () => plugin.settings.enableDebugLogging,
	});

	const attemptRegistration = async (): Promise<boolean> => {
		try {
			// Register Task List view using public API
			const taskListSuccess = registerBasesView(
				plugin,
				"tasknotesTaskList",
				{
					name: "TaskNotes Task List",
					icon: "tasknotes-simple",
					factory: buildTaskListViewFactory(plugin),
					options: () => [
						{
							type: "property",
							key: "subGroup",
							displayName: "Sub-group by",
							placeholder: "Select property for sub-grouping (optional)",
							filter: (prop: string) => {
								// Show all note, task, and formula properties that could be used for sub-grouping
								return prop.startsWith("note.") || prop.startsWith("task.") || prop.startsWith("formula.");
							},
						},
						{
							type: "toggle",
							key: "enableSearch",
							displayName: "Enable search box",
							default: false,
						},
						{
							type: "dropdown",
							key: "defaultCollapsedState",
							displayName: "Default collapsed state",
							default: "Expanded",
							options: TASK_LIST_DEFAULT_COLLAPSED_STATE_OPTIONS,
						},
						{
							type: "dropdown",
							key: "expandedRelationshipFilterMode",
							displayName: "Expanded relationships",
							default: "inherit",
							options: EXPANDED_RELATIONSHIP_FILTER_MODE_OPTIONS,
						},
						{
							type: "toggle",
							key: "hideTopLevelSubtasks",
							displayName: "Hide top-level subtasks",
							default: false,
						},
					],
				},
				logger
			);

			// Register Kanban view using public API
			const kanbanSuccess = registerBasesView(
				plugin,
				"tasknotesKanban",
				{
					name: "TaskNotes Kanban",
					icon: "tasknotes-simple",
					factory: buildKanbanViewFactory(plugin),
					options: () => [
					{
						type: "property",
						key: "swimLane",
						displayName: "Swim Lane",
						placeholder: "Select property for swim lanes (optional)",
						filter: (prop: string) => {
							// Show all note, task, and formula properties that could be used for swimlanes
							return prop.startsWith("note.") || prop.startsWith("task.") || prop.startsWith("formula.");
						},
					},
					{
						type: "slider",
						key: "columnWidth",
						displayName: "Column Width",
						default: 280,
						min: 200,
						max: 500,
						step: 20,
					},
					{
						type: "toggle",
						key: "hideEmptyColumns",
						displayName: "Hide Empty Columns",
						default: false,
					},
					{
						type: "toggle",
						key: "showHermesArchivedTasks",
						displayName: "Show Hermes archived tasks",
						default: false,
					},
					{
						type: "text",
						key: "pinnedColumns",
						displayName: "Pinned Columns",
						placeholder: "Comma-separated column values to keep visible",
						default: "",
					},
					{
						type: "toggle",
						key: "hideEmptySwimLanes",
						displayName: "Hide Empty Swimlanes",
						default: false,
					},
					{
						type: "toggle",
						key: "enableSearch",
						displayName: "Enable search box",
						default: false,
					},
					{
						type: "toggle",
						key: "explodeListColumns",
						displayName: "Show items in multiple columns",
						default: true,
					},
					{
						type: "toggle",
						key: "consolidateStatusIcon",
						displayName: "Show status icon in column header only",
						default: false,
					},
					{
						type: "dropdown",
						key: "cardLayout",
						displayName: "Card layout",
						default: "default",
						options: KANBAN_CARD_LAYOUT_OPTIONS,
					},
					{
						type: "text",
						key: "columnOrder",
						displayName: "Column Order (Advanced)",
						placeholder: "Auto-managed when dragging columns",
						default: "{}",
					},
					{
						type: "text",
						key: "swimLaneOrder",
						displayName: "Swim Lane Order (Advanced)",
						placeholder: "JSON object keyed by swim lane property",
						default: "{}",
					},
					{
						type: "dropdown",
						key: "expandedRelationshipFilterMode",
						displayName: "Expanded relationships",
						default: "inherit",
						options: EXPANDED_RELATIONSHIP_FILTER_MODE_OPTIONS,
					},
					{
						type: "toggle",
						key: "hideTopLevelSubtasks",
						displayName: "Hide top-level subtasks",
						default: false,
					},
					],
				},
				logger
			);

			const agentRosterSuccess = registerBasesView(
				plugin,
				"tasknotesAgentRoster",
				{
					name: "TaskNotes Agent Roster",
					icon: "users",
					factory: buildAgentRosterViewFactory(plugin),
					options: () => [
						{
							type: "property",
							key: "agentProperty",
							displayName: "Agent property",
							placeholder: "Property used for agent names",
							default: "assignee",
							filter: isNoteTaskOrFormulaProperty,
						},
						{
							type: "property",
							key: "agentFallbackProperty",
							displayName: "Fallback agent property",
							placeholder: "Property used when the agent property is empty",
							default: "contexts",
							filter: isNoteTaskOrFormulaProperty,
						},
						{
							type: "property",
							key: "boardProperty",
							displayName: "Board property",
							placeholder: "Property used for Hermes board names",
							default: "projects",
							filter: isNoteTaskOrFormulaProperty,
						},
						{
							type: "property",
							key: "statusProperty",
							displayName: "Status property",
							placeholder: "Property used for task status",
							default: "status",
							filter: isNoteTaskOrFormulaProperty,
						},
						{
							type: "text",
							key: "defaultBoard",
							displayName: "Default board",
							default: "default",
						},
						{
							type: "text",
							key: "submitStatus",
							displayName: "Submit status",
							default: "triage",
						},
						{
							type: "text",
							key: "submitTag",
							displayName: "Submit tag",
							default: "hermes-submit",
						},
						{
							type: "slider",
							key: "maxTasksPerAgent",
							displayName: "Tasks per agent",
							default: 4,
							min: 1,
							max: 12,
							step: 1,
						},
						{
							type: "text",
							key: "readyStatuses",
							displayName: "Ready statuses",
							default: "triage,todo,scheduled,ready",
						},
						{
							type: "text",
							key: "busyStatuses",
							displayName: "Busy statuses",
							default: "running",
						},
						{
							type: "text",
							key: "reviewStatuses",
							displayName: "Review statuses",
							default: "review",
						},
						{
							type: "text",
							key: "ignoredAgentValues",
							displayName: "Ignored agent values",
							default: "hermes-kanban",
						},
					],
				},
				logger
			);

			const hermesBoardsSuccess = registerBasesView(
				plugin,
				"tasknotesHermesBoards",
				{
					name: "TaskNotes Hermes Boards",
					icon: "columns-3",
					factory: buildHermesBoardsViewFactory(plugin),
					options: () => [
						{
							type: "property",
							key: "boardProperty",
							displayName: "Board property",
							placeholder: "Property used for Hermes board names",
							default: "projects",
							filter: isNoteTaskOrFormulaProperty,
						},
						{
							type: "property",
							key: "statusProperty",
							displayName: "Status property",
							placeholder: "Property used for task status",
							default: "status",
							filter: isNoteTaskOrFormulaProperty,
						},
						{
							type: "property",
							key: "agentProperty",
							displayName: "Agent property",
							placeholder: "Property used for agent names",
							default: "contexts",
							filter: isNoteTaskOrFormulaProperty,
						},
						{
							type: "text",
							key: "defaultBoard",
							displayName: "Default board",
							default: "default",
						},
						{
							type: "text",
							key: "doneStatuses",
							displayName: "Done statuses",
							default: "done,completed",
						},
						{
							type: "text",
							key: "busyStatuses",
							displayName: "Busy statuses",
							default: "running",
						},
						{
							type: "text",
							key: "reviewStatuses",
							displayName: "Review statuses",
							default: "review",
						},
					],
				},
				logger
			);

			// Register Calendar view using public API
			const calendarSuccess = registerBasesView(
				plugin,
				"tasknotesCalendar",
				{
					name: "TaskNotes Calendar",
					icon: "tasknotes-simple",
					factory: buildCalendarViewFactory(plugin),
					options: (config) => buildCalendarViewOptions(plugin, config),
				},
				logger
			);

			// Register Mini Calendar view using public API
			const miniCalendarSuccess = registerBasesView(
				plugin,
				"tasknotesMiniCalendar",
				{
					name: "TaskNotes Mini Calendar",
					icon: "tasknotes-simple",
					factory: buildMiniCalendarViewFactory(plugin),
					options: () => buildMiniCalendarViewOptions(plugin),
				},
				logger
			);

			// Consider it successful if any view registered successfully
			if (
				!taskListSuccess &&
				!kanbanSuccess &&
				!agentRosterSuccess &&
				!hermesBoardsSuccess &&
				!calendarSuccess &&
				!miniCalendarSuccess
			) {
				logger.debug("Bases plugin not available for registration", {
					category: "configuration",
					operation: "register-views",
				});
				return false;
			}

			// Refresh existing Bases views
			plugin.app.workspace.iterateAllLeaves((leaf) => {
				if (leaf.view?.getViewType?.() === "bases") {
					const view = leaf.view as { refresh?: () => void };
					if (typeof view.refresh === "function") {
						try {
							view.refresh();
						} catch (refreshError) {
							logger.debug("Error refreshing Bases view after registration", {
								category: "provider",
								operation: "refresh-existing-view",
								error: refreshError,
							});
						}
					}
				}
			});

			return true;
		} catch (error) {
			logger.warn("Registration attempt failed", {
				category: "provider",
				operation: "register-views",
				error,
			});
			return false;
		}
	};

	// Try immediate registration
	if (await attemptRegistration()) {
		return;
	}

	// If that fails, try a few more times with short delays
	for (let i = 0; i < 5; i++) {
		await new Promise((r) => window.setTimeout(r, 200));
		if (await attemptRegistration()) {
			return;
		}
	}

	logger.warn("Failed to register views after multiple attempts", {
		category: "configuration",
		operation: "register-views",
	});
}

/**
 * Unregister TaskNotes views from Bases plugin
 */
export function unregisterBasesViews(plugin: TaskNotesPlugin): void {
	const logger = createTaskNotesLogger({
		tag: "Bases/Registration",
		isDebugEnabled: () => plugin.settings.enableDebugLogging,
	});
	try {
		// Unregister views using wrapper (uses internal API as public API doesn't provide unregister)
		unregisterBasesView(plugin, "tasknotesTaskList", logger);
		unregisterBasesView(plugin, "tasknotesKanban", logger);
		unregisterBasesView(plugin, "tasknotesAgentRoster", logger);
		unregisterBasesView(plugin, "tasknotesHermesBoards", logger);
		unregisterBasesView(plugin, "tasknotesCalendar", logger);
		unregisterBasesView(plugin, "tasknotesMiniCalendar", logger);
	} catch (error) {
		logger.error("Error during view unregistration", {
			category: "provider",
			operation: "unregister-views",
			error,
		});
	}
}
