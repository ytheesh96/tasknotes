import { migrateUserFieldsToFieldConfig } from "../../../src/utils/fieldConfigDefaults";

describe("fieldConfigDefaults", () => {
	it("keeps all migrated user fields in the custom modal group", () => {
		const fields = migrateUserFieldsToFieldConfig([
			{ id: "assignee", key: "assignee", displayName: "Assignee", type: "text" },
			{ id: "effort", key: "effort", displayName: "Effort", type: "number" },
		]);

		expect(fields).toEqual([
			expect.objectContaining({
				id: "assignee",
				fieldType: "user",
				group: "custom",
				displayName: "Assignee",
			}),
			expect.objectContaining({
				id: "effort",
				fieldType: "user",
				group: "custom",
				displayName: "Effort",
			}),
		]);
	});
});
