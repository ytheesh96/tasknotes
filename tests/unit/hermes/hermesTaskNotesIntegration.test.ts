import type { App } from "obsidian";
import type { TaskInfo } from "../../../src/types";
import {
	buildHermesTaskEditOptions,
	buildHermesTaskCreationOptions,
} from "../../../src/hermes/hermesTaskNotesIntegration";

describe("Hermes TaskNotes integration", () => {
	const app = {} as App;

	it("builds a board-backed creation payload while preserving TaskNotes defaults", () => {
		const options = buildHermesTaskCreationOptions(app, [], {
			title: "Draft packet cleanup",
			status: "ready",
			contexts: ["hhmi"],
			tags: ["review"],
			customFrontmatter: {
				assignee: "yt",
				lane: "drafting",
			},
		});

		expect(options.modalTitle).toBe("Create task");
		expect(options.saveButtonText).toBe("Create task");
		expect(options.hermesBoardPicker).toMatchObject({
			selectedBoard: "hhmi",
		});
		expect(options.hermesBoardPicker?.boards).toContain("hhmi");
		expect(options.creationTargetPicker?.selectedTarget).toBe("hermes:hhmi");
		expect(options.prePopulatedValues?.status).toBe("ready");
		expect(options.prePopulatedValues?.contexts).toContain("hhmi");
		expect(options.prePopulatedValues?.tags).toEqual(
			expect.arrayContaining(["review", "hermes-kanban"])
		);
		expect(options.prePopulatedValues?.customFrontmatter).toMatchObject({
			assignee: "yt",
			lane: "drafting",
		});
		expect(options.prePopulatedValues?.customFrontmatter).not.toHaveProperty("hermes_submit");
		expect(options.prePopulatedValues?.customFrontmatter).not.toHaveProperty("hermes_board");
		expect(options.prePopulatedValues?.customFrontmatter).not.toHaveProperty("hermes_assignee");
		expect(options.modalFieldsConfig?.fields.map((field) => field.id)).toContain("assignee");
	});

	it("defaults new board tasks to triage when no status is supplied", () => {
		const options = buildHermesTaskCreationOptions(app, [], {
			title: "Unspecified status",
			contexts: ["hhmi"],
		});

		expect(options.prePopulatedValues?.status).toBe("triage");
	});

	it("keeps raw writeback fields out of the board edit modal", () => {
		const task = {
			title: "Synced task",
			status: "ready",
			priority: "normal",
			path: "TaskNotes/hhmi/t_123.md",
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

		expect(options.modalTitle).toBe("Update task");
		expect(options.saveButtonText).toBe("Save update");
		expect(fieldIds).toEqual(
			expect.arrayContaining([
				"title",
				"details",
				"contexts",
				"assignee",
				"blocked-by",
				"blocking",
			])
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
