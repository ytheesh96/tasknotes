import { setIcon, TAbstractFile } from "obsidian";
import TaskNotesPlugin from "../../../main";
import {
	createCard,
	createCardInput,
	createCardSelect,
	createCardToggle,
	CardRow,
} from "../../components/CardComponent";
import { createFilterSettingsInputs } from "../../components/FilterSettingsComponent";
import { createNLPTriggerRows, createPropertyDescription, TranslateFn } from "./helpers";
import {
	canonicalHermesBoardProjects,
	defaultHermesBoards,
	normalizeHermesBoardValue,
	splitHermesList,
} from "../../../hermes/hermesRouting";

/**
 * Renders the Projects property card with default projects, use parent note toggle, and autosuggest settings
 */
export function renderProjectsPropertyCard(
	container: HTMLElement,
	plugin: TaskNotesPlugin,
	save: () => void,
	translate: TranslateFn
): void {
	// Create a wrapper for the card so we can re-render it
	const cardWrapper = container.createDiv();
	let isCollapsed = true;

	function renderCard(): void {
		cardWrapper.empty();

		const propertyKeyInput = createCardInput(
			"text",
			"projects",
			plugin.settings.fieldMapping.projects
		);

		propertyKeyInput.addEventListener("change", () => {
			plugin.settings.fieldMapping.projects = propertyKeyInput.value;
			save();
		});

		// Create nested content for default projects
		const nestedContainer = activeDocument.createElement("div");
		nestedContainer.addClass("tasknotes-settings__nested-content");

		// Default board container
		const defaultProjectsContainer = nestedContainer.createDiv("default-projects-container");
		const boardOptions = [
			{ value: "", label: "None" },
			...defaultHermesBoards().map((board) => ({ value: board, label: board })),
		];
		const defaultBoardSelect = createCardSelect(
			boardOptions,
			boardFromDefaultProjects(plugin.settings.taskCreationDefaults.defaultProjects) ?? ""
		);
		defaultBoardSelect.addEventListener("change", () => {
			const board = (defaultBoardSelect as HTMLSelectElement).value;
			plugin.settings.taskCreationDefaults.defaultProjects = board
				? canonicalHermesBoardProjects(board)
				: "";
			plugin.settings.taskCreationDefaults.useParentNoteAsProject = false;
			plugin.settings.taskCreationDefaults.useParentHeaderAsProject = false;
			save();
		});
		defaultProjectsContainer.appendChild(defaultBoardSelect);

		// Use parent note as project toggle
		const inheritParentTaskPropertiesToggle = createCardToggle(
			plugin.settings.taskCreationDefaults.inheritParentTaskProperties,
			(value) => {
				plugin.settings.taskCreationDefaults.inheritParentTaskProperties = value;
				save();
			}
		);

		// Create description element
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
}

/**
 * Renders the project autosuggest settings inside the projects card
 */
function renderProjectAutosuggestSettings(
	container: HTMLElement,
	plugin: TaskNotesPlugin,
	save: () => void,
	translate: TranslateFn,
	_onRerender?: () => void
): void {
	container.empty();

	// Ensure projectAutosuggest exists
	if (!plugin.settings.projectAutosuggest) {
		plugin.settings.projectAutosuggest = {
			enableFuzzy: false,
			rows: [],
			showAdvanced: false,
			requiredTags: [],
			includeFolders: [],
			propertyKey: "",
			propertyValue: "",
		};
	}

	// Helper to check if any filters are active
	const hasActiveFilters = () => {
		const config = plugin.settings.projectAutosuggest;
		if (!config) return false;
		return (
			(config.requiredTags && config.requiredTags.length > 0) ||
			(config.includeFolders && config.includeFolders.length > 0) ||
			(config.propertyKey && config.propertyKey.trim() !== "")
		);
	};

	// ===== AUTOSUGGEST FILTERS SECTION =====
	const projectAutosuggest = plugin.settings.projectAutosuggest;
	if (!projectAutosuggest) {
		return;
	}

	const filterSectionWrapper = container.createDiv("tasknotes-settings__collapsible-section");
	filterSectionWrapper.addClass("tasknotes-settings__collapsible-section--collapsed");

	const filterHeader = filterSectionWrapper.createDiv(
		"tasknotes-settings__collapsible-section-header"
	);
	const filterHeaderLeft = filterHeader.createDiv(
		"tasknotes-settings__collapsible-section-header-left"
	);

	filterHeaderLeft.createSpan({
		text: translate("settings.taskProperties.projectsCard.autosuggestFilters"),
		cls: "tasknotes-settings__collapsible-section-title",
	});

	// Add "Filters On" badge if filters are active
	const filterBadge = filterHeaderLeft.createSpan("tasknotes-settings__filter-badge");
	const updateFilterBadge = () => {
		if (hasActiveFilters()) {
			filterBadge.classList.remove(
				"tn-static-display-block-2a1b75c9",
				"tn-static-display-flex-4d51fc62",
				"tn-static-display-flex-75816cae",
				"tn-static-display-flex-8bb39979",
				"tn-static-display-inline-block-60e32dcb",
				"tn-static-display-inline-cccfa456",
				"tn-static-display-none-6b99de8b",
				"tn-static-min-height-800px-997b4c8c"
			);
			filterBadge.classList.add("tn-static-display-inline-flex-f984c520");
			filterBadge.empty();
			const iconEl = filterBadge.createSpan();
			setIcon(iconEl, "filter");
			filterBadge.createSpan({
				text: translate("settings.taskProperties.projectsCard.filtersOn"),
			});
		} else {
			filterBadge.classList.remove(
				"tn-static-display-block-2a1b75c9",
				"tn-static-display-flex-4d51fc62",
				"tn-static-display-flex-75816cae",
				"tn-static-display-flex-8bb39979",
				"tn-static-display-inline-block-60e32dcb",
				"tn-static-display-inline-cccfa456",
				"tn-static-display-inline-flex-f984c520",
				"tn-static-min-height-800px-997b4c8c"
			);
			filterBadge.classList.add("tn-static-display-none-6b99de8b");
			filterBadge.empty();
		}
	};
	updateFilterBadge();

	const filterChevron = filterHeader.createSpan(
		"tasknotes-settings__collapsible-section-chevron"
	);
	setIcon(filterChevron, "chevron-down");

	const filterContent = filterSectionWrapper.createDiv(
		"tasknotes-settings__collapsible-section-content"
	);

	createFilterSettingsInputs(
		filterContent,
		{
			requiredTags: projectAutosuggest.requiredTags,
			includeFolders: projectAutosuggest.includeFolders,
			propertyKey: projectAutosuggest.propertyKey,
			propertyValue: projectAutosuggest.propertyValue,
		},
		(updated) => {
			projectAutosuggest.requiredTags = updated.requiredTags;
			projectAutosuggest.includeFolders = updated.includeFolders;
			projectAutosuggest.propertyKey = updated.propertyKey;
			projectAutosuggest.propertyValue = updated.propertyValue;
			updateFilterBadge();
			save();
		},
		translate
	);

	filterHeader.addEventListener("click", () => {
		filterSectionWrapper.toggleClass(
			"tasknotes-settings__collapsible-section--collapsed",
			!filterSectionWrapper.hasClass("tasknotes-settings__collapsible-section--collapsed")
		);
	});

	// ===== CUSTOMIZE DISPLAY SECTION =====
	const displaySectionWrapper = container.createDiv("tasknotes-settings__collapsible-section");
	displaySectionWrapper.addClass("tasknotes-settings__collapsible-section--collapsed");

	const displayHeader = displaySectionWrapper.createDiv(
		"tasknotes-settings__collapsible-section-header"
	);
	const displayHeaderLeft = displayHeader.createDiv(
		"tasknotes-settings__collapsible-section-header-left"
	);

	displayHeaderLeft.createSpan({
		text: translate("settings.taskProperties.projectsCard.customizeDisplay"),
		cls: "tasknotes-settings__collapsible-section-title",
	});

	const displayChevron = displayHeader.createSpan(
		"tasknotes-settings__collapsible-section-chevron"
	);
	setIcon(displayChevron, "chevron-down");

	const displayContent = displaySectionWrapper.createDiv(
		"tasknotes-settings__collapsible-section-content"
	);

	// Fuzzy matching toggle
	const fuzzyRow = displayContent.createDiv("tasknotes-settings__card-config-row");
	fuzzyRow.createSpan({
		text: translate("settings.appearance.projectAutosuggest.enableFuzzyMatching.name"),
		cls: "tasknotes-settings__card-config-label",
	});
	const fuzzyToggle = createCardToggle(projectAutosuggest.enableFuzzy, (value) => {
		projectAutosuggest.enableFuzzy = value;
		save();
	});
	fuzzyRow.appendChild(fuzzyToggle);

	// Display rows help text
	displayContent.createDiv({
		text: translate("settings.appearance.projectAutosuggest.displayRowsHelp"),
		cls: "setting-item-description",
	});

	// Display row inputs
	const getRows = (): string[] => (plugin.settings.projectAutosuggest?.rows ?? []).slice(0, 3);

	const setRow = (idx: number, value: string) => {
		if (!plugin.settings.projectAutosuggest) return;
		const current = plugin.settings.projectAutosuggest.rows ?? [];
		const next = [...current];
		next[idx] = value;
		plugin.settings.projectAutosuggest.rows = next.slice(0, 3);
		save();
	};

	// Row 1
	const row1Container = displayContent.createDiv("tasknotes-settings__card-config-row");
	row1Container.createSpan({
		text: translate("settings.appearance.projectAutosuggest.displayRows.row1.name"),
		cls: "tasknotes-settings__card-config-label",
	});
	const row1Input = createCardInput(
		"text",
		translate("settings.appearance.projectAutosuggest.displayRows.row1.placeholder"),
		getRows()[0] || ""
	);
	row1Input.addEventListener("change", () => setRow(0, row1Input.value));
	row1Container.appendChild(row1Input);

	// Row 2
	const row2Container = displayContent.createDiv("tasknotes-settings__card-config-row");
	row2Container.createSpan({
		text: translate("settings.appearance.projectAutosuggest.displayRows.row2.name"),
		cls: "tasknotes-settings__card-config-label",
	});
	const row2Input = createCardInput(
		"text",
		translate("settings.appearance.projectAutosuggest.displayRows.row2.placeholder"),
		getRows()[1] || ""
	);
	row2Input.addEventListener("change", () => setRow(1, row2Input.value));
	row2Container.appendChild(row2Input);

	// Row 3
	const row3Container = displayContent.createDiv("tasknotes-settings__card-config-row");
	row3Container.createSpan({
		text: translate("settings.appearance.projectAutosuggest.displayRows.row3.name"),
		cls: "tasknotes-settings__card-config-label",
	});
	const row3Input = createCardInput(
		"text",
		translate("settings.appearance.projectAutosuggest.displayRows.row3.placeholder"),
		getRows()[2] || ""
	);
	row3Input.addEventListener("change", () => setRow(2, row3Input.value));
	row3Container.appendChild(row3Input);

	// Quick reference help section
	const helpContainer = displayContent.createDiv("tasknotes-settings__help-section");
	helpContainer.createEl("h4", {
		text: translate("settings.appearance.projectAutosuggest.quickReference.header"),
	});
	const helpList = helpContainer.createEl("ul");
	helpList.createEl("li", {
		text: translate("settings.appearance.projectAutosuggest.quickReference.properties"),
	});
	helpList.createEl("li", {
		text: translate("settings.appearance.projectAutosuggest.quickReference.labels"),
	});
	helpList.createEl("li", {
		text: translate("settings.appearance.projectAutosuggest.quickReference.searchable"),
	});
	helpList.createEl("li", {
		text: translate("settings.appearance.projectAutosuggest.quickReference.staticText"),
	});
	helpContainer.createEl("p", {
		text: translate("settings.appearance.projectAutosuggest.quickReference.alwaysSearchable"),
		cls: "settings-help-note",
	});

	displayHeader.addEventListener("click", () => {
		displaySectionWrapper.toggleClass(
			"tasknotes-settings__collapsible-section--collapsed",
			!displaySectionWrapper.hasClass("tasknotes-settings__collapsible-section--collapsed")
		);
	});
}

/**
 * Renders default projects list
 */
function renderDefaultProjectsList(
	container: HTMLElement,
	plugin: TaskNotesPlugin,
	save: () => void,
	selectedFiles: TAbstractFile[],
	translate: TranslateFn
): void {
	container.empty();

	if (selectedFiles.length === 0) {
		container.createDiv({
			text: translate("settings.taskProperties.projectsCard.noDefaultProjects"),
			cls: "setting-item-description",
		});
		return;
	}

	selectedFiles.forEach((file) => {
		const projectItem = container.createDiv("tasknotes-settings__project-item");
		projectItem.createSpan({ text: file.name.replace(/\.md$/, "") });

		const removeButton = projectItem.createEl("button", {
			cls: "tasknotes-settings__card-header-btn tasknotes-settings__card-header-btn--delete",
		});
		setIcon(removeButton, "x");
		removeButton.title = translate(
			"settings.defaults.basicDefaults.defaultProjects.removeTooltip",
			{ name: file.name }
		);
		removeButton.onclick = () => {
			const index = selectedFiles.indexOf(file);
			if (index > -1) {
				selectedFiles.splice(index, 1);
				const projectLinks = selectedFiles
					.map((f) => `[[${f.path.replace(/\.md$/, "")}]]`)
					.join(", ");
				plugin.settings.taskCreationDefaults.defaultProjects = projectLinks;
				save();
				renderDefaultProjectsList(container, plugin, save, selectedFiles, translate);
			}
		};
	});
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
