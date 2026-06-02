import {
	buildHermesAssigneeUpdatePayload,
	collectHermesAssigneesFromMirrorNotes,
	ensureHermesAssigneeUserField,
	hasHermesAssigneeUserField,
	normalizeHermesModalFieldsConfig,
	normalizeHermesUserFields,
} from "../../../src/hermes/hermesAssignee";
import { MockObsidian } from "../../__mocks__/obsidian";

describe("Hermes assignee helpers", () => {
	beforeEach(() => {
		MockObsidian.reset();
	});

	it("does not create a custom Assignee user field when missing", () => {
		const fields = ensureHermesAssigneeUserField([]);

		expect(fields).toEqual([]);
		expect(hasHermesAssigneeUserField(fields)).toBe(false);
	});

	it("removes existing custom assignee user fields", () => {
		const fields = [
			{
				id: "owner",
				displayName: "Owner",
				key: "assignee",
				type: "text" as const,
				defaultValue: "custom-worker",
			},
		];

		expect(ensureHermesAssigneeUserField(fields)).toEqual([]);
	});

	it("keeps non-assignee user fields when cleaning legacy assignee fields", () => {
		const fields = [
			{
				id: "assignee",
				displayName: "Assignee",
				key: "assignee",
				type: "list" as const,
				defaultValue: ["custom-worker"],
			},
			{
				id: "review",
				displayName: "Review",
				key: "review",
				type: "text" as const,
			},
		];

		expect(ensureHermesAssigneeUserField(fields, ["reviewer-qa"])).toEqual([
			expect.objectContaining({
				id: "review",
			}),
		]);
	});

	it("removes legacy Hermes bridge user fields while preserving native fields", () => {
		const result = normalizeHermesUserFields([
			{
				id: "hermes_assignee",
				displayName: "Hermes Assignee",
				key: "hermes_assignee",
				type: "text",
			},
			{
				id: "writeback_comment",
				displayName: "Writeback Comment",
				key: "writeback_comment",
				type: "text",
			},
			{
				id: "review",
				displayName: "Review",
				key: "review",
				type: "text",
			},
		]);

		expect(result.changed).toBe(true);
		expect(result.fields).toEqual([
			{
				id: "review",
				displayName: "Review",
				key: "review",
				type: "text",
			},
		]);
	});

	it("keeps human and self assignees as assignment-only updates", () => {
		expect(buildHermesAssigneeUpdatePayload("human")).toEqual({
			assignee: "human",
		});
		expect(buildHermesAssigneeUpdatePayload("yt")).toEqual({
			assignee: "yt",
		});
	});

	it("removes legacy Hermes fields from modal field settings", () => {
		const result = normalizeHermesModalFieldsConfig({
			version: 1,
			groups: [],
			fields: [
				{
					id: "title",
					fieldType: "core",
					group: "basic",
					displayName: "Title",
					visibleInCreation: true,
					visibleInEdit: true,
					order: 0,
					enabled: true,
				},
				{
					id: "writeback_comment",
					fieldType: "user",
					group: "custom",
					displayName: "Writeback Comment",
					visibleInCreation: false,
					visibleInEdit: true,
					order: 1,
					enabled: true,
				},
			],
		});

		expect(result.changed).toBe(true);
		expect(result.config?.fields.map((field) => field.id)).toEqual(["title"]);
	});

	it("keeps agent assignees as assignment-only updates", () => {
		expect(buildHermesAssigneeUpdatePayload("orchestrator")).toEqual({
			assignee: "orchestrator",
		});
	});

	it("uses the first selected value when a list assignee is submitted", () => {
		expect(buildHermesAssigneeUpdatePayload(["reviewer-qa", "peacock"])).toEqual({
			assignee: "reviewer-qa",
		});
	});

	it("clears none-like assignees", () => {
		expect(buildHermesAssigneeUpdatePayload("none")).toEqual({
			assignee: null,
		});
		expect(buildHermesAssigneeUpdatePayload("")).toEqual({
			assignee: null,
		});
	});

	it("collects assignee defaults from board task notes", () => {
		const app = MockObsidian.createMockApp();
		MockObsidian.createTestFile(
			"TaskNotes/default/t_a.md",
			"---\ncontexts:\n  - peacock\n---\n"
		);
		MockObsidian.createTestFile(
			"TaskNotes/hhmi/t_b.md",
			"---\ncontexts:\n  - hhmi\n  - reviewer-qa\n  - peacock\n  - hermes-kanban\n---\n"
		);
		MockObsidian.createTestFile(
			"TaskNotes/Other.md",
			"---\nassignee: outside\n---\n"
		);
		MockObsidian.createTestFile(
			"TaskNotes/Hermes/default/t_legacy.md",
			"---\nassignee: legacy-worker\n---\n"
		);
		app.metadataCache.setCache("TaskNotes/default/t_a.md", {
			frontmatter: { contexts: ["peacock"] },
		});
		app.metadataCache.setCache("TaskNotes/hhmi/t_b.md", {
			frontmatter: { contexts: ["hhmi", "reviewer-qa", "peacock", "hermes-kanban"] },
		});
		app.metadataCache.setCache("TaskNotes/Other.md", {
			frontmatter: { assignee: "outside" },
		});
		app.metadataCache.setCache("TaskNotes/Hermes/default/t_legacy.md", {
			frontmatter: { assignee: "legacy-worker" },
		});

		expect(collectHermesAssigneesFromMirrorNotes(app)).toEqual(["peacock", "reviewer-qa"]);
	});
});
