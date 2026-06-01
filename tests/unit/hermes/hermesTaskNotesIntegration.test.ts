import type { App } from "obsidian";
import type { TaskInfo } from "../../../src/types";
import {
	buildDefaultTaskCreationOptionsWithHermesTargets,
	buildHermesTaskEditOptions,
	buildHermesTaskCreationOptions,
	isHermesCreationContext,
	isHermesTask,
} from "../../../src/hermes/hermesTaskNotesIntegration";

describe("Hermes TaskNotes integration", () => {
	const app = {} as App;

	it("recognizes Hermes creation data without requiring a live workspace", () => {
		const values = {
			tags: ["hermes-kanban"],
			customFrontmatter: {
				hermes_board: "hhmi",
			},
		};

		expect(isHermesCreationContext(app, values)).toBe(true);
	});

	it("builds a native TaskNotes submission payload for Hermes triage", () => {
		const options = buildHermesTaskCreationOptions(app, [], {
			title: "Draft packet cleanup",
			contexts: ["hhmi"],
			tags: ["hermes-kanban"],
			customFrontmatter: {
				hermes_board: "hhmi",
				hermes_priority: "7",
			},
		});

		expect(options.modalTitle).toBe("Create Hermes task");
		expect(options.saveButtonText).toBe("Send to triage");
		expect(options.hermesBoardPicker).toMatchObject({
			selectedBoard: "hhmi",
		});
		expect(options.hermesBoardPicker?.boards).toContain("hhmi");
		expect(options.prePopulatedValues?.status).toBe("triage");
		expect(options.prePopulatedValues?.contexts).toContain("hhmi");
		expect(options.prePopulatedValues?.tags).toEqual(
			expect.arrayContaining(["hermes-kanban", "hermes-submit"])
		);
		expect(options.prePopulatedValues?.customFrontmatter).toMatchObject({
			hermes_submit: true,
			hermes_board: "hhmi",
			hermes_priority: "7",
			hermes_assignee: "none",
			hermes_created_by: "tasknotes-native",
		});
	});

	it("adds Hermes targets to ordinary TaskNotes creation without making it a Hermes task", () => {
		const options = buildDefaultTaskCreationOptionsWithHermesTargets(app, {
			title: "Ordinary task",
		});

		expect(options.prePopulatedValues?.title).toBe("Ordinary task");
		expect(options.creationTargetPicker).toMatchObject({
			selectedTarget: "default",
		});
		expect(options.creationTargetPicker?.boards).toContain("obsidian-os");
		expect(options.hermesBoardPicker?.selectedBoard).toBe("obsidian-os");
		expect(options.prePopulatedValues?.customFrontmatter).toBeUndefined();
	});

	it("does not treat ordinary task creation as Hermes submission", () => {
		expect(isHermesCreationContext(app)).toBe(false);
	});

	it("recognizes synced Hermes task cards", () => {
		const task = {
			title: "Synced task",
			status: "blocked",
			priority: "normal",
			path: "TaskNotes/Hermes/hhmi/t_123.md",
			archived: false,
		} as TaskInfo;

		expect(isHermesTask(task)).toBe(true);
	});

	it("keeps raw writeback fields out of the Hermes edit modal", () => {
		const task = {
			title: "Synced task",
			status: "ready",
			priority: "normal",
			path: "TaskNotes/Hermes/hhmi/t_123.md",
			archived: false,
		} as TaskInfo;
		const options = buildHermesTaskEditOptions(task, [
			{
				id: "writeback_comment",
				displayName: "Writeback Comment",
				key: "writeback_comment",
				type: "text",
			},
			{
				id: "writeback_reason",
				displayName: "Writeback Reason",
				key: "writeback_reason",
				type: "text",
			},
			{
				id: "requires_human_decision",
				displayName: "Requires Human Decision",
				key: "requires_human_decision",
				type: "boolean",
			},
		]);
		const fieldIds = options.modalFieldsConfig?.fields?.map((field) => field.id) ?? [];

		expect(fieldIds).toEqual(
			expect.arrayContaining(["title", "details", "contexts", "blocked-by", "blocking"])
		);
		expect(fieldIds).not.toEqual(
			expect.arrayContaining([
				"writeback_comment",
				"writeback_reason",
				"writeback_result",
				"writeback_summary",
				"handoff_to",
				"requires_human_decision",
			])
		);
	});
});
