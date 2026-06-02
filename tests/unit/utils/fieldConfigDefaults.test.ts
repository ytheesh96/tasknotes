import { migrateUserFieldsToFieldConfig } from "../../../src/utils/fieldConfigDefaults";

describe("fieldConfigDefaults", () => {
	it("promotes assignee user fields into the routing modal group", () => {
		const fields = migrateUserFieldsToFieldConfig([
			{ id: "assignee", key: "assignee", displayName: "Assignee", type: "text" },
			{ id: "effort", key: "effort", displayName: "Effort", type: "number" },
		]);

		expect(fields).toEqual([
			expect.objectContaining({
				id: "assignee",
				fieldType: "user",
				group: "routing",
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
