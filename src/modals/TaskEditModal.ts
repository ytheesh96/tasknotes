/* eslint-disable @typescript-eslint/no-non-null-assertion -- Modal lifecycle initializes required controls before event handlers run. */
import { App, Notice, TFile } from "obsidian";
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
import { isHermesTask } from "../hermes/hermesTaskNotesIntegration";
import {
	HermesKanbanApiClient,
	getHermesTaskIdentity,
	type HermesTaskDetailResponse,
} from "../hermes/hermesApiClient";
import { createOrUpdateHermesMirrorNote } from "../hermes/hermesMirror";
import type { ModalFieldsConfigLike } from "./taskModalFieldConfig";
import { createTaskNotesLogger } from "../utils/tasknotesLogger";

const tasknotesLogger = createTaskNotesLogger({ tag: "Modals/TaskEditModal" });
const HERMES_HUMAN_REVIEW_ASSIGNEE = "Vaitheesh";

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
		this.createHermesActionsSection(container);
		createCompletionsCalendarSection(container, {
			task: this.task,
			plugin: this.plugin,
			completedInstancesChanges: this.completedInstancesChanges,
			translate: (key, params) => this.t(key, params),
		});
		this.createMetadataSection(container);
	}

	private createHermesActionsSection(container: HTMLElement): void {
		if (!isHermesTask(this.task)) {
			return;
		}

		const status = this.getHermesStatus();
		const board = this.getHermesCustomString("hermes_board");
		const section = container.createDiv("tn-task-modal__hermes-actions");
		section.createDiv("tn-task-modal__section-label").textContent = "Hermes Actions";

		const meta = section.createDiv("tn-task-modal__hermes-meta");
		if (board) {
			meta.createSpan("tn-task-modal__hermes-pill").textContent = board;
		}
		if (status) {
			meta.createSpan("tn-task-modal__hermes-pill").textContent = status;
		}

		const buttons = section.createDiv("tn-task-modal__hermes-action-buttons");
		this.createHermesActionButton(buttons, "Add comment", () => {
			void this.handleHermesCommentAction();
		});
		this.createHermesActionButton(
			buttons,
			"Request human review",
			() => {
				void this.handleHermesHumanReviewAction();
			},
			{
				disabled: status === "archived",
			}
		);
	}

	private createHermesActionButton(
		container: HTMLElement,
		text: string,
		onClick: () => void,
		options: { disabled?: boolean; title?: string } = {}
	): void {
		const button = container.createEl("button", {
			text,
			cls: "tn-task-modal__hermes-action-button",
		});
		button.disabled = !!options.disabled;
		if (options.title) {
			button.title = options.title;
		}
		button.addEventListener("click", onClick);
	}

	private getHermesCustomString(key: string): string {
		const value = this.task.customProperties?.[key];
		return typeof value === "string" ? value.trim() : "";
	}

	private getHermesStatus(): string {
		return (this.getHermesCustomString("hermes_status") || this.task.status || "")
			.trim()
			.toLowerCase();
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
	): Promise<void> {
		if (this.hasUnsavedHermesModalChanges()) {
			new Notice("Save or cancel the current edits before sending a Hermes action.");
			return;
		}

		const identity = getHermesTaskIdentity(this.task);
		if (!identity) {
			new Notice("This task is missing a Hermes board or task id.");
			return;
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
			new Notice(`${actionLabel} sent to Hermes`);
			this.forceClose();
		} catch (error) {
			tasknotesLogger.error("Failed to send Hermes action:", {
				category: "persistence",
				operation: "hermes-action",
				error,
			});
			const message = error instanceof Error && error.message ? error.message : String(error);
			new Notice(`Hermes action failed: ${message}`);
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

	private async handleHermesCommentAction(): Promise<void> {
		const comment = await this.promptHermesActionText({
			title: "Add Hermes comment",
			placeholder: "Comment",
			confirmText: "Add comment",
		});
		if (!comment) return;
		await this.sendHermesAction("Comment", async (api, identity) => {
			await api.addComment(identity, { body: comment, author: "tasknotes" });
			return api.getTask(identity);
		});
	}

	private async handleHermesHumanReviewAction(): Promise<void> {
		const reason = await this.promptHermesActionText({
			title: "Request human review",
			placeholder: "What decision or review is needed?",
			confirmText: "Request review",
		});
		if (!reason) return;
		await this.sendHermesAction("Human review", async (api, identity) => {
			await api.addComment(identity, {
				body: `Human review requested for ${HERMES_HUMAN_REVIEW_ASSIGNEE}: ${reason}`,
				author: "tasknotes",
			});
			return api.getTask(identity);
		});
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
			new Notice("This task is missing a Hermes board or task id.");
			return;
		}

		if (hasSubtaskChanges) {
			new Notice("Hermes subtasks are not wired yet. Use Blocking / Blocked By links.");
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
			new Notice("Hermes details are read-only here for now. Use Add comment for updates.");
		}

		if (!didHermesWrite) {
			new Notice("No Hermes-backed changes to save.");
			return;
		}

		const detail = await api.getTask(identity);
		const updatedTask = await this.refreshHermesMirror(identity.board, detail);
		if (this.options.onTaskUpdated) {
			this.options.onTaskUpdated(updatedTask);
		}
		this.pendingBlockingUpdates = { added: [], removed: [], raw: {} };
		this.unresolvedBlockingEntries = [];
		new Notice(`Hermes task updated: ${updatedTask.title}`);
	}

	private async hermesUpdatePayloadFromChanges(changes: Partial<TaskInfo>): Promise<{
		status?: string;
		title?: string;
		priority?: number;
		result?: string;
		summary?: string;
		block_reason?: string;
	} | null> {
		const payload: {
			status?: string;
			title?: string;
			priority?: number;
			result?: string;
			summary?: string;
			block_reason?: string;
		} = {};

		if (typeof changes.title === "string") {
			payload.title = changes.title;
		}
		if (typeof changes.priority === "string") {
			payload.priority = this.hermesPriorityFromTaskNotesPriority(changes.priority);
		}
		if (typeof changes.status === "string") {
			if (changes.status === "running") {
				throw new Error(
					"Hermes running state is claimed by the dispatcher, not TaskNotes."
				);
			}
			payload.status = changes.status;
			if (changes.status === "blocked") {
				const reason = await this.promptHermesActionText({
					title: "Block Hermes task",
					placeholder: "Why is this blocked?",
					confirmText: "Block",
				});
				if (!reason) return null;
				payload.block_reason = reason;
			}
			if (changes.status === "done") {
				const result = await this.promptHermesActionText({
					title: "Complete Hermes task",
					placeholder: "Result / closeout summary",
					confirmText: "Complete",
				});
				if (!result) return null;
				payload.result = result;
				payload.summary = result;
			}
		}

		return payload;
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

			if (isHermesTask(this.task)) {
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
			if (isHermesTask(this.task)) {
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
			new Notice("This task is missing a Hermes board or task id.");
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
		new Notice(nextStatus === "archived" ? "Hermes task archived" : "Hermes task restored");
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
			if (isHermesTask(this.task)) {
				const identity = getHermesTaskIdentity(this.task);
				if (!identity) {
					new Notice("This task is missing a Hermes board or task id.");
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
