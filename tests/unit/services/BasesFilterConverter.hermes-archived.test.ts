import { BasesFilterConverter } from "../../../src/services/BasesFilterConverter";
import type { FilterQuery } from "../../../src/types";
import { PluginFactory } from "../../helpers/mock-factories";

function archivedQuery(operator: "is-checked" | "is-not-checked"): FilterQuery {
	return {
		type: "group",
		id: "root",
		conjunction: "and",
		children: [
			{
				type: "condition",
				id: "archived",
				property: "archived",
				operator,
				value: null,
			},
		],
	};
}

describe("BasesFilterConverter Hermes archived handling", () => {
	it("uses hermesArchived before falling back to the archive tag", () => {
		const converter = new BasesFilterConverter(PluginFactory.createMockPlugin());

		expect(converter.convertToBasesFilter(archivedQuery("is-checked"))).toBe(
			'((note.hermesArchived == true || note.hermesArchived == "true") || (!(note.hermesArchived == false || note.hermesArchived == "false") && file.tags.contains("archived")))'
		);
	});

	it("negates the combined Hermes/archive-tag expression for not archived filters", () => {
		const converter = new BasesFilterConverter(PluginFactory.createMockPlugin());

		expect(converter.convertToBasesFilter(archivedQuery("is-not-checked"))).toBe(
			'!(((note.hermesArchived == true || note.hermesArchived == "true") || (!(note.hermesArchived == false || note.hermesArchived == "false") && file.tags.contains("archived"))))'
		);
	});
});
