import type { App } from "obsidian";
import { NLPSuggest } from "../../../src/modals/taskCreationSuggest";
import { MockObsidian } from "../../__mocks__/obsidian";

jest.mock("obsidian");

const createMockApp = (mockApp: unknown): App => mockApp as App;

describe("NLPSuggest board fallback", () => {
	beforeEach(() => {
		MockObsidian.reset();
		document.body.innerHTML = "";
	});

	it("suggests Hermes boards for the + trigger", async () => {
		const app = createMockApp(MockObsidian.createMockApp());
		const plugin = {
			settings: {
				statusSuggestionTrigger: "/",
				projectAutosuggest: { rows: [] },
			},
			cacheManager: {
				getAllContexts: jest.fn(() => []),
				getAllTags: jest.fn(() => []),
			},
			fieldMapper: {
				mapFromFrontmatter: jest.fn(() => ({ title: "" })),
			},
			app,
		};
		const input = document.createElement("textarea");
		input.value = "+hh";
		document.body.appendChild(input);
		const suggest = new NLPSuggest(app, input, plugin as never);

		const suggestions = await (suggest as unknown as {
			getSuggestions(query: string): Promise<Array<{ basename: string; displayName: string }>>;
		}).getSuggestions("");

		expect(suggestions).toEqual([
			expect.objectContaining({
				basename: "hhmi",
				displayName: "hhmi",
			}),
		]);
	});

	it("inserts a board slug instead of a wikilink", async () => {
		const app = createMockApp(MockObsidian.createMockApp());
		const plugin = {
			settings: {
				statusSuggestionTrigger: "/",
				projectAutosuggest: { rows: [] },
			},
			cacheManager: {
				getAllContexts: jest.fn(() => []),
				getAllTags: jest.fn(() => []),
			},
			fieldMapper: {
				mapFromFrontmatter: jest.fn(() => ({ title: "" })),
			},
			app,
		};
		const input = document.createElement("textarea");
		input.value = "+hh";
		input.setSelectionRange(input.value.length, input.value.length);
		document.body.appendChild(input);
		const suggest = new NLPSuggest(app, input, plugin as never);
		const [hhmi] = await (suggest as unknown as {
			getSuggestions(query: string): Promise<
				Array<{ basename: string; displayName: string; type: "project" }>
			>;
		}).getSuggestions("");

		suggest.selectSuggestion({
			...hhmi,
			toString() {
				return this.basename;
			},
		});

		expect(input.value).toBe("+hhmi ");
	});
});
