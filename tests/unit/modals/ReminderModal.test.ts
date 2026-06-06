import { ReminderModal } from "../../../src/modals/ReminderModal";
import type TaskNotesPlugin from "../../../src/main";
import type { Reminder, TaskInfo } from "../../../src/types";

jest.mock("obsidian");

function createTask(overrides: Partial<TaskInfo> = {}): TaskInfo {
	return {
		title: "Reminder task",
		status: "open",
		priority: "normal",
		path: "Tasks/Reminder.md",
		archived: false,
		...overrides,
	};
}

function createPlugin(frontmatterTask: TaskInfo | null, cacheTask: TaskInfo | null): TaskNotesPlugin {
	return {
		app: {},
		cacheManager: {
			getTaskInfoFromFrontmatter: jest.fn(async () => frontmatterTask),
			getTaskInfo: jest.fn(async () => cacheTask),
		},
		emitter: {
			trigger: jest.fn(),
		},
	} as unknown as TaskNotesPlugin;
}

describe("ReminderModal", () => {
	it("renders reminders from note frontmatter before pending cache data", async () => {
		const frontmatterReminder: Reminder = {
			id: "frontmatter-reminder",
			type: "relative",
			relatedTo: "due",
			offset: "-PT5M",
		};
		const cacheReminder: Reminder = {
			id: "stale-cache-reminder",
			type: "relative",
			relatedTo: "scheduled",
			offset: "-PT1H",
		};
		const frontmatterTask = createTask({
			title: "Frontmatter task",
			due: "2026-06-05",
			reminders: [frontmatterReminder],
		});
		const cacheTask = createTask({
			title: "Pending cache task",
			scheduled: "2026-06-06",
			reminders: [cacheReminder],
		});
		const plugin = createPlugin(frontmatterTask, cacheTask);
		const modal = new ReminderModal(
			{} as any,
			plugin,
			createTask({ title: "Initial stale task", reminders: [cacheReminder] }),
			jest.fn()
		);

		await (modal as any).initializeWithFreshData();

		expect(plugin.cacheManager.getTaskInfoFromFrontmatter).toHaveBeenCalledWith(
			"Tasks/Reminder.md"
		);
		expect(plugin.cacheManager.getTaskInfo).not.toHaveBeenCalled();
		expect((modal as any).task).toBe(frontmatterTask);
		expect((modal as any).reminders).toEqual([frontmatterReminder]);
		expect(modal.contentEl.querySelector(".reminder-modal__task-title")?.textContent).toBe(
			"Frontmatter task"
		);
		expect(modal.contentEl.querySelector(".reminder-modal__reminder-primary")?.textContent).toBe(
			"5 minutes before due date"
		);
	});
});
