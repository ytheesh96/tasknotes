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

	it("adds a native Assignee user field when missing", () => {
		const fields = ensureHermesAssigneeUserField([]);

		expect(fields).toEqual([
			expect.objectContaining({
				id: "assignee",
				displayName: "Assignee",
				key: "assignee",
				type: "list",
				defaultValue: expect.arrayContaining(["orchestrator", "human", "user"]),
			}),
		]);
		expect(hasHermesAssigneeUserField(fields)).toBe(true);
	});

	it("normalizes existing assignee user fields into the native Assignee list field", () => {
		const fields = [
			{
				id: "owner",
				displayName: "Owner",
				key: "assignee",
				type: "text" as const,
				defaultValue: "custom-worker",
			},
		];

		expect(ensureHermesAssigneeUserField(fields)).toEqual([
			expect.objectContaining({
				id: "assignee",
				displayName: "Assignee",
				key: "assignee",
				type: "list",
				defaultValue: ["custom-worker"],
			}),
		]);
	});

	it("merges live mirror assignees into an existing CSV without forcing every built-in name", () => {
		const fields = [
			{
				id: "assignee",
				displayName: "Assignee",
				key: "assignee",
				type: "list" as const,
				defaultValue: ["custom-worker"],
			},
		];

		expect(ensureHermesAssigneeUserField(fields, ["reviewer-qa"])).toEqual([
			expect.objectContaining({
				defaultValue: ["custom-worker", "reviewer-qa"],
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
			{
				id: "assignee",
				displayName: "Assignee",
				key: "assignee",
				type: "list",
				defaultValue: expect.arrayContaining(["orchestrator", "human", "user"]),
			},
		]);
	});

	it("turns human assignees into blocked Hermes updates", () => {
		expect(buildHermesAssigneeUpdatePayload("human")).toEqual({
			assignee: "human",
			status: "blocked",
			block_reason: "Waiting on human: human",
		});
		expect(buildHermesAssigneeUpdatePayload("yt")).toEqual({
			assignee: "yt",
			status: "blocked",
			block_reason: "Waiting on human: yt",
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
		expect(result.config?.fields.map((field) => field.id)).toEqual(["title", "assignee"]);
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
			"---\nassignee: peacock\n---\n"
		);
		MockObsidian.createTestFile(
			"TaskNotes/hhmi/t_b.md",
			"---\nassignee:\n  - reviewer-qa\n  - peacock\n---\n"
		);
		MockObsidian.createTestFile(
			"TaskNotes/Other.md",
			"---\nassignee: outside\n---\n"
		);
		app.metadataCache.setCache("TaskNotes/default/t_a.md", {
			frontmatter: { assignee: "peacock" },
		});
		app.metadataCache.setCache("TaskNotes/hhmi/t_b.md", {
			frontmatter: { assignee: ["reviewer-qa", "peacock"] },
		});
		app.metadataCache.setCache("TaskNotes/Other.md", {
			frontmatter: { assignee: "outside" },
		});

		expect(collectHermesAssigneesFromMirrorNotes(app)).toEqual(["peacock", "reviewer-qa"]);
	});
});
