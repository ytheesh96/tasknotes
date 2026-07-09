import {
	parseHermesComment,
	type HermesCommentPresentationModel,
} from "../../../src/hermes/hermesCommentParser";

describe("Hermes comment parser", () => {
	it("normalizes review-required handoff comments with prefixed prose and fenced JSON", () => {
		const raw = [
			"review-required handoff:",
			"```json",
			JSON.stringify(
				{
					status: "blocked",
					summary: "Rate limiter shipped and needs review.",
					next_action: "review fallback key choice",
					run_id: 137,
					profile: "peacock",
					changed_files: ["src/rateLimiter.ts", "tests/rateLimiter.test.ts"],
					tests_run: 14,
					tests_passed: 14,
					artifacts: ["/tmp/review.md"],
					needs_review: true,
				},
				null,
				2
			),
			"```",
		].join("\n");

		const model = parseHermesComment(raw, { author: "peacock", createdAt: 1780435951 });

		expect(model).toMatchObject<HermesCommentPresentationModel>({
			kind: "review-required",
			severity: "blocked",
			title: "Review required",
			summary: "Rate limiter shipped and needs review.",
			raw,
		});
		expect(model.chips).toEqual(
			expect.arrayContaining([
				{ label: "Status", value: "blocked" },
				{ label: "Run", value: "137" },
				{ label: "Profile", value: "peacock" },
				{ label: "Changed files", value: "2 files" },
				{ label: "Tests", value: "14/14 passed" },
			])
		);
		expect(model.artifacts).toEqual(
			expect.arrayContaining([
				{ label: "Open review.md", value: "/tmp/review.md", type: "artifact" },
			])
		);
		expect(model.actions).toEqual(
			expect.arrayContaining([
				{ label: "Open review.md", value: "/tmp/review.md", type: "artifact" },
			])
		);
	});

	it("parses the first valid JSON object after malformed prose objects", () => {
		const raw = [
			"Worker note before payload {not valid json}",
			"handoff:",
			JSON.stringify({
				summary: "Implementation handoff is ready.",
				changed_files: ["src/hermes/hermesCommentParser.ts"],
				verification: { typecheck: "passed", lint: "passed" },
			}),
		].join("\n");

		const model = parseHermesComment(raw);

		expect(model.kind).toBe("handoff");
		expect(model.severity).toBe("success");
		expect(model.summary).toBe("Implementation handoff is ready.");
		expect(model.chips).toEqual(
			expect.arrayContaining([
				{ label: "Changed files", value: "1 file" },
				{ label: "Typecheck", value: "passed" },
				{ label: "Lint", value: "passed" },
			])
		);
	});

	it("classifies plain JSON handoffs without prose or fences", () => {
		const raw = JSON.stringify({
			summary: "Implementation handoff is ready for QA.",
			status: "done",
			run_id: 144,
			profile: "peacock",
			tests_run: 16,
			tests_passed: 16,
		});

		const model = parseHermesComment(raw);

		expect(model).toMatchObject({
			kind: "handoff",
			severity: "success",
			title: "Handoff",
			summary: "Implementation handoff is ready for QA.",
			raw,
		});
		expect(model.chips).toEqual(
			expect.arrayContaining([
				{ label: "Status", value: "done" },
				{ label: "Run", value: "144" },
				{ label: "Profile", value: "peacock" },
				{ label: "Tests", value: "16/16 passed" },
			])
		);
	});

	it("extracts artifact reports and task links from structured payloads and prose", () => {
		const raw = [
			"artifact report for t_4cd03c0f",
			JSON.stringify({
				artifacts: ["/tmp/report.md", "https://example.com/demo.pdf"],
				diff_path: "/tmp/tasknotes-hermes.diff",
				qa_report: "TaskNotes/default/qa-report.md",
				notes: "Created follow-up t_9abc1234",
			}),
		].join("\n");

		const model = parseHermesComment(raw);

		expect(model.kind).toBe("artifact-report");
		expect(model.title).toBe("Artifacts");
		expect(model.artifacts).toEqual(
			expect.arrayContaining([
				{ label: "Open report.md", value: "/tmp/report.md", type: "artifact" },
				{ label: "Open demo.pdf", value: "https://example.com/demo.pdf", type: "artifact" },
				{
					label: "Open tasknotes-hermes.diff",
					value: "/tmp/tasknotes-hermes.diff",
					type: "artifact",
				},
				{
					label: "Open qa-report.md",
					value: "TaskNotes/default/qa-report.md",
					type: "artifact",
				},
			])
		);
		expect(model.actions).toEqual(
			expect.arrayContaining([
				{ label: "Edit t_4cd03c0f", value: "t_4cd03c0f", type: "task" },
				{ label: "Edit t_9abc1234", value: "t_9abc1234", type: "task" },
			])
		);
	});

	it("merges structured metadata when the raw comment has no JSON payload", () => {
		const model = parseHermesComment("blocked: missing credentials", {
			metadata: {
				status: "blocked",
				reason: "OAuth token missing",
				assignee: "reviewer",
				blocked_by: ["human input"],
			},
		});

		expect(model).toMatchObject({
			kind: "handoff",
			severity: "blocked",
			title: "Blocked",
			summary: "OAuth token missing",
		});
		expect(model.chips).toEqual(
			expect.arrayContaining([
				{ label: "Assignee", value: "reviewer" },
				{ label: "Blocked by", value: "1 item" },
			])
		);
	});

	it("classifies malformed JSON and ordinary comments as comments without throwing", () => {
		expect(() => parseHermesComment('```json\n{"summary":\n```')).not.toThrow();

		const malformed = parseHermesComment('```json\n{"summary":\n```', { author: "yt" });
		expect(malformed.kind).toBe("comment");
		expect(malformed.severity).toBe("info");
		expect(malformed.summary).toContain('{"summary":');
		expect(malformed.raw).toBe('```json\n{"summary":\n```');

		const ordinary = parseHermesComment("Looks good to me.", { author: "yt" });
		expect(ordinary).toMatchObject({
			kind: "comment",
			severity: "info",
			title: "yt",
			summary: "Looks good to me.",
			raw: "Looks good to me.",
		});
	});
});
