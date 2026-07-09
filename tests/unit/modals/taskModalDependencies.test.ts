import { TFile } from "obsidian";
import type { TaskInfo } from "../../../src/types";

jest.mock("../../../src/ui/TaskCard", () => ({
	createTaskCard: jest.fn((task: TaskInfo) => {
		const card = document.createElement("div");
		card.className = "task-card";
		card.textContent = task.title;
		return card;
	}),
}));

import { createTaskCard } from "../../../src/ui/TaskCard";
import {
	addDependencyItem,
	getBlockedByDependencyCandidates,
	getBlockingDependencyCandidates,
	removeDependencyItemAtIndex,
	renderDependencyList,
	type DependencyItem,
} from "../../../src/modals/taskModalDependencies";

function task(path: string): TaskInfo {
	return {
		title: path,
		status: "open",
		priority: "normal",
		path,
		archived: false,
	};
}

function dependency(uid: string, path?: string): DependencyItem {
	return {
		dependency: { uid, reltype: "FINISHTOSTART" },
		name: path ?? uid,
		path,
	};
}

function createPlugin(paths: string[], useMarkdownLinks = false): any {
	const files = new Map(paths.map((path) => [path, new TFile(path)]));
	return {
		app: {
			vault: {
				getAbstractFileByPath: (path: string) => files.get(path) ?? null,
			},
			metadataCache: {
				fileToLinktext: (file: TFile) => file.path.replace(/\.md$/i, ""),
			},
			fileManager: {
				generateMarkdownLink: (file: TFile) => `[${file.basename}](${file.path})`,
			},
			workspace: {
				openLinkText: jest.fn(),
				getLeaf: jest.fn(),
			},
		},
		settings: { useFrontmatterMarkdownLinks: useMarkdownLinks },
		cacheManager: {
			getTaskInfoFromFrontmatter: jest.fn(),
			getTaskInfo: jest.fn(),
		},
	};
}

describe("taskModalDependencies state helpers", () => {
	it("adds dependency items without duplicating by uid or path", () => {
		const existing = [dependency("[[Tasks/one]]", "Tasks/one.md")];

		expect(addDependencyItem(existing, dependency("[[Tasks/one]]"))).toEqual(existing);
		expect(addDependencyItem(existing, dependency("[[Other]]", "Tasks/one.md"))).toEqual(
			existing
		);
		expect(addDependencyItem(existing, dependency("[[Tasks/two]]", "Tasks/two.md"))).toEqual([
			...existing,
			dependency("[[Tasks/two]]", "Tasks/two.md"),
		]);
	});

	it("removes dependency items by index", () => {
		const first = dependency("[[Tasks/one]]", "Tasks/one.md");
		const second = dependency("[[Tasks/two]]", "Tasks/two.md");

		expect(removeDependencyItemAtIndex([first, second], 0)).toEqual([second]);
		expect(removeDependencyItemAtIndex([first], 5)).toEqual([first]);
	});

	it("filters blocked-by candidates by current task and existing dependency uid", () => {
		const plugin = createPlugin([
			"Tasks/current.md",
			"Tasks/existing.md",
			"Tasks/available.md",
		]);
		const allTasks = [
			task("Tasks/current.md"),
			task("Tasks/existing.md"),
			task("Tasks/available.md"),
		];

		expect(
			getBlockedByDependencyCandidates({
				plugin,
				sourcePath: "Tasks/current.md",
				allTasks,
				existingItems: [dependency("[[Tasks/existing]]", "Tasks/existing.md")],
				currentPath: "Tasks/current.md",
			}).map((candidate) => candidate.path)
		).toEqual(["Tasks/available.md"]);
	});

	it("filters blocking candidates by current task, existing path, and existing uid", () => {
		const plugin = createPlugin([
			"Tasks/current.md",
			"Tasks/existing-path.md",
			"Tasks/existing-uid.md",
			"Tasks/available.md",
		]);
		const allTasks = [
			task("Tasks/current.md"),
			task("Tasks/existing-path.md"),
			task("Tasks/existing-uid.md"),
			task("Tasks/available.md"),
		];

		expect(
			getBlockingDependencyCandidates({
				plugin,
				sourcePath: "Tasks/current.md",
				allTasks,
				existingItems: [
					dependency("[[Different uid]]", "Tasks/existing-path.md"),
					dependency("[[Tasks/existing-uid]]"),
				],
				currentPath: "Tasks/current.md",
			}).map((candidate) => candidate.path)
		).toEqual(["Tasks/available.md"]);
	});

	it("renders resolved dependency cards from note frontmatter before pending cache data", async () => {
		const plugin = createPlugin(["Tasks/current.md", "Tasks/dependency.md"]);
		const freshTask = { ...task("Tasks/dependency.md"), title: "Fresh dependency" };
		const staleTask = { ...task("Tasks/dependency.md"), title: "Stale dependency" };
		plugin.cacheManager.getTaskInfoFromFrontmatter.mockResolvedValue(freshTask);
		plugin.cacheManager.getTaskInfo.mockResolvedValue(staleTask);
		const listEl = document.createElement("div");

		await renderDependencyList({
			plugin,
			listEl,
			items: [dependency("[[Tasks/dependency]]", "Tasks/dependency.md")],
			linkServices: {
				metadataCache: plugin.app.metadataCache,
				workspace: plugin.app.workspace,
			},
			translate: (key) => key,
			onRemove: jest.fn(),
		});

		expect(plugin.cacheManager.getTaskInfoFromFrontmatter).toHaveBeenCalledWith(
			"Tasks/dependency.md"
		);
		expect(plugin.cacheManager.getTaskInfo).not.toHaveBeenCalled();
		expect(createTaskCard).toHaveBeenCalledWith(
			freshTask,
			plugin,
			undefined,
			expect.objectContaining({
				layout: "default",
				showSecondaryBadges: false,
				enableHoverPreview: false,
			})
		);
		expect(listEl.querySelector(".task-card")?.textContent).toBe("Fresh dependency");
	});
});
