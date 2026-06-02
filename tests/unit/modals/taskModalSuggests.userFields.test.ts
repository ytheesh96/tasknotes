import { App } from "obsidian";
import { UserFieldSuggest } from "../../../src/modals/taskModalSuggests";
import { MockObsidian } from "../../__mocks__/obsidian";

jest.mock("obsidian");

const createMockApp = (mockApp: unknown): App => mockApp as App;

function createPlugin(app: App) {
	return {
		app,
		settings: {
			suggestionDebounceMs: 0,
		},
	};
}

describe("UserFieldSuggest list defaults", () => {
	let app: App;

	beforeEach(() => {
		MockObsidian.reset();
		app = createMockApp(MockObsidian.createMockApp());
		document.body.innerHTML = "";
	});

	it("does not open ordinary list field suggestions just because the empty field is focused", () => {
		const input = document.createElement("input");
		document.body.appendChild(input);
		const suggest = new UserFieldSuggest(app, input, createPlugin(app) as never, {
			id: "worker",
			displayName: "Worker",
			key: "worker",
			type: "list",
			defaultValue: ["orchestrator", "human"],
		});
		const openSpy = jest.spyOn(suggest, "open");

		input.dispatchEvent(new Event("focus"));

		expect(openSpy).not.toHaveBeenCalled();
	});

	it("suggests list defaults together with values already used in notes", async () => {
		MockObsidian.createTestFile(
			"TaskNotes/default/t_existing.md",
			"---\nworker: reviewer-qa\n---\n"
		);
		app.metadataCache.setCache("TaskNotes/default/t_existing.md", {
			frontmatter: { worker: "reviewer-qa" },
		});
		const input = document.createElement("input");
		input.value = "r";
		document.body.appendChild(input);
		const suggest = new UserFieldSuggest(app, input, createPlugin(app) as never, {
			id: "worker",
			displayName: "Worker",
			key: "worker",
			type: "list",
			defaultValue: ["orchestrator", "human"],
		});

		const suggestions = await (suggest as unknown as {
			getSuggestions(query: string): Promise<Array<{ value: string }>>;
		}).getSuggestions("");

		expect(suggestions.map((suggestion) => suggestion.value)).toEqual([
			"orchestrator",
			"reviewer-qa",
		]);
	});

	it("does not re-suggest an already selected list value", async () => {
		const input = document.createElement("input");
		input.value = "human, o";
		document.body.appendChild(input);
		const suggest = new UserFieldSuggest(app, input, createPlugin(app) as never, {
			id: "worker",
			displayName: "Worker",
			key: "worker",
			type: "list",
			defaultValue: ["orchestrator", "human"],
		});

		const suggestions = await (suggest as unknown as {
			getSuggestions(query: string): Promise<Array<{ value: string }>>;
		}).getSuggestions("");

		expect(suggestions.map((suggestion) => suggestion.value)).toEqual(["orchestrator"]);
	});
});
