import { App, Menu, Notice, setIcon, setTooltip, TFile } from "obsidian";
import TaskNotesPlugin from "../main";
import { TaskModal } from "./TaskModal";
import { TaskInfo } from "../types";
import { sanitizeTags } from "../utils/helpers";
import {
	NaturalLanguageParser,
	ParsedTaskData as NLParsedTaskData,
} from "../services/NaturalLanguageParser";
import { combineDateAndTime } from "../utils/dateUtils";

import type {
	EmbeddableMarkdownEditor,
	MarkdownEditorProps,
} from "../editor/EmbeddableMarkdownEditor";
import { createNLPAutocomplete } from "../editor/NLPCodeMirrorAutocomplete";
import { buildCreationBlockingUpdates, buildTaskCreationData } from "./taskCreationData";
import {
	buildTaskCreationFormState,
	type TaskCreationPrepopulatedValues,
} from "./taskCreationFormState";
import { applyTaskCreationSubtaskAssignments } from "./taskCreationSubtasks";
import { NLPSuggest } from "./taskCreationSuggest";
import { shouldShowFilenameShortenedNotice } from "../utils/filenameGenerator";
import { setTaskModalDetailsEditorValue } from "./taskModalDetailsEditor";
import { collapseTaskModalDetailsLayout } from "./taskModalLayout";
import type { ModalFieldsConfigLike } from "./taskModalFieldConfig";
import { createTaskNotesLogger } from "../utils/tasknotesLogger";
import type { TaskModalActionIconSpec } from "./taskModalActionBar";
import {
	HermesKanbanApiClient,
	getHermesTaskIdentity,
	type HermesCreateTaskPayload,
} from "../hermes/hermesApiClient";
import { createHermesKanbanClient } from "../hermes/hermesKanbanTransport";
import { createOrUpdateHermesMirrorNote } from "../hermes/hermesMirror";
import { normalizeHermesAssignee } from "../hermes/hermesAssignee";
import {
	canonicalHermesBoardProjects,
	defaultHermesAssignees,
	defaultHermesBoards,
	getHermesBoardFromProjects,
	hermesBoardProject,
	splitHermesList,
	validateHermesAssigneeSelection,
	validateHermesBoardSelection,
} from "../hermes/hermesRouting";
import {
	HermesAvailabilityService,
	type HermesAvailabilityHealth,
	type HermesDashboardStartResult,
} from "../hermes/hermesAvailabilityService";
import {
	getHermesManagedCreationBoard,
	HermesWriteGuard,
} from "../hermes/hermesWriteGuard";
import { getTaskInfoFromNoteFirst } from "../utils/taskInfoRead";

const tasknotesLogger = createTaskNotesLogger({ tag: "Modals/TaskCreationModal" });
export type { StatusSuggestion } from "./taskCreationSuggest";

const TASK_CREATION_FAILURE_PREFIX = "Failed to create task: ";
const NLP_TAB_ORDER_SELECTOR = [
	"button",
	"a[href]",
	"input",
	"select",
	"textarea",
	"[tabindex]:not([tabindex='-1'])",
	".tn-task-modal__markdown-editor--nlp",
].join(", ");
const NATIVE_FOCUSABLE_TAG_NAMES = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA"]);

type PotentiallyDisabledElement = HTMLElement & { disabled?: boolean };

function isFocusableModalElement(element: HTMLElement): boolean {
	if ((element as PotentiallyDisabledElement).disabled) {
		return false;
	}

	return element.tabIndex >= 0 || NATIVE_FOCUSABLE_TAG_NAMES.has(element.tagName);
}

export function getTaskCreationFailureNoticeMessage(error: unknown): string {
	const rawMessage = error instanceof Error && error.message ? error.message : String(error);
	return rawMessage.startsWith(TASK_CREATION_FAILURE_PREFIX)
		? rawMessage.slice(TASK_CREATION_FAILURE_PREFIX.length)
		: rawMessage;
}

export interface TaskCreationOptions {
	prePopulatedValues?: TaskCreationPrepopulatedValues;
	onTaskCreated?: (task: TaskInfo) => void;
	creationContext?: "manual-creation" | "modal-inline-creation"; // Folder behavior context
	modalTitle?: string;
	saveButtonText?: string;
	modalFieldsConfig?: ModalFieldsConfigLike;
	creationTargetPicker?: {
		boards: string[];
		selectedTarget: string;
	};
	hermesBoardPicker?: {
		boards: string[];
		selectedBoard: string;
	};
}

const DEFAULT_CREATION_TARGET = "default";
const HERMES_TARGET_PREFIX = "hermes:";
const GOAL_MODE_TAGS = new Set(["goal", "#goal", "hermes-goal"]);

type HermesCreationTaskData = Partial<TaskInfo> & {
	customFrontmatter?: Record<string, unknown>;
};

type OpenTaskAfterCreationMode = TaskNotesPlugin["settings"]["openTaskAfterCreation"];
type CreatedTaskOpenMode = Exclude<OpenTaskAfterCreationMode, "none">;

export function shouldOpenCreatedTaskAfterSave(
	mode: OpenTaskAfterCreationMode | undefined,
	options: { createAnother?: boolean },
	hasCreationCallback: boolean
): mode is CreatedTaskOpenMode {
	return (
		(mode === "same-tab" || mode === "new-tab") &&
		!options.createAnother &&
		!hasCreationCallback
	);
}

export async function openCreatedTaskFileAfterSave(
	app: App,
	file: TFile,
	mode: CreatedTaskOpenMode
): Promise<void> {
	const leaf = mode === "new-tab" ? app.workspace.getLeaf("tab") : app.workspace.getLeaf(false);
	await leaf.openFile(file);
}

function createEmbeddableMarkdownEditor(
	app: App,
	container: HTMLElement,
	options: Partial<MarkdownEditorProps>
): EmbeddableMarkdownEditor {
	// Lazy-load because the editor module resolves Obsidian internals during evaluation.
	/* eslint-disable @typescript-eslint/no-require-imports -- Modal editor is lazy-loaded to avoid evaluating Obsidian internals during import. */
	const editorModule =
		require("../editor/EmbeddableMarkdownEditor") as typeof import("../editor/EmbeddableMarkdownEditor");
	/* eslint-enable @typescript-eslint/no-require-imports -- Re-enable after the isolated lazy import. */
	return new editorModule.EmbeddableMarkdownEditor(app, container, options);
}

export class TaskCreationModal extends TaskModal {
	private options: TaskCreationOptions;
	private nlParser: NaturalLanguageParser;
	private nlInput: HTMLTextAreaElement = undefined as unknown as HTMLTextAreaElement; // Legacy - keeping for compatibility
	private nlMarkdownEditor: EmbeddableMarkdownEditor | null = null;
	private nlPreviewContainer: HTMLElement = undefined as unknown as HTMLElement;
	private nlButtonContainer: HTMLElement = undefined as unknown as HTMLElement;
	private nlpSuggest: NLPSuggest | null = null; // Will be replaced with CodeMirror autocomplete
	private selectedHermesBoard: string | null = null;
	private selectedCreationTarget = DEFAULT_CREATION_TARGET;
	private nonHermesStatus: string | null = null;
	private hermesBoardOptions: string[] | null = null;
	private hermesAssigneeOptions: string[] | null = null;
	private hermesBoardSelectEl: HTMLSelectElement | null = null;
	private isSubmitting = false;

	// Track event listeners for cleanup
	private eventListeners: Array<{
		element: HTMLElement | HTMLTextAreaElement;
		event: string;
		handler: EventListener;
	}> = [];

	constructor(app: App, plugin: TaskNotesPlugin, options: TaskCreationOptions = {}) {
		super(app, plugin);
		this.options = options;
		this.nlParser = NaturalLanguageParser.fromPlugin(plugin);
		this.selectedHermesBoard = options.hermesBoardPicker?.selectedBoard ?? null;
		this.selectedCreationTarget =
			options.creationTargetPicker?.selectedTarget ??
			(this.selectedHermesBoard
				? this.getHermesTargetId(this.selectedHermesBoard)
				: DEFAULT_CREATION_TARGET);
	}

	getModalTitle(): string {
		return (
			this.options.modalTitle ??
			(this.isHermesCreationTarget() ? "Submit to Hermes" : this.t("modals.taskCreation.title"))
		);
	}

	protected isCreationMode(): boolean {
		return true;
	}

	protected getModalFieldsConfig(): ModalFieldsConfigLike | undefined {
		return this.options.modalFieldsConfig ?? super.getModalFieldsConfig();
	}

	protected getPrimaryActionText(): string | undefined {
		return this.options.saveButtonText ?? (this.isHermesCreationTarget() ? "Submit to Hermes" : undefined);
	}

	/**
	 * Add an event listener and track it for cleanup
	 */
	private addTrackedEventListener(
		element: HTMLElement | HTMLTextAreaElement,
		event: string,
		handler: EventListener
	): void {
		element.addEventListener(event, handler);
		this.eventListeners.push({ element, event, handler });
	}

	/**
	 * Remove all tracked event listeners
	 */
	private removeAllEventListeners(): void {
		for (const { element, event, handler } of this.eventListeners) {
			element.removeEventListener(event, handler);
		}
		this.eventListeners = [];
	}

	/**
	 * Override to use NLP input when enabled, otherwise fall back to title input
	 */
	protected createPrimaryInput(container: HTMLElement): void {
		if (this.plugin.settings.enableNaturalLanguageInput) {
			this.createNaturalLanguageInput(container);
		} else {
			// Fall back to regular title input
			this.createTitleInput(container);
			// When NLP is disabled, start with the modal expanded
			this.isExpanded = true;
			this.containerEl.addClass("expanded");
		}
	}

	/**
	 * Override to re-render projects list after modal content is created
	 */
	protected createAdditionalSections(container: HTMLElement): void {
		// Re-render projects list if pre-populated values were applied or defaults are set
		if (
			(this.options.prePopulatedValues && this.options.prePopulatedValues.projects) ||
			this.selectedProjectItems.length > 0
		) {
			this.renderProjectsList();
		}
	}

	private createNaturalLanguageInput(container: HTMLElement): void {
		const nlContainer = container.createDiv("nl-input-container");

		// Create markdown editor container
		const editorContainer = nlContainer.createDiv(
			"tn-task-modal__markdown-editor tn-task-modal__markdown-editor--nlp"
		);
		editorContainer.setAttribute("role", "textbox");
		editorContainer.setAttribute("aria-label", this.t("modals.taskCreation.nlPlaceholder"));
		editorContainer.setAttribute("aria-multiline", "true");

		// Preview container
		this.nlPreviewContainer = nlContainer.createDiv("nl-preview-container");
		this.nlPreviewContainer.setAttribute("role", "status");
		this.nlPreviewContainer.setAttribute("aria-live", "polite");
		this.nlPreviewContainer.setAttribute("aria-label", "Task preview");

		try {
			// Create NLP autocomplete extension for @, #, +, status triggers
			// Returns array: [autocomplete, keymap]
			const nlpAutocomplete = createNLPAutocomplete(this.plugin);

			// Create embeddable markdown editor with autocomplete
			this.nlMarkdownEditor = createEmbeddableMarkdownEditor(this.app, editorContainer, {
				value: "",
				placeholder: this.t("modals.taskCreation.nlPlaceholder"),
				cls: "nlp-editor",
				extensions: nlpAutocomplete, // Add autocomplete extensions (array)
				enterVimInsertMode: true, // Auto-enter insert mode when vim is enabled (#1410)
				onChange: (value) => {
					// Update preview as user types
					if (value.trim()) {
						this.updateNaturalLanguagePreview(value.trim());
					} else {
						this.clearNaturalLanguagePreview();
					}
				},
				onSubmit: (_editor, shift) => {
					// Ctrl+Enter - save the task
					void this.handleSubmitShortcut(shift);
				},
				onEscape: () => {
					// ESC - close the modal (only when not in vim insert mode)
					// Vim mode will handle its own ESC to exit insert mode
					this.close();
				},
				onTab: (_editor, shift) => {
					if (shift) {
						return this.focusPreviousNaturalLanguageField(editorContainer);
					}
					// Tab - jump to title input (expand form if needed)
					if (!this.isExpanded) {
						this.expandModal();
					}
					// Focus title input
					window.setTimeout(() => {
						const titleInput = this.modalEl.querySelector(
							".title-input-detailed"
						) as HTMLInputElement;
						if (titleInput) {
							titleInput.focus();
						}
					}, 50);
					return true; // Prevent default tab behavior
				},
				onEnter: (editor, mod, shift) => {
					if (mod) {
						// Ctrl/Cmd+Enter - save (already handled by onSubmit)
						return true;
					}
					if (shift) {
						// Shift+Enter - allow newline
						return false;
					}
					// Normal Enter - allow new line
					return false;
				},
			});
		} catch (error) {
			tasknotesLogger.error("Failed to create NLP markdown editor:", {
				category: "persistence",
				operation: "create-nlp-markdown-editor",
				error: error,
			});
			// Fallback to textarea if editor creation fails
			this.nlInput = editorContainer.createEl("textarea", {
				cls: "nl-input",
				attr: {
					placeholder: this.t("modals.taskCreation.nlPlaceholder"),
					rows: "3",
				},
			});

			// Event listeners for fallback - track them for cleanup
			const inputHandler = () => {
				const input = this.nlInput.value.trim();
				if (input) {
					this.updateNaturalLanguagePreview(input);
				} else {
					this.clearNaturalLanguagePreview();
				}
			};
			this.addTrackedEventListener(this.nlInput, "input", inputHandler);

			const keydownHandler = (e: Event) => {
				const input = this.nlInput.value.trim();
				if (!input) return;

				const keyEvent = e as KeyboardEvent;
				if (keyEvent.key === "Enter" && (keyEvent.ctrlKey || keyEvent.metaKey)) {
					keyEvent.preventDefault();
					void this.handleSubmitShortcut(keyEvent.shiftKey);
				} else if (keyEvent.key === "Tab" && keyEvent.shiftKey) {
					keyEvent.preventDefault();
					this.parseAndFillForm(input);
				}
			};
			this.addTrackedEventListener(this.nlInput, "keydown", keydownHandler);

			// Initialize auto-suggestion for fallback
			this.nlpSuggest = new NLPSuggest(this.app, this.nlInput, this.plugin);
		}
	}

	private focusPreviousNaturalLanguageField(editorContainer: HTMLElement): boolean {
		const root = this.modalEl.contains(editorContainer) ? this.modalEl : this.contentEl;
		const orderedElements = Array.from(
			root.querySelectorAll<HTMLElement>(NLP_TAB_ORDER_SELECTOR)
		);
		const currentIndex = orderedElements.findIndex(
			(element) => element === editorContainer || editorContainer.contains(element)
		);

		if (currentIndex <= 0) {
			return true;
		}

		const previousElement = orderedElements
			.slice(0, currentIndex)
			.reverse()
			.find(isFocusableModalElement);

		if (previousElement) {
			window.setTimeout(() => {
				previousElement.focus();
			}, 50);
		}

		return true;
	}

	protected focusTitleInput(): void {
		if (!this.plugin.settings.enableNaturalLanguageInput) {
			super.focusTitleInput();
			return;
		}

		window.setTimeout(() => {
			const cm = this.nlMarkdownEditor?.editor?.cm;
			if (cm) {
				cm.focus();
				cm.scrollDOM.scrollTop = 0;
				return;
			}

			if (this.nlInput) {
				this.nlInput.focus({ preventScroll: true });
				this.nlInput.select();
			}
		}, this.getInitialFocusDelay());
	}

	private updateNaturalLanguagePreview(input: string): void {
		if (!this.nlPreviewContainer) return;

		const parsed = this.nlParser.parseInput(input);
		const previewData = this.nlParser.getPreviewData(parsed);

		if (previewData.length > 0 && parsed.title) {
			this.nlPreviewContainer.empty();
			this.nlPreviewContainer.classList.add("nl-preview-container--visible");
			this.nlPreviewContainer.classList.remove(
				"tn-static-display-flex-4d51fc62",
				"tn-static-display-flex-75816cae",
				"tn-static-display-flex-8bb39979",
				"tn-static-display-inline-block-60e32dcb",
				"tn-static-display-inline-cccfa456",
				"tn-static-display-inline-flex-f984c520",
				"tn-static-display-none-6b99de8b",
				"tn-static-min-height-800px-997b4c8c"
			);

			previewData.forEach((item) => {
				const previewItem = this.nlPreviewContainer.createDiv("nl-preview-item");
				previewItem.textContent = item.text;
			});
		} else {
			this.clearNaturalLanguagePreview();
		}
	}

	private clearNaturalLanguagePreview(): void {
		if (this.nlPreviewContainer) {
			this.nlPreviewContainer.empty();
			this.nlPreviewContainer.classList.remove("nl-preview-container--visible");
			this.nlPreviewContainer.classList.remove(
				"tn-static-display-block-2a1b75c9",
				"tn-static-display-flex-4d51fc62",
				"tn-static-display-flex-75816cae",
				"tn-static-display-flex-8bb39979",
				"tn-static-display-inline-block-60e32dcb",
				"tn-static-display-inline-cccfa456",
				"tn-static-display-inline-flex-f984c520",
				"tn-static-min-height-800px-997b4c8c"
			);
		}
	}

	/**
	 * Get the current NLP input value from either markdown editor or fallback textarea
	 */
	private getNLPInputValue(): string {
		if (this.nlMarkdownEditor) {
			return this.nlMarkdownEditor.value;
		} else if (this.nlInput) {
			return this.nlInput.value;
		}
		return "";
	}

	protected createActionBar(container: HTMLElement): void {
		this.actionBar = container.createDiv("tn-task-modal__action-bar");

		// NLP-specific icons (only if NLP is enabled)
		if (this.plugin.settings.enableNaturalLanguageInput) {
			// Fill form icon
			this.createActionIcon(
				this.actionBar,
				"wand",
				this.t("modals.taskCreation.actions.fillFromNaturalLanguage"),
				(icon, event) => {
					const input = this.getNLPInputValue().trim();
					if (input) {
						this.parseAndFillForm(input);
					}
				}
			);

			// Expand/collapse icon
			this.createActionIcon(
				this.actionBar,
				this.isExpanded ? "chevron-up" : "chevron-down",
				this.isExpanded
					? this.t("modals.taskCreation.actions.hideDetailedOptions")
					: this.t("modals.taskCreation.actions.showDetailedOptions"),
				(icon, event) => {
					this.toggleDetailedForm();
					// Update icon and tooltip
					const iconEl = icon.querySelector(".icon");
					if (iconEl) {
						setIcon(
							iconEl as HTMLElement,
							this.isExpanded ? "chevron-up" : "chevron-down"
						);
					}
					setTooltip(
						icon,
						this.isExpanded
							? this.t("modals.taskCreation.actions.hideDetailedOptions")
							: this.t("modals.taskCreation.actions.showDetailedOptions"),
						{ placement: "top" }
					);
				}
			);

			// Add separator
			const separator = this.actionBar.createDiv("action-separator");
			separator.classList.remove(
				"tn-static-width-100-0466783d",
				"tn-static-width-12px-fbf353fb",
				"tn-static-width-16px-7375d50b",
				"tn-static-width-200px-2acaf3b5",
				"tn-static-width-60px-bd09c419",
				"tn-static-width-80px-8573bae3"
			);
			separator.classList.add("tn-static-width-1px-aa77e27e");
			separator.classList.remove(
				"tn-static-display-flex-4d51fc62",
				"tn-static-height-0-7a31cef0",
				"tn-static-height-100-62264068",
				"tn-static-height-12px-06c0747e",
				"tn-static-height-16px-30de4aee",
				"tn-static-min-height-800px-997b4c8c"
			);
			separator.classList.add("tn-static-height-24px-29a11d37");
			separator.classList.remove(
				"tn-static-background-color-var-background-se-9087a23e",
				"tn-static-background-color-var-color-base-40-ef5f175e",
				"tn-static-background-color-var-color-red-134bc721",
				"tn-static-background-color-var-text-accent-a954c70f"
			);
			separator.classList.add("tn-static-background-color-var-background-mo-94b219f0");
			separator.classList.remove(
				"tn-static-margin-0-11696618",
				"tn-static-margin-0-auto-266e9b04",
				"tn-static-margin-0-db0d5f36",
				"tn-static-margin-2px-0-edce9b14",
				"tn-static-margin-8px-0-0-0-a2eb8382",
				"tn-static-padding-12px-43bef435",
				"tn-static-padding-20px-ebe8e48c"
			);
			separator.classList.add("tn-static-margin-0-var-size-4-2-77f7dc08");
		}

		this.createCoreActionIcons(this.actionBar);
		this.updateIconStates();
	}

	protected getCoreActionIconSpecs(): TaskModalActionIconSpec[] {
		const specs = super.getCoreActionIconSpecs();
		if (!this.hasHermesBoardPicker()) {
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

	private parseAndFillForm(input: string): void {
		const parsed = this.nlParser.parseInput(input);
		this.applyParsedData(parsed);

		// Expand the form to show filled fields
		if (!this.isExpanded) {
			this.expandModal();
		}
	}

	private applyParsedData(parsed: NLParsedTaskData): void {
		if (parsed.title) this.title = parsed.title;
		if (parsed.status) this.status = parsed.status;
		if (parsed.priority) this.priority = parsed.priority;

		// Handle due date with time
		if (parsed.dueDate) {
			this.dueDate = parsed.dueTime
				? combineDateAndTime(parsed.dueDate, parsed.dueTime)
				: parsed.dueDate;
		}

		// Handle scheduled date with time
		if (parsed.scheduledDate) {
			this.scheduledDate = parsed.scheduledTime
				? combineDateAndTime(parsed.scheduledDate, parsed.scheduledTime)
				: parsed.scheduledDate;
		}

		if (parsed.contexts && parsed.contexts.length > 0)
			this.contexts = parsed.contexts.join(", ");
		// Projects will be handled in the form input update section below
		if (parsed.tags && parsed.tags.length > 0) this.tags = sanitizeTags(parsed.tags.join(", "));
		if (parsed.details) this.details = parsed.details;
		if (parsed.recurrence) this.recurrenceRule = parsed.recurrence;
		if (parsed.estimate !== undefined) {
			this.timeEstimate = parsed.estimate > 0 ? parsed.estimate : 0;
			if (this.timeEstimateInput) {
				this.timeEstimateInput.value =
					this.timeEstimate > 0 ? this.timeEstimate.toString() : "";
			}
		}

		// Update form inputs if they exist
		if (this.titleInput) this.titleInput.value = this.title;
		if (this.detailsInput) this.detailsInput.value = this.details;
		setTaskModalDetailsEditorValue(this.detailsMarkdownEditor, this.details);
		if (this.contextsInput) this.contextsInput.value = this.contexts;
		if (this.tagsInput) this.tagsInput.value = this.tags;

		// Handle projects differently - they use file selection, not text input
		if (parsed.projects && parsed.projects.length > 0) {
			this.addProjectsFromStrings(parsed.projects);
			this.renderProjectsList();
		}

		// Handle user-defined fields
		if (parsed.userFields) {
			for (const [fieldId, value] of Object.entries(parsed.userFields)) {
				const userField = this.plugin.settings.userFields?.find((f) => f.id === fieldId);
				if (userField) {
					this.userFields[userField.key] = value;
				}
			}
			this.updateUserFieldControls();
		}

		this.syncHermesBoardSelection();

		// Update icon states
		this.updateIconStates();
	}

	private toggleDetailedForm(): void {
		if (this.isExpanded) {
			// Collapse
			this.isExpanded = false;
			collapseTaskModalDetailsLayout({
				detailsContainer: this.detailsContainer,
				splitRightColumn: this.splitRightColumn,
			});
			this.containerEl.removeClass("expanded");
		} else {
			// Expand
			this.expandModal();
		}
	}

	async initializeFormData(): Promise<void> {
		const formState = buildTaskCreationFormState({
			defaultPriority: this.plugin.settings.defaultTaskPriority,
			defaultStatus: this.plugin.settings.defaultTaskStatus,
			taskCreationDefaults: this.plugin.settings.taskCreationDefaults,
			taskTag: this.plugin.settings.taskTag,
			userFields: this.plugin.settings.userFields,
			prePopulatedValues: this.options.prePopulatedValues,
		});

		this.title = formState.title;
		this.dueDate = formState.dueDate;
		this.scheduledDate = formState.scheduledDate;
		this.priority = formState.priority;
		this.status = formState.status;
		this.nonHermesStatus = this.isHermesCreationTarget()
			? this.plugin.settings.defaultTaskStatus
			: formState.status;
		this.contexts = formState.contexts;
		this.tags = formState.tags;
		this.timeEstimate = formState.timeEstimate;
		this.recurrenceRule = formState.recurrenceRule;
		this.recurrenceAnchor = formState.recurrenceAnchor;
		this.reminders = formState.reminders;
		this.userFields = formState.userFields;

		if (formState.projectStrings.length > 0) {
			this.initializeProjectsFromStrings(formState.projectStrings);
		}

		this.defaultHermesCreationTargetFromPrefill();
		this.syncHermesBoardSelection();

		this.details = this.normalizeDetails(this.details);
		this.originalDetails = this.details;
	}

	private defaultHermesCreationTargetFromPrefill(): void {
		if (this.options.creationTargetPicker?.selectedTarget || this.isHermesCreationTarget()) {
			return;
		}
		const board = getHermesManagedCreationBoard({
			projects: this.projects,
			tags: this.tags,
		});
		if (!board) {
			return;
		}
		this.selectedHermesBoard = board;
		this.selectedCreationTarget = this.getHermesTargetId(board);
	}

	protected async handleSubmitShortcut(shift: boolean): Promise<void> {
		await this.handleSave({ createAnother: shift });
	}

	async handleSave(options: { createAnother?: boolean } = {}): Promise<void> {
		if (this.isSubmitting) {
			return;
		}
		this.isSubmitting = true;
		this.setPrimaryActionDisabled(true);
		try {
			// If NLP is enabled and there's content in the NL field, parse it first
			if (this.plugin.settings.enableNaturalLanguageInput) {
				const nlContent = this.getNLPInputValue().trim();
				if (nlContent && !this.title.trim()) {
					// Only auto-parse if no title has been manually entered
					const parsed = this.nlParser.parseInput(nlContent);
					this.applyParsedData(parsed);
				}
			}

			this.syncHermesBoardSelection();

			if (!this.validateForm()) {
				new Notice(this.t("modals.taskCreation.notices.titleRequired"));
				return;
			}

			try {
				if (this.isHermesCreationTarget()) {
					await this.handleHermesApiCreate(options);
					return;
				}

				const taskData = this.buildTaskData();
				const hermesManagedBoard = getHermesManagedCreationBoard({
					projects: taskData.projects ?? this.projects,
					tags: taskData.tags ?? this.tags,
				});
				if (hermesManagedBoard) {
					await this.handleHermesApiCreate(options, {
						board: hermesManagedBoard,
						taskData,
					});
					return;
				}

				await this.assertHermesManagedCreationAllowed(taskData);
				// Disable defaults since they were already applied to form fields in initializeFormData()
				const result = await this.plugin.taskService.createTask(taskData, {
					applyDefaults: false,
				});
				let createdTask = result.taskInfo;

				if (
					shouldShowFilenameShortenedNotice(
						this.plugin.settings,
						result.taskInfo.title,
						result.file.basename
					)
				) {
					new Notice(
						this.t("modals.taskCreation.notices.successShortened", {
							title: createdTask.title,
						})
					);
				} else {
					new Notice(
						this.t("modals.taskCreation.notices.success", { title: createdTask.title })
					);
				}

				if (this.blockingItems.length > 0) {
					const blockingUpdates = buildCreationBlockingUpdates(this.blockingItems);

					if (blockingUpdates.added.length > 0) {
						await this.plugin.taskService.updateBlockingRelationships(
							createdTask,
							blockingUpdates.added,
							[],
							blockingUpdates.raw
						);
						const refreshed = await getTaskInfoFromNoteFirst(
							this.plugin,
							createdTask.path
						);
						if (refreshed) {
							createdTask = refreshed;
						}
					}

					if (blockingUpdates.unresolved.length > 0) {
						new Notice(
							this.t("modals.taskCreation.notices.blockingUnresolved", {
								entries: blockingUpdates.unresolved.join(", "),
							})
						);
					}

					this.blockingItems = [];
				}

				// Handle subtask assignments
				if (this.selectedSubtaskFiles.length > 0) {
					await this.applySubtaskAssignments(createdTask);
				}

				if (this.options.onTaskCreated) {
					this.options.onTaskCreated(createdTask);
				}

				await this.openCreatedTaskIfConfigured(result.file, options);

				this.close();

				if (options.createAnother) {
					window.setTimeout(() => {
						new TaskCreationModal(this.app, this.plugin, this.options).open();
					}, 0);
				}
			} catch (error) {
				tasknotesLogger.error("Failed to create task:", {
					category: "persistence",
					operation: "create-task",
					error: error,
				});
				const message = getTaskCreationFailureNoticeMessage(error);
				new Notice(this.t("modals.taskCreation.notices.failure", { message }));
			}
		} finally {
			this.isSubmitting = false;
			this.setPrimaryActionDisabled(false);
		}
	}

	private async handleHermesApiCreate(
		options: { createAnother?: boolean } = {},
		input: { board?: string; taskData?: HermesCreationTaskData } = {}
	): Promise<void> {
		const board = input.board ?? this.getSelectedHermesBoard();
		if (!board) {
			throw new Error("Choose a board before submitting.");
		}

		await new HermesWriteGuard({
			transport: this.plugin.settings.hermesKanbanTransport,
		}).assertCanCreateHermesTask(board);

		const routing = await this.validateHermesCreationRouting(board);
		if (routing.error) {
			throw new Error(routing.error);
		}

		const taskData = input.taskData ?? this.buildTaskData();
		const api = new HermesKanbanApiClient();
		const taskCreator = createHermesKanbanClient(this.plugin.settings.hermesKanbanTransport);
		const parentResolution = await this.resolveHermesDependencyIds(this.blockedByItems, board);
		const childResolution = await this.resolveHermesDependencyIds(this.blockingItems, board);
		const assignee = routing.assignee ?? this.hermesAssigneeFromTaskData(taskData);
		const taskStatus =
			typeof taskData.status === "string" && taskData.status.trim()
				? taskData.status.trim()
				: "triage";
		const status =
			this.isHermesCreationTarget() && taskStatus === this.plugin.settings.defaultTaskStatus
				? "triage"
				: taskStatus;
		const createPayload: HermesCreateTaskPayload = {
			title: String(taskData.title || this.title).trim(),
			body: typeof taskData.details === "string" ? taskData.details : undefined,
			status,
			assignee: assignee ?? undefined,
			priority: this.hermesPriorityFromTaskData(),
			created_by: "tasknotes",
			parents: parentResolution.ids,
			triage: status === "triage",
		};
		if (this.isGoalTaggedCreation()) {
			createPayload.idempotency_key = buildHermesGoalModeCreateIdempotencyKey(
				board,
				createPayload
			);
		}
		const created = await taskCreator.createTask(board, createPayload);
		const identity = { board, id: created.id };
		try {
			const postCreateSyncErrors: string[] = [];
			if (this.isGoalTaggedCreation()) {
				try {
					await this.addHermesGoalModeComment(api, identity, taskData);
				} catch (error) {
					postCreateSyncErrors.push(
						`Goal Mode comment sync failed: ${getTaskCreationFailureNoticeMessage(error)}`
					);
				}
			}

			for (const childId of childResolution.ids) {
				try {
					await api.addLink({ board, parentId: created.id, childId });
				} catch (error) {
					postCreateSyncErrors.push(
						`dependency link ${childId} failed: ${getTaskCreationFailureNoticeMessage(error)}`
					);
				}
			}

			const detail = await api.getTask(identity);
			const mirrorTask = detail.task ?? created;

			const { file, taskInfo } = await createOrUpdateHermesMirrorNote(
				this.plugin,
				board,
				mirrorTask,
				{
					parents: detail.links?.parents ?? parentResolution.ids,
					children: detail.links?.children ?? childResolution.ids,
					...(this.isGoalTaggedCreation()
						? {
								extraFrontmatter: {
									hermesCardMode: "goal",
									hermesMode: "goal",
								},
								extraTags: ["goal"],
							}
						: {}),
				}
			);

			if (parentResolution.unresolved.length > 0 || childResolution.unresolved.length > 0) {
				new Notice(
					`Some dependencies were not linked on the board: ${[
						...parentResolution.unresolved,
						...childResolution.unresolved,
					].join(", ")}`
				);
			}

			if (postCreateSyncErrors.length > 0) {
				new Notice(
					getHermesPartialSuccessNoticeMessage({
						mode: this.isGoalTaggedCreation() ? "goal" : "kanban",
						title: created.title,
						id: created.id,
						error: new Error(postCreateSyncErrors.join("; ")),
					})
				);
			} else {
				new Notice(
					this.isGoalTaggedCreation()
						? `Created Goal Mode card: ${created.title}`
						: `Created task: ${created.title}`
				);
			}
			if (this.options.onTaskCreated) {
				this.options.onTaskCreated(taskInfo);
			}
			await this.openCreatedTaskIfConfigured(file, options);
			this.close();

			if (options.createAnother) {
				window.setTimeout(() => {
					new TaskCreationModal(this.app, this.plugin, this.options).open();
				}, 0);
			}
		} catch (error) {
			tasknotesLogger.error(
				"Hermes card was created but TaskNotes post-create sync failed:",
				{
					category: "persistence",
					operation: "create-hermes-task-post-sync",
					error,
				}
			);
			new Notice(
				getHermesPartialSuccessNoticeMessage({
					mode: this.isGoalTaggedCreation() ? "goal" : "kanban",
					title: created.title,
					id: created.id,
					error,
				})
			);
		}
	}

	private async openCreatedTaskIfConfigured(
		file: TFile,
		options: { createAnother?: boolean }
	): Promise<void> {
		const mode = this.plugin.settings.openTaskAfterCreation ?? "none";
		if (!shouldOpenCreatedTaskAfterSave(mode, options, Boolean(this.options.onTaskCreated))) {
			return;
		}

		try {
			await openCreatedTaskFileAfterSave(this.app, file, mode);
		} catch (error) {
			tasknotesLogger.error("Failed to open created task note:", {
				category: "persistence",
				operation: "open-created-task-note",
				error: error,
			});
			new Notice(this.t("modals.taskCreation.notices.openCreatedTaskFailure"));
		}
	}

	private buildTaskData(): HermesCreationTaskData {
		const taskData = buildTaskCreationData({
			title: this.title,
			dueDate: this.dueDate,
			scheduledDate: this.scheduledDate,
			priority: this.priority,
			status: this.status,
			contexts: this.contexts,
			projects: this.projects,
			tags: this.tags,
			timeEstimate: this.timeEstimate,
			recurrenceRule: this.recurrenceRule,
			recurrenceAnchor: this.recurrenceAnchor,
			reminders: this.reminders,
			blockedByItems: this.blockedByItems,
			details: this.details,
			userFields: this.userFields,
			creationContext: this.options.creationContext,
			taskIdentificationMethod: this.plugin.settings.taskIdentificationMethod,
			taskTag: this.plugin.settings.taskTag,
			normalizeDetails: (value) => this.normalizeDetails(value),
		});
		const prePopulatedCustomFrontmatter = this.options.prePopulatedValues?.customFrontmatter;
		if (prePopulatedCustomFrontmatter) {
			taskData.customFrontmatter = {
				...prePopulatedCustomFrontmatter,
				...taskData.customFrontmatter,
			};
		}

		return taskData;
	}

	private hermesAssigneeFromTaskData(taskData: HermesCreationTaskData): string | undefined {
		return normalizeHermesAssignee(taskData.contexts) ?? undefined;
	}

	private hermesPriorityFromTaskData(): number {
		if (this.priority === "high") return 8;
		if (this.priority === "normal") return 5;
		if (this.priority === "low") return 2;
		return 0;
	}

	private isGoalTaggedCreation(): boolean {
		return splitCommaList(this.tags).some((tag) => GOAL_MODE_TAGS.has(tag.toLowerCase()));
	}

	private async addHermesGoalModeComment(
		api: HermesKanbanApiClient,
		identity: { board: string; id: string },
		taskData: HermesCreationTaskData
	): Promise<void> {
		const metadata = this.buildHermesGoalModeMetadata(taskData);
		await api.addComment(identity, {
			body: [
				"Created from Obsidian TaskNotes as a #goal task.",
				"",
				"```json",
				JSON.stringify(metadata, null, 2),
				"```",
			].join("\n"),
		});
	}

	private buildHermesGoalModeMetadata(taskData: HermesCreationTaskData): Record<string, unknown> {
		return {
			hermes_card_mode: "goal",
			hermes_mode: "goal",
			source: "obsidian-tasknotes",
			tasknotes: {
				projects: splitCommaList(this.projects),
				contexts: splitCommaList(this.contexts),
				tags: splitCommaList(this.tags),
				priority: this.priority,
				status: taskData.status ?? this.status,
			},
		};
	}

	private async resolveHermesDependencyIds(
		items: Array<{ path?: string; dependency: { uid: string } }>,
		board: string
	): Promise<{ ids: string[]; unresolved: string[] }> {
		const ids: string[] = [];
		const unresolved: string[] = [];
		for (const item of items) {
			const directId = item.dependency.uid.match(/\b(t_[A-Za-z0-9]+)\b/)?.[1];
			if (item.path) {
				const task = await getTaskInfoFromNoteFirst(this.plugin, item.path);
				const identity = task ? getHermesTaskIdentity(task) : null;
				if (identity && identity.board === board) {
					ids.push(identity.id);
					continue;
				}
			}
			if (directId) {
				ids.push(directId);
			} else {
				unresolved.push(item.dependency.uid);
			}
		}
		return { ids: [...new Set(ids)], unresolved };
	}

	private hasHermesBoardPicker(): boolean {
		return (
			Boolean(this.options.hermesBoardPicker || this.options.creationTargetPicker) &&
			this.getHermesBoardOptions().length > 0
		);
	}

	private getHermesBoardOptions(): string[] {
		return uniqueNonEmpty([
			...(this.hermesBoardOptions ?? []),
			...(this.options.hermesBoardPicker?.boards ?? []),
			...(this.options.creationTargetPicker?.boards ?? []),
			...defaultHermesBoards(),
			...(this.selectedHermesBoard ? [this.selectedHermesBoard] : []),
		]);
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
		this.hermesBoardOptions = this.getHermesBoardOptions();
		return this.hermesBoardOptions;
	}

	private getHermesAssigneeOptions(): string[] {
		return uniqueNonEmpty([
			...(this.hermesAssigneeOptions ?? []),
			...defaultHermesAssignees(),
			...splitHermesList(this.contexts),
		]);
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
		this.hermesAssigneeOptions = this.getHermesAssigneeOptions();
		return this.hermesAssigneeOptions;
	}

	public async recheckHermesAvailability(): Promise<HermesAvailabilityHealth> {
		return this.getHermesAvailabilityService().recheckHealth({
			...this.getHermesTransportCheckOptions(),
			board: this.getSelectedHermesBoard(),
		});
	}

	public async startHermesDashboardAndRefreshOptions(): Promise<HermesDashboardStartResult> {
		const result = await this.plugin.startHermesDashboard({ showNotice: false });
		if (result.health.status === "connected" || result.health.status === "degraded") {
			await this.refreshHermesLiveOptions();
		}
		return result;
	}

	private async refreshHermesLiveOptions(): Promise<void> {
		const selectedBoard = this.getSelectedHermesBoard();
		const transportOptions = this.getHermesTransportCheckOptions();
		const options = transportOptions.transport
			? await this.getHermesAvailabilityService().getOptions(selectedBoard, transportOptions)
			: await this.getHermesAvailabilityService().getOptions(selectedBoard);
		if (options.boards.length > 0) {
			this.hermesBoardOptions = uniqueNonEmpty(options.boards);
			this.renderHermesBoardSelectOptions(this.hermesBoardOptions);
		}
		if (options.assignees.length > 0) {
			this.hermesAssigneeOptions = uniqueNonEmpty(options.assignees);
		}
	}

	private getHermesAvailabilityService(): HermesAvailabilityService {
		return new HermesAvailabilityService({ transport: this.plugin.settings.hermesKanbanTransport });
	}

	private getHermesTransportCheckOptions(): { transport?: "dashboard-api" | "kanban-cli" } {
		return this.plugin.settings.hermesKanbanTransport
			? { transport: this.plugin.settings.hermesKanbanTransport }
			: {};
	}

	private async assertHermesManagedCreationAllowed(
		taskData: HermesCreationTaskData
	): Promise<void> {
		const board =
			getHermesManagedCreationBoard({
				projects: taskData.projects ?? this.projects,
				tags: taskData.tags ?? this.tags,
			}) ??
			(this.options.hermesBoardPicker || this.options.creationTargetPicker
				? this.getSelectedHermesBoard()
				: null);
		if (!board) {
			return;
		}
		await new HermesWriteGuard({
			transport: this.plugin.settings.hermesKanbanTransport,
		}).assertCanCreateHermesTask(board);
	}

	private renderHermesBoardSelectOptions(boards: readonly string[]): void {
		if (!this.hermesBoardSelectEl) {
			return;
		}
		while (this.hermesBoardSelectEl.firstChild) {
			this.hermesBoardSelectEl.removeChild(this.hermesBoardSelectEl.firstChild);
		}
		for (const board of boards) {
			const option = this.hermesBoardSelectEl.ownerDocument.createElement("option");
			option.value = board;
			option.text = board;
			this.hermesBoardSelectEl.appendChild(option);
		}
		const currentBoard = this.getSelectedHermesBoard();
		const nextBoard = boards.includes(currentBoard) ? currentBoard : boards[0];
		if (nextBoard) {
			this.setCreationTarget(this.getHermesTargetId(nextBoard));
			this.hermesBoardSelectEl.value = nextBoard;
		}
	}

	private async validateHermesCreationRouting(
		selectedBoard: string
	): Promise<{ assignee: string | null; error?: string }> {
		const acceptedBoards = await this.resolveHermesBoardOptions();
		const boardResult = validateHermesBoardSelection(
			this.projects,
			acceptedBoards,
			selectedBoard
		);
		if (boardResult.error) {
			return { assignee: null, error: boardResult.error };
		}

		const acceptedAssignees = await this.resolveHermesAssigneeOptions(selectedBoard);
		return validateHermesAssigneeSelection(this.contexts, acceptedAssignees);
	}

	protected createContextsField(container: HTMLElement): void {
		if (!this.isHermesCreationTarget()) {
			super.createContextsField(container);
			return;
		}
	}

	protected createProjectsField(container: HTMLElement): void {
		if (!this.isHermesCreationTarget()) {
			super.createProjectsField(container);
			return;
		}

		this.hermesBoardSelectEl = null;
	}

	private getHermesBoardTooltip(): string {
		const board = this.getSelectedHermesBoard();
		if (this.isHermesCreationTarget() && board) {
			return `Board: ${board}`;
		}
		return board ? `Choose board: ${board}` : "Choose board";
	}

	private getHermesAssigneeTooltip(): string {
		const assignee = normalizeHermesAssignee(this.contexts);
		return assignee ? `Assignee: ${assignee}` : "Assignee: Unassigned";
	}

	private getSelectedHermesBoard(): string {
		if (this.selectedCreationTarget.startsWith(HERMES_TARGET_PREFIX)) {
			return this.selectedCreationTarget.slice(HERMES_TARGET_PREFIX.length);
		}
		return (
			this.selectedHermesBoard ??
			this.options.hermesBoardPicker?.selectedBoard ??
			getHermesBoardFromProjects(this.projects, this.getHermesBoardOptions()) ??
			""
		);
	}

	private getHermesTargetId(board: string): string {
		return `${HERMES_TARGET_PREFIX}${board}`;
	}

	private isHermesCreationTarget(): boolean {
		return this.selectedCreationTarget.startsWith(HERMES_TARGET_PREFIX);
	}

	private getCreationTargetLabel(): string {
		if (this.isHermesCreationTarget()) {
			return `Board/${this.getSelectedHermesBoard()}`;
		}
		return "Board";
	}

	private async showHermesBoardContextMenu(event: UIEvent): Promise<void> {
		const boards = await this.resolveHermesBoardOptions();
		if (boards.length === 0) return;

		const menu = new Menu();
		const currentBoard = this.getSelectedHermesBoard();
		for (const board of boards) {
			menu.addItem((item) => {
				const isSelected = this.isHermesCreationTarget() && board === currentBoard;
				item.setTitle(`Board/${board}`);
				item.setIcon(isSelected ? "check" : "columns-3");
				item.setChecked(isSelected);
				item.onClick(() => {
					this.setCreationTarget(this.getHermesTargetId(board));
				});
			});
		}

		this.showMenuForEvent(menu, event);
	}

	private async showHermesAssigneeContextMenu(event: UIEvent): Promise<void> {
		const currentAssignee = normalizeHermesAssignee(this.contexts);
		const assignees = uniqueNonEmpty([
			...(currentAssignee ? [currentAssignee] : []),
			...(await this.resolveHermesAssigneeOptions(this.getSelectedHermesBoard())),
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

	private setCreationTarget(target: string): void {
		if (!target) return;

		if (!this.isHermesCreationTarget()) {
			this.nonHermesStatus = this.status;
		}

		const previousTarget = this.selectedCreationTarget;
		this.selectedCreationTarget = target;
		if (this.isHermesCreationTarget()) {
			const board = this.getSelectedHermesBoard();
			this.selectedHermesBoard = board;
			this.applyHermesSubmissionState(board);
		} else {
			this.clearHermesSubmissionState();
		}

		this.renderModalTitle();
		this.updatePrimaryActionButtonText();
		this.updateIconStates();

		if (previousTarget !== target) {
			new Notice(`Task target set to ${this.getCreationTargetLabel()}`);
		}
	}

	private applyHermesSubmissionState(board: string): void {
		if (!board) return;

		this.projects = withHermesBoardProject(this.projects, this.getHermesBoardOptions(), board);
		this.initializeProjectsFromStrings(splitCommaList(this.projects));
		this.syncVisibleHermesFields();
	}

	private clearHermesSubmissionState(): void {
		this.status = this.nonHermesStatus ?? this.plugin.settings.defaultTaskStatus;
		this.projects = withoutHermesBoardProject(this.projects, this.getHermesBoardOptions());
		this.initializeProjectsFromStrings(splitCommaList(this.projects));
		this.syncVisibleHermesFields();
	}

	private syncHermesBoardSelection(): void {
		if (!this.isHermesCreationTarget()) {
			return;
		}

		const board = this.getSelectedHermesBoard();
		if (!board) return;

		this.selectedHermesBoard = board;
		this.applyHermesSubmissionState(board);
	}

	private syncVisibleHermesFields(): void {
		if (this.tagsInput) {
			this.tagsInput.value = this.tags;
		}
		if (this.contextsInput) {
			this.contextsInput.value = this.contexts;
		}
		if (this.hermesBoardSelectEl) {
			const board = this.getSelectedHermesBoard();
			if (board) {
				this.hermesBoardSelectEl.value = board;
			}
		}
		this.renderProjectsList();
	}

	private updatePrimaryActionButtonText(): void {
		const saveButton = this.contentEl.querySelector<HTMLButtonElement>(
			".tn-task-modal__button-bar .mod-cta"
		);
		if (!saveButton) return;
		saveButton.setText(this.getPrimaryActionText() ?? this.t("modals.task.buttons.save"));
	}

	private setPrimaryActionDisabled(disabled: boolean): void {
		const saveButton = this.contentEl.querySelector<HTMLButtonElement>(
			".tn-task-modal__button-bar .mod-cta"
		);
		if (!saveButton) return;
		saveButton.disabled = disabled;
	}

	protected updateIconStates(): void {
		super.updateIconStates();
		this.updateHermesRoutingIconState(
			"hermes-board",
			this.getHermesBoardTooltip(),
			this.isHermesCreationTarget()
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
		if (!icon) return;

		icon.toggleClass("has-value", hasValue);
		icon.setAttribute("aria-label", tooltip);
		icon.setAttribute("data-initial-tooltip", tooltip);
		setTooltip(icon, tooltip, { placement: "top" });
	}

	// Override to prevent creating duplicate title input when NLP is enabled
	protected createTitleInput(container: HTMLElement): void {
		// Only create title input if NLP is disabled
		if (!this.plugin.settings.enableNaturalLanguageInput) {
			super.createTitleInput(container);
		}
	}

	protected async applySubtaskAssignments(createdTask: TaskInfo): Promise<void> {
		const currentTaskFile = this.app.vault.getAbstractFileByPath(createdTask.path);
		if (!(currentTaskFile instanceof TFile)) return;

		await applyTaskCreationSubtaskAssignments({
			currentTaskFile,
			subtaskFiles: this.selectedSubtaskFiles,
			getTaskInfo: (path) => getTaskInfoFromNoteFirst(this.plugin, path),
			buildProjectReference: (targetFile, sourcePath) =>
				this.buildProjectReference(targetFile, sourcePath),
			updateTaskProjects: (subtaskInfo, projects) =>
				this.plugin.updateTaskProperty(subtaskInfo, "projects", projects),
			onError: (error) => {
				tasknotesLogger.error("Failed to assign subtask:", {
					category: "persistence",
					operation: "assign-subtask",
					error: error,
				});
			},
		});
	}

	onClose(): void {
		// Clean up markdown editor if it exists
		if (this.nlMarkdownEditor) {
			this.nlMarkdownEditor.destroy();
			this.nlMarkdownEditor = null;
		}

		// Clean up NLP suggest
		if (this.nlpSuggest) {
			// NLPSuggest extends AbstractInputSuggest which has a close method
			this.nlpSuggest.close();
			this.nlpSuggest = null;
		}

		// Remove all tracked event listeners
		this.removeAllEventListeners();

		super.onClose();
	}
}

export function withHermesBoardProject(
	projects: string,
	knownBoards: readonly string[],
	selectedBoard: string
): string {
	void projects;
	void knownBoards;
	return canonicalHermesBoardProjects(selectedBoard);
}

export function withoutHermesBoardProject(
	projects: string,
	knownBoards: readonly string[]
): string {
	const projectSet = new Set(knownBoards.map(hermesBoardProject));
	return splitCommaList(projects)
		.filter((project) => !projectSet.has(project))
		.join(", ");
}

export function addCommaListValue(value: string, item: string): string {
	const entries = value
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	if (!entries.includes(item)) {
		entries.push(item);
	}
	return entries.join(", ");
}

export function removeCommaListValues(value: string, items: readonly string[]): string {
	const removeSet = new Set(items);
	return splitCommaList(value)
		.filter((entry) => !removeSet.has(entry))
		.join(", ");
}

export function buildHermesGoalModeCreateIdempotencyKey(
	board: string,
	payload: HermesCreateTaskPayload
): string {
	const stablePayload = {
		assignee: payload.assignee ?? null,
		body: payload.body ?? null,
		mode: "goal",
		parents: [...(payload.parents ?? [])].sort(),
		priority: payload.priority ?? null,
		status: payload.status ?? null,
		title: payload.title.trim(),
		triage: payload.triage === true,
	};
	return `tasknotes:goal:${board}:${hashStableString(JSON.stringify(stablePayload))}`;
}

export function getHermesPartialSuccessNoticeMessage(options: {
	mode: "goal" | "kanban";
	title: string;
	id: string;
	error: unknown;
}): string {
	const cardType = options.mode === "goal" ? "Goal Mode card" : "Hermes card";
	return `Created ${cardType} ${options.title} (${options.id}), but TaskNotes could not finish syncing the comment or mirror note: ${getTaskCreationFailureNoticeMessage(options.error)}. Do not submit again; use the existing Hermes card or retry after reconciling the mirror note.`;
}

function hashStableString(value: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < value.length; i += 1) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(36);
}

function splitCommaList(value: string): string[] {
	return value
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

function uniqueNonEmpty(values: readonly string[]): string[] {
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
