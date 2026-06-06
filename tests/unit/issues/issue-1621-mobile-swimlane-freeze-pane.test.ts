import fs from "fs";
import path from "path";

function readKanbanCss(): string {
	return fs.readFileSync(
		path.resolve(__dirname, "../../../styles/kanban-view.css"),
		"utf8"
	);
}

function extractCssBlock(css: string, selector: string): string {
	const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = css.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
	return match?.[1] ?? "";
}

describe("Issue #1621: mobile Kanban swimlane sections", () => {
	it("keeps swimlane sections compact on mobile", () => {
		const css = readKanbanCss();
		const block = extractCssBlock(
			css,
			"body.is-mobile .tasknotes-plugin .kanban-view__swimlane-column"
		);

		expect(block).toContain("padding: var(--tn-spacing-xs);");
		expect(block).toContain("min-height: 56px;");
		expect(block).toContain("max-height: none;");
	});

	it("keeps swimlane boards column-oriented on mobile", () => {
		const css = readKanbanCss();
		const boardBlock = extractCssBlock(
			css,
			"body.is-mobile .tasknotes-plugin .kanban-view__board--swimlanes"
		);

		expect(boardBlock).toContain("--kanban-column-width: minmax(156px, 64vw);");
	});
});
