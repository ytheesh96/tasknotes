import { Notice, setIcon } from "obsidian";
import TaskNotesPlugin from "../../../main";
import {
	createCard,
	createCardInput,
	createCardSelect,
	createCardToggle,
	CardRow,
} from "../../components/CardComponent";
import { showConfirmationModal } from "../../../modals/ConfirmationModal";
import { showTextInputModal } from "../../../modals/TextInputModal";
import { HermesKanbanApiClient } from "../../../hermes/hermesApiClient";
import {
	canonicalHermesBoardProjects,
	defaultHermesBoards,
	normalizeHermesBoardValue,
	splitHermesList,
} from "../../../hermes/hermesRouting";
import { createPropertyDescription, TranslateFn } from "./helpers";

const HERMES_BOARD_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * Renders the Projects property card as the Hermes board control.
 */
export function renderProjectsPropertyCard(
	container: HTMLElement,
	plugin: TaskNotesPlugin,
	save: () => void,
	translate: TranslateFn
): void {
	const cardWrapper = container.createDiv();
	let isCollapsed = true;
	let boardOptions = defaultHermesBoards();
	let isSyncingBoards = false;
	let boardSyncError: string | null = null;
	let attemptedInitialSync = false;

	const saveAndRefresh = () => {
		save();
		plugin.app.workspace.trigger("tasknotes:refresh-views");
	};

	async function syncBoards(showNotice = false): Promise<void> {
		isSyncingBoards = true;
		boardSyncError = null;
		renderCard();

		try {
			const syncedBoards = await loadHermesBoards();
			boardOptions = syncedBoards.length > 0 ? syncedBoards : defaultHermesBoards();
			reconcileDefaultBoardWithSyncedBoards(plugin, boardOptions, saveAndRefresh);
			if (showNotice) {
				new Notice(`Synced ${boardOptions.length} Hermes boards`);
			}
		} catch (error) {
			boardSyncError = `Could not sync Hermes boards: ${getErrorMessage(error)}`;
			boardOptions = uniqueBoardOptions([
				...defaultHermesBoards(),
				boardFromDefaultProjects(plugin.settings.taskCreationDefaults.defaultProjects),
			]);
			if (showNotice) {
				new Notice(boardSyncError);
			}
		} finally {
			isSyncingBoards = false;
			renderCard();
		}
	}

	async function createBoard(): Promise<void> {
		const input = await showTextInputModal(plugin.app, {
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
			await new HermesKanbanApiClient().createBoard({
				slug,
				name: input.trim() === slug ? undefined : input.trim(),
			});
			plugin.settings.taskCreationDefaults.defaultProjects =
				canonicalHermesBoardProjects(slug);
			saveAndRefresh();
			await syncBoards(false);
			new Notice(`Created Hermes board "${slug}"`);
		} catch (error) {
			new Notice(`Could not create Hermes board: ${getErrorMessage(error)}`);
		}
	}

	async function deleteSelectedBoard(): Promise<void> {
		const board = boardFromDefaultProjects(plugin.settings.taskCreationDefaults.defaultProjects);
		if (!board) {
			new Notice("Choose a board before deleting it.");
			return;
		}
		if (board === "default") {
			new Notice("The default Hermes board cannot be deleted.");
			return;
		}

		const confirmed = await showConfirmationModal(plugin.app, {
			title: "Delete Hermes board",
			message: `Delete "${board}" from active Hermes boards? Hermes archives the board so its task history can be recovered.`,
			confirmText: "Delete board",
			isDestructive: true,
		});
		if (!confirmed) {
			return;
		}

		try {
			await new HermesKanbanApiClient().deleteBoard(board);
			plugin.settings.taskCreationDefaults.defaultProjects = "";
			saveAndRefresh();
			await syncBoards(false);
			new Notice(`Deleted Hermes board "${board}"`);
		} catch (error) {
			new Notice(`Could not delete Hermes board: ${getErrorMessage(error)}`);
		}
	}

	function renderCard(): void {
		cardWrapper.empty();

		const propertyKeyInput = createCardInput(
			"text",
			"projects",
			plugin.settings.fieldMapping.projects
		);

		propertyKeyInput.addEventListener("change", () => {
			plugin.settings.fieldMapping.projects = propertyKeyInput.value;
			saveAndRefresh();
		});

		const nestedContainer = activeDocument.createElement("div");
		nestedContainer.addClass("tasknotes-settings__nested-content");

		const selectedBoard =
			boardFromDefaultProjects(plugin.settings.taskCreationDefaults.defaultProjects) ?? "";
		const defaultProjectsContainer = nestedContainer.createDiv("default-projects-container");
		const defaultBoardSelect = createCardSelect(
			buildBoardSelectOptions(boardOptions, selectedBoard, isSyncingBoards),
			selectedBoard
		);
		defaultBoardSelect.disabled = isSyncingBoards;
		defaultBoardSelect.addEventListener("change", () => {
			const board = (defaultBoardSelect as HTMLSelectElement).value;
			plugin.settings.taskCreationDefaults.defaultProjects = board
				? canonicalHermesBoardProjects(board)
				: "";
			plugin.settings.taskCreationDefaults.useParentNoteAsProject = false;
			plugin.settings.taskCreationDefaults.useParentHeaderAsProject = false;
			saveAndRefresh();
		});
		defaultProjectsContainer.appendChild(defaultBoardSelect);

		const boardActions = defaultProjectsContainer.createDiv(
			"tasknotes-settings__board-actions"
		);
		boardActions.appendChild(
			createBoardActionButton("refresh-cw", "Sync", "Sync boards from Hermes", () => {
				void syncBoards(true);
			})
		);
		boardActions.appendChild(
			createBoardActionButton("plus", "Create", "Create a Hermes board", () => {
				void createBoard();
			})
		);
		const deleteButton = createBoardActionButton(
			"trash",
			"Delete",
			"Delete the selected Hermes board",
			() => {
				void deleteSelectedBoard();
			}
		);
		deleteButton.disabled = !selectedBoard || selectedBoard === "default" || isSyncingBoards;
		boardActions.appendChild(deleteButton);

		if (boardSyncError) {
			defaultProjectsContainer.createDiv({
				text: boardSyncError,
				cls: "setting-item-description",
			});
		}

		const inheritParentTaskPropertiesToggle = createCardToggle(
			plugin.settings.taskCreationDefaults.inheritParentTaskProperties,
			(value) => {
				plugin.settings.taskCreationDefaults.inheritParentTaskProperties = value;
				saveAndRefresh();
			}
		);

		const descriptionEl = createPropertyDescription(
			translate("settings.taskProperties.properties.projects.description")
		);

		const rows: CardRow[] = [
			{ label: "", input: descriptionEl, fullWidth: true },
			{
				label: translate("settings.taskProperties.propertyCard.propertyKey"),
				input: propertyKeyInput,
			},
			{
				label: translate("settings.taskProperties.projectsCard.defaultProjects"),
				input: nestedContainer,
				fullWidth: true,
			},
			{
				label: translate("settings.taskProperties.projectsCard.inheritParentTaskProperties"),
				input: inheritParentTaskPropertiesToggle,
			},
		];

		createCard(cardWrapper, {
			id: "property-projects",
			collapsible: true,
			defaultCollapsed: isCollapsed,
			onCollapseChange: (collapsed) => {
				isCollapsed = collapsed;
			},
			header: {
				primaryText: translate("settings.taskProperties.properties.projects.name"),
				secondaryText: plugin.settings.fieldMapping.projects,
			},
			content: {
				sections: [{ rows }],
			},
		});
	}

	renderCard();
	if (!attemptedInitialSync) {
		attemptedInitialSync = true;
		void syncBoards(false);
	}
}

async function loadHermesBoards(): Promise<string[]> {
	const boards = await new HermesKanbanApiClient().listBoards();
	return uniqueBoardOptions(boards.filter((board) => !board.archived).map((board) => board.slug));
}

function buildBoardSelectOptions(
	boards: readonly string[],
	selectedBoard: string,
	isSyncing: boolean
): Array<{ value: string; label: string }> {
	const options = uniqueBoardOptions([selectedBoard, ...boards]);
	return [
		{ value: "", label: isSyncing ? "Syncing..." : "None" },
		...options.map((board) => ({ value: board, label: board })),
	];
}

function reconcileDefaultBoardWithSyncedBoards(
	plugin: TaskNotesPlugin,
	boards: readonly string[],
	save: () => void
): void {
	const selectedBoard = boardFromDefaultProjects(plugin.settings.taskCreationDefaults.defaultProjects);
	if (!selectedBoard || boards.includes(selectedBoard)) {
		return;
	}
	plugin.settings.taskCreationDefaults.defaultProjects = "";
	save();
}

function createBoardActionButton(
	iconName: string,
	text: string,
	title: string,
	onClick: () => void
): HTMLButtonElement {
	const button = activeDocument.createElement("button");
	button.type = "button";
	button.title = title;
	button.addClass("tasknotes-settings__card-action-btn");

	const iconEl = button.createSpan();
	setIcon(iconEl, iconName);
	button.createSpan({ text });
	button.addEventListener("click", onClick);
	return button;
}

function boardFromDefaultProjects(defaultProjects: unknown): string | null {
	for (const value of splitHermesList(defaultProjects)) {
		const board = normalizeHermesBoardValue(value);
		if (board) {
			return board;
		}
	}
	return null;
}

function normalizeBoardSlugInput(input: string): string | null {
	const slug = input.trim().toLowerCase().replace(/\s+/g, "-");
	if (!HERMES_BOARD_SLUG_PATTERN.test(slug)) {
		return null;
	}
	return slug;
}

function uniqueBoardOptions(values: readonly (string | null | undefined)[]): string[] {
	return [...new Set(values.map((value) => value?.trim()).filter(isPresent))].sort((left, right) =>
		left.localeCompare(right)
	);
}

function isPresent(value: string | null | undefined): value is string {
	return typeof value === "string" && value.length > 0;
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}
