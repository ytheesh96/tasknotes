import {
	buildHermesAssigneeUpdatePayload,
	ensureHermesAssigneeUserField,
	hasHermesAssigneeUserField,
	normalizeHermesModalFieldsConfig,
	normalizeHermesUserFields,
} from "../../../src/hermes/hermesAssignee";

describe("Hermes assignee helpers", () => {
	it("adds a native Assignee user field when missing", () => {
		const fields = ensureHermesAssigneeUserField([]);

		expect(fields).toEqual([
			{
				id: "assignee",
				displayName: "Assignee",
				key: "assignee",
				type: "text",
			},
		]);
		expect(hasHermesAssigneeUserField(fields)).toBe(true);
	});

	it("leaves existing assignee user fields untouched", () => {
		const fields = [{ id: "owner", displayName: "Owner", key: "assignee", type: "text" as const }];

		expect(ensureHermesAssigneeUserField(fields)).toEqual(fields);
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
				type: "text",
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

	it("clears none-like assignees", () => {
		expect(buildHermesAssigneeUpdatePayload("none")).toEqual({
			assignee: null,
		});
		expect(buildHermesAssigneeUpdatePayload("")).toEqual({
			assignee: null,
		});
	});
});
