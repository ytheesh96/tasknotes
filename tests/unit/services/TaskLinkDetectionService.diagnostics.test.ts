import { TFile } from "obsidian";
import type TaskNotesPlugin from "../../../src/main";
import { TaskLinkDetectionService } from "../../../src/services/TaskLinkDetectionService";
import { createTaskNotesLogger } from "../../../src/utils/tasknotesLogger";

function createSink() {
	return {
		debug: jest.fn(),
		info: jest.fn(),
		warn: jest.fn(),
		error: jest.fn(),
	};
}

function createPlugin(options: {
	file?: TFile | null;
	getTaskInfo?: jest.Mock;
	getTaskInfoFromFrontmatter?: jest.Mock;
	resolveLink?: jest.Mock;
	debugEnabled?: () => boolean;
}): TaskNotesPlugin {
	const file = options.file ?? null;
	const resolveLink = options.resolveLink ?? jest.fn(() => file);
	const getTaskInfo = options.getTaskInfo ?? jest.fn(async () => null);

	return {
		settings: {
			get enableDebugLogging() {
				return options.debugEnabled?.() ?? false;
			},
		},
		app: {
			vault: {
				getAbstractFileByPath: jest.fn((path: string) => {
					return file?.path === path ? file : null;
				}),
			},
			metadataCache: {
				getFirstLinkpathDest: resolveLink,
			},
		},
		cacheManager: {
			getTaskInfo,
			getTaskInfoFromFrontmatter: options.getTaskInfoFromFrontmatter,
		},
	} as unknown as TaskNotesPlugin;
}

describe("TaskLinkDetectionService diagnostics", () => {
	it("routes task metadata read failures through debug-gated diagnostics", async () => {
		const sink = createSink();
		let debugEnabled = false;
		const file = new TFile("Tasks/Linked Task.md");
		const error = new Error("cache unavailable");
		const plugin = createPlugin({
			file,
			getTaskInfo: jest.fn(async () => {
				throw error;
			}),
			debugEnabled: () => debugEnabled,
		});
		const logger = createTaskNotesLogger({
			tag: "TaskLinkDetectionService",
			isDebugEnabled: () => debugEnabled,
			sink,
		});
		const service = new TaskLinkDetectionService(plugin, logger);

		await expect(service.detectTaskLink("[[Linked Task]]", "Notes/source.md")).resolves.toEqual({
			isValidTaskLink: false,
		});
		expect(sink.debug).not.toHaveBeenCalled();

		debugEnabled = true;
		await expect(service.detectTaskLink("[[Linked Task]]", "Notes/source.md")).resolves.toEqual({
			isValidTaskLink: false,
		});
		expect(sink.debug).toHaveBeenCalledWith(
			"[TaskNotes][TaskLinkDetectionService][stale-data][detect-task-link] Error checking task info for link",
			{ resolvedPath: "Tasks/Linked Task.md" },
			error
		);
	});

	it("logs malformed markdown link decoding only when debug logging is enabled", async () => {
		const sink = createSink();
		let debugEnabled = false;
		const plugin = createPlugin({ debugEnabled: () => debugEnabled });
		const logger = createTaskNotesLogger({
			tag: "TaskLinkDetectionService",
			isDebugEnabled: () => debugEnabled,
			sink,
		});
		const service = new TaskLinkDetectionService(plugin, logger);

		await service.detectTaskLink("[bad](Tasks/%E0%A4%A.md)", "Notes/source.md", "markdown");
		expect(sink.debug).not.toHaveBeenCalled();

		debugEnabled = true;
		await service.detectTaskLink("[bad](Tasks/%E0%A4%A.md)", "Notes/source.md", "markdown");
		expect(sink.debug).toHaveBeenCalledWith(
			"[TaskNotes][TaskLinkDetectionService][validation][parse-markdown-link] Failed to decode URI component",
			{ linkPath: "Tasks/%E0%A4%A.md" },
			expect.any(URIError)
		);
	});

	it("logs Obsidian link-resolution failures with source context", async () => {
		const sink = createSink();
		const error = new Error("metadata cache failed");
		const plugin = createPlugin({
			resolveLink: jest.fn(() => {
				throw error;
			}),
			debugEnabled: () => true,
		});
		const logger = createTaskNotesLogger({
			tag: "TaskLinkDetectionService",
			isDebugEnabled: () => true,
			sink,
		});
		const service = new TaskLinkDetectionService(plugin, logger);

		await expect(service.detectTaskLink("[[Linked Task]]", "Notes/source.md")).resolves.toEqual({
			isValidTaskLink: false,
		});
		expect(sink.debug).toHaveBeenCalledWith(
			"[TaskNotes][TaskLinkDetectionService][provider][resolve-link-path] Error resolving link path",
			{ linkPath: "Linked Task", sourcePath: "Notes/source.md" },
			error
		);
	});

	it("detects task links from note frontmatter before pending cache data", async () => {
		const file = new TFile("Tasks/Linked Task.md");
		const staleTask = {
			title: "Stale pending title",
			status: "open",
			priority: "normal",
			path: file.path,
			archived: false,
		};
		const frontmatterTask = {
			...staleTask,
			title: "Fresh frontmatter title",
			status: "done",
		};
		const getTaskInfo = jest.fn(async () => staleTask);
		const getTaskInfoFromFrontmatter = jest.fn(async () => frontmatterTask);
		const plugin = createPlugin({
			file,
			getTaskInfo,
			getTaskInfoFromFrontmatter,
		});
		const service = new TaskLinkDetectionService(plugin);

		await expect(service.detectTaskLink("[[Linked Task]]", "Notes/source.md")).resolves.toEqual({
			isValidTaskLink: true,
			taskPath: file.path,
			taskInfo: frontmatterTask,
			displayText: undefined,
		});
		expect(getTaskInfoFromFrontmatter).toHaveBeenCalledWith(file.path);
		expect(getTaskInfo).not.toHaveBeenCalled();
	});
});
