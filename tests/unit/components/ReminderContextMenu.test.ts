import { ReminderContextMenu } from "../../../src/components/ReminderContextMenu";
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
		due: "2026-06-05",
		...overrides,
	};
}

function createPlugin(frontmatterTask: TaskInfo | null, cacheTask: TaskInfo | null): TaskNotesPlugin {
	return {
		app: {},
		i18n: {
			translate: jest.fn((key: string) => key),
		},
		cacheManager: {
			getTaskInfoFromFrontmatter: jest.fn(async () => frontmatterTask),
			getTaskInfo: jest.fn(async () => cacheTask),
		},
		taskService: {
			updateProperty: jest.fn(async (task: TaskInfo, property: string, value: unknown) => ({
				...task,
				[property]: value,
			})),
		},
	} as unknown as TaskNotesPlugin;
}

describe("ReminderContextMenu", () => {
	afterEach(() => {
		jest.restoreAllMocks();
	});

	it("appends quick reminders from note frontmatter before pending cache data", async () => {
		jest.spyOn(Date, "now").mockReturnValue(42);

		const existingReminder: Reminder = {
			id: "frontmatter-reminder",
			type: "relative",
			relatedTo: "due",
			offset: "-PT5M",
		};
		const staleReminder: Reminder = {
			id: "stale-cache-reminder",
			type: "relative",
			relatedTo: "due",
			offset: "-PT1H",
		};
		const frontmatterTask = createTask({
			title: "Frontmatter task",
			reminders: [existingReminder],
		});
		const cacheTask = createTask({
			title: "Pending cache task",
			reminders: [staleReminder],
		});
		const plugin = createPlugin(frontmatterTask, cacheTask);
		const onUpdate = jest.fn();
		const menu = new ReminderContextMenu(
			plugin,
			createTask({ reminders: [staleReminder] }),
			document.createElement("button"),
			onUpdate
		);

		await (menu as any).addQuickReminder("due", "-PT15M", "15 minutes before");

		const addedReminder: Reminder = {
			id: "rem_42",
			type: "relative",
			relatedTo: "due",
			offset: "-PT15M",
			description: "15 minutes before",
		};
		const expectedReminders = [existingReminder, addedReminder];

		expect(plugin.cacheManager.getTaskInfoFromFrontmatter).toHaveBeenCalledWith(
			"Tasks/Reminder.md"
		);
		expect(plugin.cacheManager.getTaskInfo).not.toHaveBeenCalled();
		expect(plugin.taskService.updateProperty).toHaveBeenCalledWith(
			expect.objectContaining({
				title: "Frontmatter task",
				reminders: expectedReminders,
			}),
			"reminders",
			expectedReminders
		);
		expect(onUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				title: "Frontmatter task",
				reminders: expectedReminders,
			})
		);
	});
});
