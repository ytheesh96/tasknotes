import { MockObsidian } from "../../__mocks__/obsidian";
import {
	createCompletionPlugin,
	createMarkdownFile,
	getCompletionResult,
} from "../helpers/nlpCompletionTestUtils";

describe("+ board autocomplete", () => {
	beforeEach(() => {
		MockObsidian.reset();
	});

	it("suggests Hermes boards instead of project notes", async () => {
		const plugin = createCompletionPlugin();
		createMarkdownFile("TaskNotes/obsidian-os/t_12345678.md", {
			title: "Triage vault session Git blockers",
		});
		createMarkdownFile("Projects/Default.md", { title: "Default project note" });

		const result = await getCompletionResult(plugin, "+");

		expect(result?.options).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					label: "default",
					apply: "default ",
					info: "Board",
				}),
				expect.objectContaining({
					label: "obsidian-os",
					apply: "obsidian-os ",
					info: "Board",
				}),
			])
		);
		expect(result?.options.map((option) => option.label)).not.toContain("Default");
		expect(result?.options.map((option) => option.label)).not.toContain(
			"Triage vault session Git blockers"
		);
	});

	it("filters board suggestions by query", async () => {
		const plugin = createCompletionPlugin();

		const result = await getCompletionResult(plugin, "+hh");

		expect(result?.from).toBe("+".length);
		expect(result?.options).toEqual([
			expect.objectContaining({
				label: "hhmi",
				apply: "hhmi ",
				info: "Board",
			}),
		]);
	});
});
