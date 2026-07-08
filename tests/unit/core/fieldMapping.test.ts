import {
	mapTaskFromFrontmatter,
	mapTaskToFrontmatter,
	validateFieldMapping,
} from "../../../src/core/fieldMapping";
import { DEFAULT_FIELD_MAPPING } from "../../../src/settings/defaults";

describe("core/fieldMapping", () => {
	it("maps frontmatter into task fields without a FieldMapper instance", () => {
		const mapped = mapTaskFromFrontmatter(
			DEFAULT_FIELD_MAPPING,
			{
				title: "Mapped title",
				status: true,
				contexts: "work",
				projects: ["alpha"],
				recurrence_anchor: "completion",
				complete_instances: ["2026-03-01", 123, "2026-03-02"],
				tags: ["task", "archived"],
				archived: true,
			},
			"Tasks/Mapped title.md",
			true
		);

		expect(mapped).toMatchObject({
			title: "Mapped title",
			status: "true",
			contexts: ["work"],
			projects: ["alpha"],
			recurrence_anchor: "completion",
			complete_instances: ["2026-03-01", "2026-03-02"],
			tags: ["task", "archived"],
			archived: true,
			path: "Tasks/Mapped title.md",
		});
	});

	it("uses Hermes archived frontmatter as the TaskNotes archived state when present", () => {
		const mapped = mapTaskFromFrontmatter(
			DEFAULT_FIELD_MAPPING,
			{
				title: "Hermes task",
				status: "done",
				tags: ["task", "archived"],
				hermesTaskId: "t_1234abcd",
				hermesBoard: "default",
				hermesArchived: false,
			},
			"TaskNotes/Tasks/default--t_1234abcd.md",
			true
		);

		expect(mapped.archived).toBe(false);
		expect(mapped.tags).toEqual(["task", "archived"]);
		expect(mapped.customProperties).toMatchObject({
			hermesTaskId: "t_1234abcd",
			hermesBoard: "default",
			hermesArchived: false,
		});
	});

	it("normalizes legacy Hermes archived frontmatter aliases", () => {
		const mapped = mapTaskFromFrontmatter(
			DEFAULT_FIELD_MAPPING,
			{
				title: "Legacy Hermes task",
				status: "done",
				hermes_task_id: "t_1234abcd",
				hermes_board: "default",
				hermes_archived: "true",
			},
			"TaskNotes/Tasks/default--t_1234abcd.md",
			true
		);

		expect(mapped.archived).toBe(true);
		expect(mapped.customProperties).toMatchObject({
			hermesTaskId: "t_1234abcd",
			hermesBoard: "default",
			hermesArchived: true,
			hermes_archived: "true",
		});
	});

	it("maps task fields back to frontmatter with serialized dependency data", () => {
		const frontmatter = mapTaskToFrontmatter(
			DEFAULT_FIELD_MAPPING,
			{
				title: "Task",
				status: "open",
				blockedBy: [{ uid: "[[Other Task]]", reltype: "FINISHTOSTART" }],
				recurrence_anchor: "scheduled",
				tags: ["alpha"],
				archived: true,
			},
			"task"
		);

		expect(frontmatter.title).toBe("Task");
		expect(frontmatter.status).toBe("open");
		expect(frontmatter.recurrence_anchor).toBe("scheduled");
		expect(frontmatter.blockedBy).toEqual([{ uid: "[[Other Task]]", reltype: "FINISHTOSTART" }]);
		expect(frontmatter.tags).toEqual(expect.arrayContaining(["alpha", "task"]));
		expect(frontmatter.archived).toBe(true);
	});

	it("validates duplicate mapping values as invalid", () => {
		const duplicateMapping = {
			...DEFAULT_FIELD_MAPPING,
			status: "title",
		};

		const result = validateFieldMapping(duplicateMapping);
		expect(result.valid).toBe(false);
		expect(result.errors).toContain("Field mappings must have unique property names");
	});
});
