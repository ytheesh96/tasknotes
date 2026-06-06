import { App } from "obsidian";
import { createFieldManager } from "../../../src/settings/components/FieldManagerComponent";
import type TaskNotesPlugin from "../../../src/main";
import type { TaskModalFieldsConfig, UserMappedField } from "../../../src/types/settings";

jest.mock("obsidian");

describe("FieldManagerComponent", () => {
	let container: HTMLElement;

	beforeEach(() => {
		document.body.innerHTML = "";
		container = document.createElement("div");
		document.body.appendChild(container);
	});

	it("renders one card and persists cleanup when config has duplicate field ids", () => {
		const config = createModalFieldsConfigWithDuplicateActivity();
		const onUpdate = jest.fn();

		createFieldManager(container, createPlugin(), config, onUpdate, new App());

		expect(getCards("hermesActivityFeed")).toHaveLength(1);
		expect(config.fields.filter((field) => field.id === "hermesActivityFeed")).toHaveLength(1);
		expect(onUpdate).toHaveBeenCalledTimes(1);
		expect(onUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				fields: expect.arrayContaining([
					expect.objectContaining({
						id: "hermesActivityFeed",
						displayName: "Activity Feed",
						order: 1,
					}),
				]),
			})
		);
	});

	it("is idempotent when initialized repeatedly with the same config", () => {
		const config = createModalFieldsConfigWithDuplicateActivity();
		const onUpdate = jest.fn();
		const plugin = createPlugin();

		createFieldManager(container, plugin, config, onUpdate, new App());
		createFieldManager(container, plugin, config, onUpdate, new App());

		expect(getCards("hermesActivityFeed")).toHaveLength(1);
		expect(config.fields.map((field) => field.id)).toEqual([
			"activitySummary",
			"hermesActivityFeed",
			"activityLog",
		]);
		expect(onUpdate).toHaveBeenCalledTimes(1);
	});

	it("reorders cleaned fields without appending duplicate cards", () => {
		const config = createModalFieldsConfigWithDuplicateActivity();
		const onUpdate = jest.fn();

		createFieldManager(container, createPlugin(), config, onUpdate, new App());
		dropCard("activityLog", "hermesActivityFeed", true);

		expect(getCards("hermesActivityFeed")).toHaveLength(1);
		expect(config.fields.filter((field) => field.id === "hermesActivityFeed")).toHaveLength(1);
		expect(config.fields.map((field) => `${field.id}:${field.order}`)).toEqual([
			"activitySummary:0",
			"hermesActivityFeed:2",
			"activityLog:1",
		]);
	});

	function getCards(fieldId: string): HTMLElement[] {
		return Array.from(
			container.querySelectorAll<HTMLElement>(`[data-card-id="${fieldId}"]`)
		);
	}

	function dropCard(draggedId: string, targetId: string, insertBefore: boolean) {
		const target = container.querySelector<HTMLElement>(`[data-card-id="${targetId}"]`);
		expect(target).not.toBeNull();
		jest.spyOn(target!, "getBoundingClientRect").mockReturnValue({
			top: 0,
			bottom: 100,
			left: 0,
			right: 100,
			width: 100,
			height: 100,
			x: 0,
			y: 0,
			toJSON: () => ({}),
		} as DOMRect);

		const event = new Event("drop", { bubbles: true, cancelable: true });
		Object.defineProperty(event, "clientY", { value: insertBefore ? 10 : 90 });
		Object.defineProperty(event, "dataTransfer", {
			value: {
				getData: jest.fn().mockReturnValue(draggedId),
			},
		});

		target!.dispatchEvent(event);
	}
});

function createPlugin(userFields: UserMappedField[] = []): TaskNotesPlugin {
	return {
		settings: { userFields },
	} as TaskNotesPlugin;
}

function createModalFieldsConfigWithDuplicateActivity(): TaskModalFieldsConfig {
	return {
		version: 1,
		groups: [
			{
				id: "activity",
				displayName: "Activity",
				order: 0,
				collapsible: true,
				defaultCollapsed: false,
			},
		],
		fields: [
			{
				id: "activitySummary",
				fieldType: "user",
				group: "activity",
				displayName: "Activity Summary",
				visibleInCreation: false,
				visibleInEdit: true,
				order: 0,
				enabled: true,
			},
			{
				id: "hermesActivityFeed",
				fieldType: "user",
				group: "activity",
				displayName: "Activity Feed",
				visibleInCreation: false,
				visibleInEdit: true,
				order: 1,
				enabled: true,
			},
			{
				id: "hermesActivityFeed",
				fieldType: "user",
				group: "activity",
				displayName: "Duplicate Activity Feed",
				visibleInCreation: false,
				visibleInEdit: true,
				order: 2,
				enabled: true,
			},
			{
				id: "activityLog",
				fieldType: "user",
				group: "activity",
				displayName: "Activity Log",
				visibleInCreation: false,
				visibleInEdit: true,
				order: 3,
				enabled: true,
			},
		],
	};
}
