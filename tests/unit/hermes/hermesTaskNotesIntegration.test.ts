import type { App } from "obsidian";
import { buildHermesTaskCreationOptions } from "../../../src/hermes/hermesTaskNotesIntegration";
import { HERMES_TASKNOTES_LOCAL_CREATION_TARGET } from "../../../src/hermes/hermesTaskNotesApiSync";

describe("Hermes TaskNotes integration", () => {
	const app = {} as App;

	it("builds a board-backed creation payload while preserving TaskNotes defaults", () => {
		const options = buildHermesTaskCreationOptions(app, [], {
			title: "Draft packet cleanup",
			status: "ready",
			projects: ["Hermes/hhmi"],
			contexts: ["yt"],
			tags: ["review"],
			customFrontmatter: {
				lane: "drafting",
			},
		});

		expect(options.modalTitle).toBe("Create task");
		expect(options.saveButtonText).toBe("Create task");
		expect(options.hermesBoardPicker).toMatchObject({
			selectedBoard: "hhmi",
		});
		expect(options.hermesBoardPicker?.boards).toContain("hhmi");
		expect(options.creationTargetPicker?.selectedTarget).toBe(
			HERMES_TASKNOTES_LOCAL_CREATION_TARGET
		);
		expect(options.prePopulatedValues?.status).toBe("ready");
		expect(options.prePopulatedValues?.projects).toEqual(["Hermes/hhmi"]);
		expect(options.prePopulatedValues?.contexts).toEqual(["yt"]);
		expect(options.prePopulatedValues?.tags).toEqual(
			expect.arrayContaining(["review", "hermes-kanban"])
		);
		expect(options.prePopulatedValues?.customFrontmatter).toMatchObject({
			lane: "drafting",
		});
		expect(options.prePopulatedValues?.customFrontmatter).not.toHaveProperty("assignee");
		expect(options.prePopulatedValues?.customFrontmatter).not.toHaveProperty("hermes_submit");
		expect(options.prePopulatedValues?.customFrontmatter).not.toHaveProperty("hermes_board");
		expect(options.prePopulatedValues?.customFrontmatter).not.toHaveProperty("hermes_assignee");
		expect(options.modalFieldsConfig).toBeUndefined();
	});

	it("defaults new board tasks to triage when no status is supplied", () => {
		const options = buildHermesTaskCreationOptions(app, [], {
			title: "Unspecified status",
			projects: ["Hermes/hhmi"],
		});

		expect(options.prePopulatedValues?.status).toBe("triage");
	});

	it("honors the configured default board when no board is prepopulated", () => {
		const options = buildHermesTaskCreationOptions(
			app,
			[],
			{ title: "Default board task" },
			undefined,
			"Hermes/default"
		);

		expect(options.hermesBoardPicker?.selectedBoard).toBe("default");
		expect(options.creationTargetPicker?.selectedTarget).toBe(
			HERMES_TASKNOTES_LOCAL_CREATION_TARGET
		);
		expect(options.prePopulatedValues?.projects).toEqual(["Hermes/default"]);
	});

	it("lets an explicit board beat the configured default board", () => {
		const options = buildHermesTaskCreationOptions(
			app,
			[],
			{
				title: "Explicit board task",
				projects: ["Hermes/hhmi"],
			},
			undefined,
			"Hermes/default"
		);

		expect(options.hermesBoardPicker?.selectedBoard).toBe("hhmi");
		expect(options.prePopulatedValues?.projects).toEqual(["Hermes/hhmi"]);
	});

	it("keeps Goal Mode as a normal goal tag on creation options", () => {
		const options = buildHermesTaskCreationOptions(app, [], {
			title: "Clarify research goal",
			projects: ["Hermes/default"],
			tags: ["planning", "goal"],
		});

		expect(options.modalTitle).toBe("Create task");
		expect(options.saveButtonText).toBe("Create task");
		expect(options.creationTargetPicker?.selectedTarget).toBe(
			HERMES_TASKNOTES_LOCAL_CREATION_TARGET
		);
		expect(options.prePopulatedValues?.tags).toEqual(
			expect.arrayContaining(["hermes-kanban", "goal", "planning"])
		);
		expect(options.prePopulatedValues?.customFrontmatter).not.toMatchObject({
			hermesCardMode: "goal",
			hermesMode: "goal",
		});
	});
});
