import type { DAGState, IssueResult } from "./schemas.js";
import type { ExecutionConfig } from "./ExecutionConfig.js";
import type { IssueOutcome, AdvisorAction } from "./schemas.js";
import { ISSUE_OUTCOME } from "./schemas.js";
import { FatalHarnessError } from "./fatal_error.js";
import { SplitIssueSpecSchema } from "./schemas.js";

type CallFn = (
	target: string,
	kwargs?: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

async function _call_with_timeout<T>(
	coro: Promise<T>,
	timeout = 2700000,
	label = "",
): Promise<T> {
	try {
		return await Promise.race([
			coro,
			new Promise<never>((_, reject) =>
				setTimeout(
					() =>
						reject(
							new Error(
								`Agent call '${label}' timed out after ${timeout / 1000}s`,
							),
						),
					timeout,
				),
			),
		]);
	} catch (e) {
		if (e instanceof Error && e.message.includes("timed out")) {
			throw new Error(
				`Agent call '${label}' timed out after ${timeout / 1000}s`,
			);
		}
		throw e;
	}
}

function _iteration_state_path(
	artifacts_dir: string,
	issue_name: string,
	build_id = "",
): string {
	if (!artifacts_dir) return "";
	const base = "execution/iterations";
	if (build_id) {
		return `${artifacts_dir}/${base}/${build_id}/${issue_name}.json`;
	}
	return `${artifacts_dir}/${base}/${issue_name}.json`;
}

function _save_iteration_state(
	artifacts_dir: string,
	issue_name: string,
	state: Record<string, unknown>,
	build_id = "",
): void {
	const path = _iteration_state_path(artifacts_dir, issue_name, build_id);
	if (!path) return;
	const { mkdirSync, writeFileSync } =
		require("node:fs") as typeof import("node:fs");
	const dir = path.substring(0, path.lastIndexOf("/"));
	mkdirSync(dir, { recursive: true });
	writeFileSync(path, JSON.stringify(state, null, 2));
}

function _load_iteration_state(
	artifacts_dir: string,
	issue_name: string,
	build_id = "",
): Record<string, unknown> | null {
	const path = _iteration_state_path(artifacts_dir, issue_name, build_id);
	if (!path) return null;
	const { existsSync, readFileSync } =
		require("node:fs") as typeof import("node:fs");
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function _save_artifact(
	artifacts_dir: string,
	iteration_id: string,
	name: string,
	data: Record<string, unknown>,
): string {
	if (!artifacts_dir) return "";
	const { mkdirSync, writeFileSync } =
		require("node:fs") as typeof import("node:fs");
	const artifact_dir = `${artifacts_dir}/coding-loop/${iteration_id}`;
	mkdirSync(artifact_dir, { recursive: true });
	const path = `${artifact_dir}/${name}.json`;
	writeFileSync(path, JSON.stringify(data, null, 2));
	return path;
}

async function _memory_get(
	memory_fn:
		| ((action: string, key: string, value?: unknown) => Promise<unknown>)
		| null
		| undefined,
	key: string,
): Promise<unknown> {
	if (!memory_fn) return null;
	try {
		return await memory_fn("get", key);
	} catch {
		return null;
	}
}

async function _memory_set(
	memory_fn:
		| ((action: string, key: string, value?: unknown) => Promise<unknown>)
		| null
		| undefined,
	key: string,
	value: unknown,
): Promise<void> {
	if (!memory_fn) return;
	try {
		await memory_fn("set", key, value);
	} catch {
		// silently skip
	}
}

async function _read_memory_context(
	memory_fn:
		| ((action: string, key: string, value?: unknown) => Promise<unknown>)
		| null
		| undefined,
	issue: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	if (!memory_fn) return {};

	const context: Record<string, unknown> = {};

	const conventions = await _memory_get(memory_fn, "codebase_conventions");
	if (conventions) context["codebase_conventions"] = conventions;

	const failure_patterns = await _memory_get(memory_fn, "failure_patterns");
	if (failure_patterns) context["failure_patterns"] = failure_patterns;

	const bug_patterns = await _memory_get(memory_fn, "bug_patterns");
	if (bug_patterns) context["bug_patterns"] = bug_patterns;

	const dep_interfaces: Record<string, unknown>[] = [];
	for (const dep_name of (issue.depends_on as string[]) ?? []) {
		const iface = await _memory_get(memory_fn, `interfaces/${dep_name}`);
		if (iface) {
			dep_interfaces.push({
				...(iface as Record<string, unknown>),
				issue: dep_name,
			});
		}
	}
	if (dep_interfaces.length) context["dependency_interfaces"] = dep_interfaces;

	return context;
}

async function _write_memory_on_approve(
	memory_fn:
		| ((action: string, key: string, value?: unknown) => Promise<unknown>)
		| null
		| undefined,
	issue: Record<string, unknown>,
	coder_result: Record<string, unknown>,
	is_first_success: boolean,
	_note_fn?: (msg: string, tags?: string[]) => void,
): Promise<void> {
	if (!memory_fn) return;

	const issue_name = (issue.name as string) ?? "unknown";

	if (is_first_success) {
		const learnings = (coder_result.codebase_learnings as string[]) ?? [];
		if (learnings.length) {
			const conventions: Record<string, string> = {};
			learnings.forEach((learning, i) => {
				conventions[`note_${i}`] = learning;
			});
			await _memory_set(memory_fn, "codebase_conventions", conventions);
		}
	}

	const iface: Record<string, unknown> = {
		module: issue_name,
		exports: (issue.provides as string[]) ?? [],
		files_created: (coder_result.files_changed as string[]) ?? [],
		tests_passing: coder_result.tests_passed as boolean | null,
		summary: (coder_result.summary as string) ?? "",
	};
	await _memory_set(memory_fn, `interfaces/${issue_name}`, iface);

	const retro = coder_result.agent_retro as Record<string, unknown> | undefined;
	if (retro && Object.keys(retro).length > 0) {
		await _memory_set(memory_fn, `retros/${issue_name}`, retro);
	}

	const health = ((await _memory_get(memory_fn, "build_health")) as Record<
		string,
		unknown
	>) ?? {
		modules_passing: [],
		modules_failing: [],
		total_tests_reported: 0,
		known_risks: [],
		issues_completed: 0,
		issues_failed: 0,
		debt_items: [],
	};
	(health.issues_completed as number) =
		((health.issues_completed as number) ?? 0) + 1;
	const passing = (health.modules_passing as string[]) ?? [];
	if (!passing.includes(issue_name)) passing.push(issue_name);
	health.modules_passing = passing;
	await _memory_set(memory_fn, "build_health", health);
}

async function _write_memory_on_failure(
	memory_fn:
		| ((action: string, key: string, value?: unknown) => Promise<unknown>)
		| null
		| undefined,
	issue: Record<string, unknown>,
	feedback_summary: string,
	review_result: Record<string, unknown> | null = null,
	_note_fn?: (msg: string, tags?: string[]) => void,
): Promise<void> {
	if (!memory_fn) return;

	const issue_name = (issue.name as string) ?? "unknown";

	const patterns =
		((await _memory_get(memory_fn, "failure_patterns")) as Record<
			string,
			unknown
		>[]) ?? [];
	patterns.push({
		issue: issue_name,
		pattern: "iteration_failure",
		description: feedback_summary.slice(0, 200),
	});
	await _memory_set(memory_fn, "failure_patterns", patterns.slice(-10));

	if (review_result) {
		const debt_items =
			(review_result.debt_items as Record<string, unknown>[]) ?? [];
		if (debt_items.length) {
			const bug_patterns =
				((await _memory_get(memory_fn, "bug_patterns")) as Record<
					string,
					unknown
				>[]) ?? [];
			for (const d of debt_items) {
				const bug_type = ((d.title as string) ??
					(d.type as string) ??
					"unknown") as string;
				const existing = bug_patterns.find(
					(bp) => (bp.type as string) === bug_type,
				);
				if (existing) {
					(existing.frequency as number) =
						((existing.frequency as number) ?? 1) + 1;
				} else {
					bug_patterns.push({
						type: bug_type,
						frequency: 1,
						modules: [issue_name],
					});
				}
			}
			await _memory_set(memory_fn, "bug_patterns", bug_patterns.slice(-20));
		}
	}

	const health = ((await _memory_get(memory_fn, "build_health")) as Record<
		string,
		unknown
	>) ?? {
		modules_passing: [],
		modules_failing: [],
		total_tests_reported: 0,
		known_risks: [],
		issues_completed: 0,
		issues_failed: 0,
		debt_items: [],
	};
	(health.issues_failed as number) =
		((health.issues_failed as number) ?? 0) + 1;
	const failing = (health.modules_failing as string[]) ?? [];
	if (!failing.includes(issue_name)) failing.push(issue_name);
	health.modules_failing = failing;
	await _memory_set(memory_fn, "build_health", health);
}

function _detect_stuck_loop(
	iteration_history: Record<string, unknown>[],
	window = 3,
): boolean {
	if (iteration_history.length < window) return false;
	const recent = iteration_history.slice(-window);
	return recent.every(
		(entry) => entry.action === "fix" && !entry.review_blocking,
	);
}

async function _run_default_path({
	call_fn,
	node_id,
	worktree_path,
	coder_result,
	issue,
	iteration_id,
	project_context,
	memory_context,
	config,
	timeout,
	issue_name,
	note_fn,
	workspace_manifest,
	target_repo,
}: {
	call_fn: CallFn;
	node_id: string;
	worktree_path: string;
	coder_result: Record<string, unknown>;
	issue: Record<string, unknown>;
	iteration_id: string;
	project_context: Record<string, unknown>;
	memory_context: Record<string, unknown>;
	config: ExecutionConfig;
	timeout: number;
	issue_name: string;
	note_fn?: (msg: string, tags?: string[]) => void;
	workspace_manifest?: Record<string, unknown> | null;
	target_repo?: string;
}): Promise<[string, string, Record<string, unknown> | null]> {
	const permission_mode = config.permission_mode ?? "";

	let review_result: Record<string, unknown> = {
		approved: true,
		blocking: false,
		summary: "",
	};

	try {
		review_result = (await _call_with_timeout(
			call_fn(`${node_id}.run_code_reviewer`, {
				worktree_path,
				coder_result,
				issue,
				iteration_id,
				project_context,
				qa_ran: false,
				memory_context,
				model: config.code_reviewer_model ?? "sonnet",
				permission_mode,
				ai_provider: config.ai_provider ?? "claude",
				workspace_manifest: workspace_manifest ?? null,
				target_repo: target_repo ?? "",
			}),
			timeout,
			`review:${issue_name}:default`,
		)) as Record<string, unknown>;
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (note_fn)
			note_fn(`Reviewer failed: ${issue_name}: ${msg}`, [
				"coding_loop",
				"review_error",
				issue_name,
			]);
		review_result = {
			approved: true,
			blocking: false,
			summary: `Review unavailable: ${msg}`,
		};
	}

	if (note_fn) {
		note_fn(
			`Reviewer: approved=${review_result.approved}, blocking=${review_result.blocking}`,
			["coding_loop", "feedback", issue_name],
		);
	}

	const approved = review_result.approved as boolean;
	const blocking = review_result.blocking as boolean;
	const summary = (review_result.summary as string) ?? "";

	let action: string;
	if (approved && !blocking) {
		action = "approve";
	} else if (blocking) {
		action = "block";
	} else {
		action = "fix";
	}

	return [action, summary, review_result];
}

async function _run_flagged_path({
	call_fn,
	node_id,
	worktree_path,
	coder_result,
	issue,
	iteration,
	iteration_id,
	iteration_history,
	project_context,
	memory_context,
	config,
	timeout,
	issue_name,
	note_fn,
	workspace_manifest,
	target_repo,
}: {
	call_fn: CallFn;
	node_id: string;
	worktree_path: string;
	coder_result: Record<string, unknown>;
	issue: Record<string, unknown>;
	iteration: number;
	iteration_id: string;
	iteration_history: Record<string, unknown>[];
	project_context: Record<string, unknown>;
	memory_context: Record<string, unknown>;
	config: ExecutionConfig;
	timeout: number;
	issue_name: string;
	note_fn?: (msg: string, tags?: string[]) => void;
	workspace_manifest?: Record<string, unknown> | null;
	target_repo?: string;
}): Promise<
	[
		string,
		string,
		Record<string, unknown> | null,
		Record<string, unknown> | null,
		Record<string, unknown> | null,
	]
> {
	const permission_mode = config.permission_mode ?? "";

	let qa_result: Record<string, unknown> = { passed: false, summary: "" };
	let review_result: Record<string, unknown> = {
		approved: true,
		blocking: false,
		summary: "",
	};

	try {
		const qa_coro = _call_with_timeout(
			call_fn(`${node_id}.run_qa`, {
				worktree_path,
				coder_result,
				issue,
				iteration_id,
				project_context,
				model: config.qa_model ?? "sonnet",
				permission_mode,
				ai_provider: config.ai_provider ?? "claude",
				workspace_manifest: workspace_manifest ?? null,
				target_repo: target_repo ?? "",
			}),
			timeout,
			`qa:${issue_name}:iter${iteration}`,
		);

		const review_coro = _call_with_timeout(
			call_fn(`${node_id}.run_code_reviewer`, {
				worktree_path,
				coder_result,
				issue,
				iteration_id,
				project_context,
				qa_ran: true,
				memory_context,
				model: config.code_reviewer_model ?? "sonnet",
				permission_mode,
				ai_provider: config.ai_provider ?? "claude",
				workspace_manifest: workspace_manifest ?? null,
				target_repo: target_repo ?? "",
			}),
			timeout,
			`review:${issue_name}:iter${iteration}`,
		);

		const [qa_res, review_res] = (await Promise.all([
			qa_coro,
			review_coro,
		])) as [Record<string, unknown>, Record<string, unknown>];
		qa_result = qa_res;
		review_result = review_res;
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (note_fn)
			note_fn(`QA+Review both failed: ${issue_name}: ${msg}`, [
				"coding_loop",
				"qa_review_error",
				issue_name,
			]);
		qa_result = { passed: false, summary: `QA unavailable: ${msg}` };
		review_result = {
			approved: true,
			blocking: false,
			summary: "Review unavailable",
		};
	}

	if (note_fn) {
		note_fn(
			`QA: passed=${qa_result.passed}, Review: approved=${review_result.approved}, blocking=${review_result.blocking}`,
			["coding_loop", "feedback", issue_name],
		);
	}

	let synthesis_result: Record<string, unknown> = {};

	try {
		synthesis_result = (await _call_with_timeout(
			call_fn(`${node_id}.run_qa_synthesizer`, {
				qa_result,
				review_result,
				iteration_history,
				iteration_id,
				worktree_path,
				issue_summary: {
					name: issue.name ?? "",
					title: issue.title ?? "",
					acceptance_criteria: (issue.acceptance_criteria as string[]) ?? [],
				},
				artifacts_dir: (project_context.artifacts_dir as string) ?? "",
				model: config.qa_synthesizer_model ?? "sonnet",
				permission_mode,
				ai_provider: config.ai_provider ?? "claude",
				workspace_manifest: workspace_manifest ?? null,
				target_repo: target_repo ?? "",
			}),
			timeout,
			`synthesizer:${issue_name}:iter${iteration}`,
		)) as Record<string, unknown>;
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (note_fn)
			note_fn(`Synthesizer failed: ${issue_name}: ${msg} — using fallback`, [
				"coding_loop",
				"synthesizer_error",
				issue_name,
			]);
		const qa_passed = qa_result.passed as boolean;
		const review_approved = review_result.approved as boolean;
		const review_blocking = review_result.blocking as boolean;
		if (qa_passed && review_approved && !review_blocking) {
			synthesis_result = {
				action: "approve",
				summary: "Auto-approved (synthesizer unavailable)",
			};
		} else if (review_blocking) {
			synthesis_result = {
				action: "block",
				summary: `Blocked by review (synthesizer unavailable): ${review_result.summary}`,
			};
		} else {
			synthesis_result = {
				action: "fix",
				summary: `Auto-fix (synthesizer unavailable): QA=${qa_result.summary}, Review=${review_result.summary}`,
			};
		}
	}

	const action = (synthesis_result.action as string) ?? "fix";
	const summary = (synthesis_result.summary as string) ?? "";

	return [action, summary, review_result, qa_result, synthesis_result];
}

export async function run_coding_loop({
	issue,
	dag_state,
	call_fn,
	node_id = "swe-planner",
	config,
	note_fn,
	memory_fn,
}: {
	issue: Record<string, unknown>;
	dag_state: DAGState;
	call_fn: CallFn;
	node_id?: string;
	config: ExecutionConfig;
	note_fn?: (msg: string, tags?: string[]) => void;
	memory_fn?: (
		action: string,
		key: string,
		value?: unknown,
	) => Promise<unknown>;
}): Promise<IssueResult> {
	const issue_name = (issue.name as string) ?? "unknown";
	const worktree_path =
		(issue.worktree_path as string) ?? dag_state.repo_path ?? "";
	const branch_name = (issue.branch_name as string) ?? "";
	const max_iterations = config.max_coding_iterations ?? 5;
	const timeout = config.agent_timeout_seconds ?? 2700;
	const permission_mode = config.permission_mode ?? "";

	const target_repo = (issue.target_repo as string) ?? "";
	const ws_manifest_dict = dag_state.workspace_manifest as
		| Record<string, unknown>
		| null
		| undefined;

	if (ws_manifest_dict && !issue.worktree_path) {
		if (note_fn) {
			note_fn(
				`WARNING: issue '${issue_name}' has no worktree_path in multi-repo mode. Falling back to primary repo: ${dag_state.repo_path}. target_repo='${target_repo}'`,
				["coding_loop", "warning", "multi_repo_fallback"],
			);
		}
	}

	const guidance = (issue.guidance as Record<string, unknown>) ?? {};
	const needs_deeper_qa = (guidance.needs_deeper_qa as boolean) ?? false;

	const project_context: Record<string, unknown> = {
		prd_path: dag_state.prd_path,
		architecture_path: dag_state.architecture_path,
		artifacts_dir: dag_state.artifacts_dir,
		issues_dir: dag_state.issues_dir,
		repo_path: dag_state.repo_path,
	};

	if (note_fn) {
		const path_label = needs_deeper_qa
			? "FLAGGED (QA+reviewer+synth)"
			: "DEFAULT (reviewer only)";
		note_fn(
			`Coding loop starting: ${issue_name} [${path_label}] (max ${max_iterations} iterations)`,
			["coding_loop", "start", issue_name],
		);
	}

	let feedback = "";
	let iteration_history: Record<string, unknown>[] = [];
	let files_changed: string[] = [];
	let start_iteration = 1;
	let last_review: Record<string, unknown> | null = null;
	const is_first_success = dag_state.completed_issues.length === 0;

	const existing_state = _load_iteration_state(
		dag_state.artifacts_dir ?? "",
		issue_name,
		dag_state.build_id ?? "",
	);
	if (existing_state) {
		start_iteration = ((existing_state.iteration as number) ?? 0) + 1;
		feedback = (existing_state.feedback as string) ?? "";
		files_changed = (existing_state.files_changed as string[]) ?? [];
		iteration_history =
			(existing_state.iteration_history as Record<string, unknown>[]) ?? [];
		if (note_fn) {
			note_fn(`Resuming ${issue_name} from iteration ${start_iteration}`, [
				"coding_loop",
				"resume",
				issue_name,
			]);
		}
	}

	for (
		let iteration = start_iteration;
		iteration <= max_iterations;
		iteration++
	) {
		const iteration_id = `iter${iteration}`;

		if (note_fn) {
			note_fn(
				`Coding loop iteration ${iteration}/${max_iterations}: ${issue_name}`,
				["coding_loop", "iteration", issue_name],
			);
		}

		const memory_context = await _read_memory_context(memory_fn, issue);

		let coder_result: Record<string, unknown> = {};
		try {
			coder_result = (await _call_with_timeout(
				call_fn(`${node_id}.run_coder`, {
					issue,
					worktree_path,
					feedback,
					iteration,
					iteration_id,
					project_context,
					memory_context,
					model: config.coder_model ?? "sonnet",
					permission_mode,
					ai_provider: config.ai_provider ?? "claude",
					workspace_manifest: ws_manifest_dict ?? null,
					target_repo: target_repo ?? "",
				}),
				timeout,
				`coder:${issue_name}:iter${iteration}`,
			)) as Record<string, unknown>;
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (note_fn)
				note_fn(`Coder agent failed: ${issue_name} iter ${iteration}: ${msg}`, [
					"coding_loop",
					"coder_error",
					issue_name,
				]);
			const result: IssueResult = {
				issue_name,
				outcome: ISSUE_OUTCOME.FAILED_UNRECOVERABLE,
				error_message: `Coder agent failed on iteration ${iteration}: ${msg}`,
				error_context: "",
				files_changed,
				branch_name,
				attempts: iteration,
				repo_name: target_repo || "",
				result_summary: "",
				advisor_invocations: 0,
				adaptations: [],
				debt_items: [],
				split_request: null,
				escalation_context: "",
				final_acceptance_criteria: [],
				iteration_history,
			};
			return result;
		}

		for (const f of (coder_result.files_changed as string[]) ?? []) {
			if (!files_changed.includes(f)) files_changed.push(f);
		}

		_save_artifact(
			dag_state.artifacts_dir ?? "",
			iteration_id,
			"coder",
			coder_result,
		);

		let action: string;
		let summary: string;
		let review_result: Record<string, unknown> | null = null;
		let qa_result: Record<string, unknown> | null = null;
		let synthesis_result: Record<string, unknown> | null = null;
		let stuck = false;

		if (needs_deeper_qa) {
			const [act, sum, rr, qr, sr] = await _run_flagged_path({
				call_fn,
				node_id,
				worktree_path,
				coder_result,
				issue,
				iteration,
				iteration_id,
				iteration_history,
				project_context,
				memory_context,
				config,
				timeout,
				issue_name,
				note_fn,
				workspace_manifest: ws_manifest_dict ?? null,
				target_repo: target_repo ?? "",
			});
			action = act;
			summary = sum;
			review_result = rr;
			last_review = rr;
			qa_result = qr;
			synthesis_result = sr;
			stuck = (synthesis_result?.stuck as boolean) ?? false;
			_save_artifact(
				dag_state.artifacts_dir ?? "",
				iteration_id,
				"qa",
				qa_result ?? {},
			);
			_save_artifact(
				dag_state.artifacts_dir ?? "",
				iteration_id,
				"review",
				review_result ?? {},
			);
			_save_artifact(
				dag_state.artifacts_dir ?? "",
				iteration_id,
				"synthesis",
				synthesis_result ?? {},
			);
		} else {
			const [act, sum, rr] = await _run_default_path({
				call_fn,
				node_id,
				worktree_path,
				coder_result,
				issue,
				iteration_id,
				project_context,
				memory_context,
				config,
				timeout,
				issue_name,
				note_fn,
				workspace_manifest: ws_manifest_dict ?? null,
				target_repo: target_repo ?? "",
			});
			action = act;
			summary = sum;
			review_result = rr;
			_save_artifact(
				dag_state.artifacts_dir ?? "",
				iteration_id,
				"review",
				review_result ?? {},
			);
		}

		iteration_history.push({
			iteration,
			action,
			summary,
			qa_passed: qa_result?.passed ?? null,
			review_approved: review_result?.approved ?? false,
			review_blocking: review_result?.blocking ?? false,
			path: needs_deeper_qa ? "flagged" : "default",
		});

		if (note_fn) {
			note_fn(`Decision: ${action} — ${summary.slice(0, 100)}`, [
				"coding_loop",
				"decision",
				issue_name,
			]);
		}

		_save_iteration_state(
			dag_state.artifacts_dir ?? "",
			issue_name,
			{ iteration, feedback: summary, files_changed, iteration_history },
			dag_state.build_id ?? "",
		);

		if (action === "approve") {
			await _write_memory_on_approve(
				memory_fn,
				issue,
				coder_result,
				is_first_success,
				note_fn,
			);
		} else if (action === "fix") {
			await _write_memory_on_failure(
				memory_fn,
				issue,
				summary,
				review_result,
				note_fn,
			);
		}

		if (action === "approve") {
			if (note_fn) {
				note_fn(
					`Coding loop APPROVED: ${issue_name} after ${iteration} iteration(s)`,
					["coding_loop", "complete", issue_name],
				);
			}
			return {
				issue_name,
				outcome: ISSUE_OUTCOME.COMPLETED,
				result_summary: summary,
				files_changed,
				branch_name,
				attempts: iteration,
				iteration_history,
				repo_name: (coder_result.repo_name as string) ?? "",
				error_message: "",
				error_context: "",
				advisor_invocations: 0,
				adaptations: [],
				debt_items: [],
				split_request: null,
				escalation_context: "",
				final_acceptance_criteria: [],
			};
		}

		if (action === "block") {
			if (note_fn) {
				note_fn(`Coding loop BLOCKED: ${issue_name} — ${summary}`, [
					"coding_loop",
					"blocked",
					issue_name,
				]);
			}
			await _write_memory_on_failure(
				memory_fn,
				issue,
				summary,
				review_result,
				note_fn,
			);
			return {
				issue_name,
				outcome: ISSUE_OUTCOME.FAILED_UNRECOVERABLE,
				error_message: summary,
				files_changed,
				branch_name,
				attempts: iteration,
				repo_name: target_repo || "",
				result_summary: "",
				error_context: "",
				advisor_invocations: 0,
				adaptations: [],
				debt_items: [],
				split_request: null,
				escalation_context: "",
				final_acceptance_criteria: [],
				iteration_history,
			};
		}

		// action === "fix"
		const feedback_parts: string[] = [summary];
		if (qa_result) {
			const test_failures =
				(qa_result.test_failures as Record<string, unknown>[]) ?? [];
			if (test_failures.length) {
				feedback_parts.push("\n### Specific Test Failures");
				for (const f of test_failures) {
					feedback_parts.push(
						`- \`${(f.test_name as string) ?? "?"}\` in \`${(f.file as string) ?? "?"}\`: ${(f.error as string) ?? ""}`,
					);
				}
			}
		}
		if (review_result) {
			const debt =
				(review_result.debt_items as Record<string, unknown>[]) ?? [];
			const blocking_debt = debt.filter((d) => d.severity === "blocking");
			if (blocking_debt.length) {
				feedback_parts.push("\n### Blocking Review Issues");
				for (const d of blocking_debt) {
					feedback_parts.push(
						`- [${d.severity as string}] ${(d.title as string) ?? "?"}: ${(d.description as string) ?? ""}`,
					);
				}
			}
		}
		feedback = feedback_parts.join("\n");

		// Stuck detection
		if (!stuck && !needs_deeper_qa) {
			stuck = _detect_stuck_loop(iteration_history);
		}

		if (stuck) {
			const last_blocking = (review_result?.blocking as boolean) ?? false;
			if (!last_blocking && files_changed.length > 0) {
				if (note_fn) {
					note_fn(
						`Coding loop STUCK (non-blocking): ${issue_name} — accepting with debt after ${iteration} iterations`,
						["coding_loop", "stuck", "accept_debt", issue_name],
					);
				}
				return {
					issue_name,
					outcome: ISSUE_OUTCOME.COMPLETED_WITH_DEBT,
					result_summary: `Accepted with debt (stuck loop, non-blocking): ${summary}`,
					files_changed,
					branch_name,
					attempts: iteration,
					repo_name: target_repo || "",
					error_message: "",
					error_context: "",
					advisor_invocations: 0,
					adaptations: [],
					debt_items: [],
					split_request: null,
					escalation_context: "",
					final_acceptance_criteria: [],
					iteration_history,
				};
			} else {
				if (note_fn) {
					note_fn(
						`Coding loop STUCK: ${issue_name} — breaking after ${iteration} iterations`,
						["coding_loop", "stuck", issue_name],
					);
				}
				await _write_memory_on_failure(
					memory_fn,
					issue,
					summary,
					review_result,
					note_fn,
				);
				return {
					issue_name,
					outcome: ISSUE_OUTCOME.FAILED_UNRECOVERABLE,
					error_message: `Stuck loop detected: ${summary}`,
					files_changed,
					branch_name,
					attempts: iteration,
					repo_name: target_repo || "",
					result_summary: "",
					error_context: "",
					advisor_invocations: 0,
					adaptations: [],
					debt_items: [],
					split_request: null,
					escalation_context: "",
					final_acceptance_criteria: [],
					iteration_history,
				};
			}
		}
	}

	// Loop exhausted
	const last_blocking = (last_review?.blocking as boolean) ?? false;

	if (!last_blocking && files_changed.length > 0) {
		if (note_fn) {
			note_fn(
				`Coding loop exhausted (non-blocking): ${issue_name} — accepting with debt after ${max_iterations} iterations`,
				["coding_loop", "exhausted", "accept_debt", issue_name],
			);
		}
		return {
			issue_name,
			outcome: ISSUE_OUTCOME.COMPLETED_WITH_DEBT,
			result_summary: `Accepted with debt after ${max_iterations} iterations (reviewer non-blocking, code changes present)`,
			files_changed,
			branch_name,
			attempts: max_iterations,
			repo_name: target_repo || "",
			error_message: "",
			error_context: "",
			advisor_invocations: 0,
			adaptations: [],
			debt_items: [],
			split_request: null,
			escalation_context: "",
			final_acceptance_criteria: [],
			iteration_history,
		};
	}

	if (note_fn) {
		note_fn(
			`Coding loop exhausted: ${issue_name} after ${max_iterations} iterations`,
			["coding_loop", "exhausted", issue_name],
		);
	}

	await _write_memory_on_failure(
		memory_fn,
		issue,
		"Loop exhausted",
		last_review,
		note_fn,
	);

	return {
		issue_name,
		outcome: ISSUE_OUTCOME.FAILED_UNRECOVERABLE,
		error_message: `Coding loop exhausted after ${max_iterations} iterations without approval`,
		files_changed,
		branch_name,
		attempts: max_iterations,
		repo_name: target_repo || "",
		result_summary: "",
		error_context: "",
		advisor_invocations: 0,
		adaptations: [],
		debt_items: [],
		split_request: null,
		escalation_context: "",
		final_acceptance_criteria: [],
		iteration_history,
	};
}
