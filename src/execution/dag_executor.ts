import type {
	DAGState,
	IssueResult,
	LevelResult,
	ReplanDecision,
	IssueOutcome,
	AdvisorAction,
	ReplanAction,
} from "./schemas.js";
import { ISSUE_OUTCOME, REPLAN_ACTION, ADVISOR_ACTION } from "./schemas.js";
import type { ExecutionConfig } from "./ExecutionConfig.js";
import { FatalHarnessError, is_fatal_error } from "./fatal_error.js";
import { unwrap_call_result } from "./envelope.js";
import { recompute_levels, find_downstream } from "./dag_utils.js";
import { SplitIssueSpecSchema } from "./schemas.js";

type CallFn = (
	target: string,
	kwargs?: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

function _call_with_timeout<T>(
	coro: Promise<T>,
	timeout = 2700000,
	label = "",
): Promise<T> {
	return Promise.race([
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
}

function _enrich_issues_from_setup(
	issues: Record<string, unknown>[],
	setup: Record<string, unknown>,
	integration_branch: string,
): Record<string, unknown>[] {
	const workspaces = (setup.workspaces as Record<string, unknown>[]) ?? [];
	const worktree_map: Record<string, Record<string, unknown>> = {};
	for (const w of workspaces) {
		const raw_name = w.issue_name as string;
		worktree_map[raw_name] = w;
		const stripped = raw_name.replace(/^\d{2}-/, "");
		if (stripped !== raw_name) {
			worktree_map[stripped] = w;
		}
	}

	return issues.map((issue) => {
		const ws = worktree_map[issue.name as string];
		if (ws) {
			return {
				...issue,
				worktree_path: ws.worktree_path,
				branch_name: ws.branch_name,
				integration_branch,
			};
		}
		return issue;
	});
}

async function _init_dag_state(
	plan_result: Record<string, unknown>,
	repo_path: string,
	git_config?: Record<string, unknown>,
	build_id = "",
): Promise<DAGState> {
	const artifacts_dir = (plan_result.artifacts_dir as string) ?? "";

	const prd_path = artifacts_dir ? `${artifacts_dir}/plan/prd.md` : "";
	const architecture_path = artifacts_dir
		? `${artifacts_dir}/plan/architecture.md`
		: "";
	const issues_dir = artifacts_dir ? `${artifacts_dir}/plan/issues` : "";

	const prd = (plan_result.prd as Record<string, unknown>) ?? {};
	const prd_summary_parts: string[] = [
		(prd.validated_description as string) ?? "",
	];
	const ac = (prd.acceptance_criteria as string[]) ?? [];
	if (ac.length > 0) {
		prd_summary_parts.push("\nAcceptance Criteria:");
		ac.forEach((c) => prd_summary_parts.push(`- ${c}`));
	}
	const prd_summary = prd_summary_parts.join("\n");

	const architecture =
		(plan_result.architecture as Record<string, unknown>) ?? {};
	const architecture_summary = (architecture.summary as string) ?? "";

	let issues = plan_result.issues as Record<string, unknown>[];
	if (!Array.isArray(issues)) issues = [];
	const all_issues = issues.map((i) =>
		typeof i === "object" && i !== null ? i : {},
	);

	const levels = (plan_result.levels as string[][]) ?? [];

	const git_kwargs: Partial<DAGState> = {};
	if (git_config) {
		git_kwargs.git_integration_branch =
			(git_config.integration_branch as string) ?? "";
		git_kwargs.git_original_branch =
			(git_config.original_branch as string) ?? "";
		git_kwargs.git_initial_commit =
			(git_config.initial_commit_sha as string) ?? "";
		git_kwargs.git_mode = (git_config.mode as string) ?? "";
		git_kwargs.worktrees_dir = `${repo_path}/.worktrees`;
	}

	return {
		repo_path,
		artifacts_dir,
		prd_path,
		architecture_path,
		issues_dir,
		original_plan_summary: (plan_result.rationale as string) ?? "",
		prd_summary,
		architecture_summary,
		all_issues,
		levels,
		build_id,
		...git_kwargs,
	} as DAGState;
}

function _checkpoint_path(artifacts_dir: string): string {
	return artifacts_dir ? `${artifacts_dir}/execution/checkpoint.json` : "";
}

function _save_checkpoint(
	dag_state: DAGState,
	note_fn?: (msg: string, tags?: string[]) => void,
): void {
	const path = _checkpoint_path(dag_state.artifacts_dir ?? "");
	if (!path) return;
	const { mkdirSync, writeFileSync } =
		require("node:fs") as typeof import("node:fs");
	const dir = path.substring(0, path.lastIndexOf("/"));
	mkdirSync(dir, { recursive: true });
	writeFileSync(path, JSON.stringify(dag_state, null, 2));
	if (note_fn)
		note_fn(`Checkpoint saved: level=${dag_state.current_level}`, [
			"execution",
			"checkpoint",
		]);
}

function _load_checkpoint(artifacts_dir: string): DAGState | null {
	const path = _checkpoint_path(artifacts_dir);
	if (!path) return null;
	const { existsSync, readFileSync } =
		require("node:fs") as typeof import("node:fs");
	if (!existsSync(path)) return null;
	try {
		const data = JSON.parse(readFileSync(path, "utf-8")) as DAGState;
		return data;
	} catch {
		return null;
	}
}

async function _setup_worktrees(
	dag_state: DAGState,
	active_issues: Record<string, unknown>[],
	call_fn: CallFn,
	node_id: string,
	config: ExecutionConfig,
	note_fn?: (msg: string, tags?: string[]) => void,
	build_id = "",
): Promise<Record<string, unknown>[]> {
	if (note_fn) {
		const names = active_issues.map((i) => (i.name as string) ?? "?");
		note_fn(`Setting up worktrees for ${names.join(", ")}`, [
			"execution",
			"worktree_setup",
			"start",
		]);
	}

	if (!dag_state.workspace_manifest) {
		const setup = (await call_fn(`${node_id}.run_workspace_setup`, {
			repo_path: dag_state.repo_path,
			integration_branch: dag_state.git_integration_branch ?? "",
			issues: active_issues,
			worktrees_dir: dag_state.worktrees_dir ?? "",
			artifacts_dir: dag_state.artifacts_dir ?? "",
			level: dag_state.current_level,
			model: config.git_model ?? "sonnet",
			ai_provider: config.ai_provider ?? "claude",
			build_id,
		})) as Record<string, unknown>;

		if (!setup.success) {
			if (note_fn)
				note_fn("Worktree setup failed — issues will run without isolation", [
					"execution",
					"worktree_setup",
					"error",
				]);
			return active_issues;
		}

		return _enrich_issues_from_setup(
			active_issues,
			setup,
			dag_state.git_integration_branch ?? "",
		);
	}

	// Multi-repo path
	const manifest = dag_state.workspace_manifest as {
		primary_repo_name: string;
		repos: {
			repo_name: string;
			absolute_path: string;
			git_init_result?: Record<string, unknown>;
		}[];
	};
	const by_repo: Record<string, Record<string, unknown>[]> = {};
	for (const issue of active_issues) {
		const repo = (issue.target_repo as string) || manifest.primary_repo_name;
		if (!by_repo[repo]) by_repo[repo] = [];
		by_repo[repo].push(issue);
	}

	if (note_fn) {
		note_fn(
			`Multi-repo worktree setup: dispatching to ${Object.keys(by_repo).join(", ")}`,
			["execution", "worktree_setup", "multi-repo"],
		);
	}

	const all_enriched: Record<string, unknown>[] = [];

	for (const [repo_name, repo_issues] of Object.entries(by_repo)) {
		const ws_repo = manifest.repos.find((r) => r.repo_name === repo_name);
		if (!ws_repo) {
			if (note_fn) {
				const names = repo_issues.map((i) => (i!.name as string) ?? "?");
				note_fn(
					`WARNING: target_repo '${repo_name}' not found in workspace manifest. Issues ${names.join(", ")} will run without worktree isolation.`,
					["execution", "worktree_setup", "warning"],
				);
			}
			all_enriched.push(...repo_issues);
			continue;
		}
		const git_init = ws_repo.git_init_result;
		const integration_branch =
			(git_init?.integration_branch as string | undefined) ?? "";
		if (!integration_branch) {
			if (note_fn) {
				const names = repo_issues.map((i) => (i.name as string) ?? "?");
				note_fn(
					`WARNING: repo '${repo_name}' has no integration branch (git_init incomplete). Issues ${names.join(", ")} will run without worktree isolation.`,
					["execution", "worktree_setup", "warning"],
				);
			}
			all_enriched.push(...repo_issues);
			continue;
		}

		const repo_worktrees_dir = `${ws_repo.absolute_path}/.worktrees`;
		const setup = (await call_fn(`${node_id}.run_workspace_setup`, {
			repo_path: ws_repo.absolute_path,
			integration_branch,
			issues: repo_issues,
			worktrees_dir: repo_worktrees_dir,
			artifacts_dir: dag_state.artifacts_dir ?? "",
			level: dag_state.current_level,
			model: config.git_model ?? "sonnet",
			ai_provider: config.ai_provider ?? "claude",
			build_id,
		})) as Record<string, unknown>;

		if (!setup.success) {
			all_enriched.push(...repo_issues);
			continue;
		}

		all_enriched.push(
			..._enrich_issues_from_setup(
				repo_issues,
				setup as Record<string, unknown>,
				integration_branch,
			),
		);
	}

	if (note_fn) {
		note_fn(`Worktree setup complete: ${all_enriched.length} issues enriched`, [
			"execution",
			"worktree_setup",
			"complete",
		]);
	}

	return all_enriched;
}

async function _merge_level_branches(
	dag_state: DAGState,
	level_result: LevelResult,
	call_fn: CallFn,
	node_id: string,
	config: ExecutionConfig,
	issue_by_name: Record<string, Record<string, unknown>>,
	file_conflicts: Record<string, unknown>[] = [],
	note_fn?: (msg: string, tags?: string[]) => void,
): Promise<Record<string, unknown> | null> {
	if (!dag_state.workspace_manifest) {
		const completed_branches = level_result.completed
			.filter((r) => r.branch_name)
			.map((r) => ({
				branch_name: r.branch_name,
				issue_name: r.issue_name,
				result_summary: r.result_summary,
				files_changed: r.files_changed,
				issue_description:
					(issue_by_name[r.issue_name]?.description as string) ?? "",
			}));

		if (!completed_branches.length) return null;

		if (note_fn) {
			note_fn(
				`Merging ${completed_branches.length} branches: ${completed_branches.map((b) => b.branch_name).join(", ")}`,
				["execution", "merge", "start"],
			);
		}

		const merge_kwargs = {
			repo_path: dag_state.repo_path,
			integration_branch: dag_state.git_integration_branch ?? "",
			branches_to_merge: completed_branches,
			file_conflicts,
			prd_summary: dag_state.prd_summary ?? "",
			architecture_summary: dag_state.architecture_summary ?? "",
			artifacts_dir: dag_state.artifacts_dir ?? "",
			level: level_result.level_index,
			model: config.merger_model ?? "sonnet",
			ai_provider: config.ai_provider ?? "claude",
		};

		let merge_result = (await call_fn(
			`${node_id}.run_merger`,
			merge_kwargs,
		)) as Record<string, unknown>;

		if (
			!merge_result.success &&
			(merge_result.failed_branches as string[])?.length
		) {
			if (note_fn)
				note_fn("Merge failed, retrying once...", [
					"execution",
					"merge",
					"retry",
				]);
			merge_result = (await call_fn(
				`${node_id}.run_merger`,
				merge_kwargs,
			)) as Record<string, unknown>;
		}

		dag_state.merge_results.push(merge_result);
		for (const b of (merge_result.merged_branches as string[]) ?? []) {
			if (!dag_state.merged_branches.includes(b))
				dag_state.merged_branches.push(b);
		}
		for (const b of (merge_result.failed_branches as string[]) ?? []) {
			if (!dag_state.unmerged_branches.includes(b))
				dag_state.unmerged_branches.push(b);
		}

		if (note_fn) {
			note_fn(
				`Merge complete: merged=${merge_result.merged_branches}, failed=${merge_result.failed_branches}`,
				["execution", "merge", "complete"],
			);
		}

		return merge_result;
	}

	// Multi-repo path
	const manifest = dag_state.workspace_manifest as {
		primary_repo_name: string;
		repos: {
			repo_name: string;
			absolute_path: string;
			git_init_result?: Record<string, unknown>;
		}[];
	};

	const by_repo: Record<string, typeof level_result.completed> = {};
	for (const r of level_result.completed) {
		if (r.branch_name) {
			const repo = r.repo_name || manifest.primary_repo_name;
			if (!by_repo[repo]) by_repo[repo] = [];
			by_repo[repo].push(r);
		}
	}

	if (!Object.keys(by_repo).length) return null;

	if (note_fn) {
		note_fn(
			`Multi-repo merge: dispatching to ${Object.keys(by_repo).join(", ")}`,
			["execution", "merge", "start"],
		);
	}

	async function call_merger_for_repo(
		repo_name: string,
		issue_results: typeof level_result.completed,
	): Promise<Record<string, unknown>> {
		const ws_repo = manifest.repos.find((r) => r.repo_name === repo_name);
		if (!ws_repo || !ws_repo.git_init_result) {
			return { success: false, merged_branches: [], failed_branches: [] };
		}
		const integration_branch =
			(ws_repo.git_init_result?.integration_branch as string | undefined) ?? "";
		if (!integration_branch)
			return { success: false, merged_branches: [], failed_branches: [] };

		const branches_to_merge = issue_results.map((r) => ({
			branch_name: r.branch_name,
			issue_name: r.issue_name,
			result_summary: r.result_summary,
			files_changed: r.files_changed,
			issue_description:
				(issue_by_name[r.issue_name]?.description as string) ?? "",
		}));

		return (await call_fn(`${node_id}.run_merger`, {
			repo_path: ws_repo.absolute_path,
			integration_branch,
			branches_to_merge,
			file_conflicts,
			prd_summary: dag_state.prd_summary ?? "",
			architecture_summary: dag_state.architecture_summary ?? "",
			artifacts_dir: dag_state.artifacts_dir ?? "",
			level: level_result.level_index,
			model: config.merger_model ?? "sonnet",
			ai_provider: config.ai_provider ?? "claude",
		})) as Record<string, unknown>;
	}

	const tasks = Object.entries(by_repo).map(([repo_name, issues]) =>
		call_merger_for_repo(repo_name, issues),
	);
	const results = await Promise.all(tasks);
	let last_good: Record<string, unknown> | null = null;

	for (const result of results) {
		dag_state.merge_results.push(result);
		for (const b of (result.merged_branches as string[]) ?? []) {
			if (!dag_state.merged_branches.includes(b))
				dag_state.merged_branches.push(b);
		}
		for (const b of (result.failed_branches as string[]) ?? []) {
			if (!dag_state.unmerged_branches.includes(b))
				dag_state.unmerged_branches.push(b);
		}
		if (result.success) last_good = result;
	}

	if (note_fn) {
		note_fn(`Multi-repo merge complete: merged=${dag_state.merged_branches}`, [
			"execution",
			"merge",
			"complete",
		]);
	}

	return last_good;
}

async function _run_integration_tests(
	dag_state: DAGState,
	merge_result: Record<string, unknown>,
	level_result: LevelResult,
	call_fn: CallFn,
	node_id: string,
	config: ExecutionConfig,
	issue_by_name: Record<string, Record<string, unknown>>,
	note_fn?: (msg: string, tags?: string[]) => void,
): Promise<Record<string, unknown> | null> {
	if (!merge_result.needs_integration_test) return null;
	if (!config.enable_integration_testing) return null;

	const merged_branches = level_result.completed
		.filter(
			(r) =>
				r.branch_name &&
				(merge_result.merged_branches as string[])?.includes(r.branch_name),
		)
		.map((r) => ({
			branch_name: r.branch_name,
			issue_name: r.issue_name,
			result_summary: r.result_summary,
			files_changed: r.files_changed,
			repo_name: r.repo_name || "",
		}));

	if (note_fn) {
		const repos_touched = new Set(
			merged_branches.map((b) => b.repo_name).filter(Boolean),
		);
		const label = repos_touched.size
			? ` (repos: ${Array.from(repos_touched).join(", ")})`
			: "";
		note_fn(`Running integration tests${label}`, [
			"execution",
			"integration_test",
			"start",
		]);
	}

	let integration_test_repo_path = dag_state.repo_path ?? "";
	if (dag_state.workspace_manifest) {
		const repos_with_merges = new Set(
			merged_branches.map((b) => b.repo_name).filter(Boolean),
		);
		if (repos_with_merges.size === 1) {
			const repo_name = Array.from(repos_with_merges)[0];
			const manifest = dag_state.workspace_manifest as {
				repos: { repo_name: string; absolute_path: string }[];
			};
			const ws_repo = manifest.repos.find((r) => r.repo_name === repo_name);
			if (ws_repo?.absolute_path)
				integration_test_repo_path = ws_repo.absolute_path;
		}
	}

	let test_result: Record<string, unknown> | null = null;
	for (
		let attempt = 0;
		attempt <= config.max_integration_test_retries;
		attempt++
	) {
		test_result = (await call_fn(`${node_id}.run_integration_tester`, {
			repo_path: integration_test_repo_path,
			integration_branch: dag_state.git_integration_branch ?? "",
			merged_branches,
			prd_summary: dag_state.prd_summary ?? "",
			architecture_summary: dag_state.architecture_summary ?? "",
			conflict_resolutions:
				(merge_result.conflict_resolutions as Record<string, unknown>[]) ?? [],
			artifacts_dir: dag_state.artifacts_dir ?? "",
			level: level_result.level_index,
			model: config.integration_tester_model ?? "sonnet",
			ai_provider: config.ai_provider ?? "claude",
			workspace_manifest: dag_state.workspace_manifest,
		})) as Record<string, unknown>;

		if (test_result.passed) break;
		if (note_fn && attempt < config.max_integration_test_retries) {
			note_fn(`Integration test failed (attempt ${attempt + 1}), retrying...`, [
				"execution",
				"integration_test",
				"retry",
			]);
		}
	}

	if (test_result) {
		dag_state.integration_test_results.push(test_result);
		if (note_fn) {
			note_fn(
				`Integration test ${test_result.passed ? "passed" : "failed"}: ${test_result.summary ?? ""}`,
				["execution", "integration_test", "complete"],
			);
		}
	}

	return test_result;
}

async function _cleanup_worktrees(
	dag_state: DAGState,
	branches_to_clean: string[],
	call_fn: CallFn,
	node_id: string,
	note_fn?: (msg: string, tags?: string[]) => void,
	level = 0,
	model = "sonnet",
	ai_provider = "claude",
	completed_results?: IssueResult[],
): Promise<void> {
	if (!branches_to_clean.length) return;

	if (note_fn) {
		note_fn(`Cleaning up ${branches_to_clean.length} worktrees`, [
			"execution",
			"worktree_cleanup",
			"start",
		]);
	}

	if (dag_state.workspace_manifest && completed_results) {
		const manifest = dag_state.workspace_manifest as {
			primary_repo_name: string;
			repos: { repo_name: string; absolute_path: string }[];
		};
		const by_repo: Record<string, string[]> = {};
		for (const r of completed_results) {
			const repo = r.repo_name || manifest.primary_repo_name;
			if (r.branch_name && branches_to_clean.includes(r.branch_name)) {
				if (!by_repo[repo]) by_repo[repo] = [];
				by_repo[repo].push(r.branch_name);
			}
		}

		for (const [repo_name, repo_branches] of Object.entries(by_repo)) {
			const ws_repo = manifest.repos.find((r) => r.repo_name === repo_name);
			if (!ws_repo) continue;
			const repo_worktrees_dir = `${ws_repo.absolute_path}/.worktrees`;
			await _cleanup_single_repo(
				call_fn,
				node_id,
				ws_repo.absolute_path,
				repo_worktrees_dir,
				repo_branches,
				dag_state.artifacts_dir ?? "",
				level,
				model,
				ai_provider,
				note_fn,
			);
		}
		return;
	}

	await _cleanup_single_repo(
		call_fn,
		node_id,
		dag_state.repo_path ?? "",
		dag_state.worktrees_dir ?? "",
		branches_to_clean,
		dag_state.artifacts_dir ?? "",
		level,
		model,
		ai_provider,
		note_fn,
	);
}

async function _cleanup_single_repo(
	call_fn: CallFn,
	node_id: string,
	repo_path: string,
	worktrees_dir: string,
	branches_to_clean: string[],
	artifacts_dir: string,
	level: number,
	model: string,
	ai_provider: string,
	note_fn?: (msg: string, tags?: string[]) => void,
): Promise<void> {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const result = (await call_fn(`${node_id}.run_workspace_cleanup`, {
				repo_path,
				worktrees_dir,
				branches_to_clean,
				artifacts_dir,
				level,
				model,
				ai_provider,
			})) as Record<string, unknown>;

			if (result.success) {
				if (note_fn)
					note_fn(
						`Worktree cleanup complete: ${(result.cleaned as string[])?.join(", ")}`,
						["execution", "worktree_cleanup", "complete"],
					);
				return;
			}
			if (note_fn) {
				note_fn(
					`Worktree cleanup returned success=false (attempt ${attempt + 1}/2), cleaned=${result.cleaned}`,
					["execution", "worktree_cleanup", "warning"],
				);
			}
		} catch (e) {
			if (note_fn) {
				note_fn(`Worktree cleanup error (attempt ${attempt + 1}/2): ${e}`, [
					"execution",
					"worktree_cleanup",
					"error",
				]);
			}
		}
	}

	if (note_fn) {
		note_fn(
			`Worktree cleanup failed after retries for: ${branches_to_clean.join(", ")}`,
			["execution", "worktree_cleanup", "error"],
		);
	}
}

async function _init_all_repos(
	dag_state: DAGState,
	call_fn: CallFn,
	node_id: string,
	git_model: string,
	ai_provider: string,
	permission_mode = "",
	build_id = "",
	note_fn?: (msg: string, tags?: string[]) => void,
): Promise<void> {
	if (!dag_state.workspace_manifest) return;

	const manifest = dag_state.workspace_manifest as {
		repos: { repo_name: string; absolute_path: string }[];
	};

	if (note_fn) {
		note_fn(
			`Initialising git for ${manifest.repos.length} repos: ${manifest.repos.map((r) => r.repo_name).join(", ")}`,
			["execution", "init_all_repos", "start"],
		);
	}

	async function init_one(
		ws_repo: (typeof manifest.repos)[0],
	): Promise<[string, Record<string, unknown>]> {
		const result = (await call_fn(`${node_id}.run_git_init`, {
			repo_path: ws_repo.absolute_path,
			goal: "",
			artifacts_dir: dag_state.artifacts_dir ?? "",
			model: git_model,
			permission_mode,
			ai_provider,
			build_id,
		})) as Record<string, unknown>;
		return [ws_repo.repo_name, result];
	}

	const tasks = manifest.repos.map(init_one);
	const results = await Promise.all(tasks);

	const repo_map: Record<string, (typeof manifest.repos)[0]> = {};
	manifest.repos.forEach((r) => {
		repo_map[r.repo_name] = r;
	});

	for (const item of results) {
		if (Array.isArray(item) && item[1] && typeof item[1] === "object") {
			const [name, git_init_dict] = item as [string, Record<string, unknown>];
			if (name in repo_map) {
				(repo_map[name] as Record<string, unknown>).git_init_result =
					git_init_dict;
			}
		}
	}

	dag_state.workspace_manifest = manifest as unknown as Record<string, unknown>;

	if (note_fn) {
		note_fn("git init complete for all repos", [
			"execution",
			"init_all_repos",
			"complete",
		]);
	}
}

export class DAGExecutor {
	private node_id: string;

	constructor(node_id = "swe-planner") {
		this.node_id = node_id;
	}

	async run(params: {
		plan_result: Record<string, unknown>;
		repo_path: string;
		execute_fn?: (
			issue: Record<string, unknown>,
			dag_state: DAGState,
		) => Promise<IssueResult>;
		config?: Partial<ExecutionConfig>;
		note_fn?: (msg: string, tags?: string[]) => void;
		call_fn?: CallFn;
		git_config?: Record<string, unknown>;
		resume?: boolean;
		build_id?: string;
		workspace_manifest?: Record<string, unknown> | null;
	}): Promise<DAGState> {
		const {
			plan_result,
			repo_path,
			execute_fn,
			config: config_overrides,
			note_fn,
			call_fn,
			git_config,
			resume = false,
			build_id = "",
			workspace_manifest,
		} = params;

		const default_config: ExecutionConfig = {
			git_model: "sonnet",
			ai_provider: "claude",
			coder_model: "sonnet",
			code_reviewer_model: "sonnet",
			qa_model: "sonnet",
			qa_synthesizer_model: "sonnet",
			replan_model: "sonnet",
			merger_model: "sonnet",
			integration_tester_model: "sonnet",
			git_init_max_retries: 3,
			git_init_retry_delay: 1.0,
			max_retries_per_issue: 2,
			max_replans: 2,
			enable_replanning: true,
			max_integration_test_retries: 1,
			enable_integration_testing: true,
			max_coding_iterations: 5,
			agent_timeout_seconds: 2700,
			max_advisor_invocations: 2,
			enable_issue_advisor: true,
			permission_mode: "",
			enable_learning: false,
			max_concurrent_issues: 0,
			level_failure_abort_threshold: 0.8,
			issue_writer_model: "sonnet",
			retry_advisor_model: "sonnet",
			issue_advisor_model: "sonnet",
		};
		const config: ExecutionConfig = { ...default_config, ...config_overrides };

		let raw_call_fn: CallFn | undefined;
		if (call_fn) {
			raw_call_fn = call_fn;
		}

		let dag_state = await _init_dag_state(
			plan_result,
			repo_path,
			git_config,
			build_id,
		);
		dag_state.workspace_manifest = workspace_manifest ?? null;
		dag_state.max_replans = config.max_replans;

		if (resume && dag_state.artifacts_dir) {
			const loaded = _load_checkpoint(dag_state.artifacts_dir);
			if (loaded) dag_state = loaded;
		}

		if (note_fn) {
			note_fn(
				`DAG execution ${resume ? "resuming" : "starting"}: ${dag_state.all_issues.length} issues, ${dag_state.levels.length} levels`,
				["execution", "start"],
			);
		}

		_save_checkpoint(dag_state, note_fn);

		// Per-repo git init for multi-repo builds
		if (workspace_manifest && raw_call_fn) {
			await _init_all_repos(
				dag_state,
				raw_call_fn,
				this.node_id,
				config.git_model ?? "sonnet",
				config.ai_provider ?? "claude",
				config.permission_mode ?? "",
				build_id,
				note_fn,
			);
		}

		const shared_memory: Record<string, unknown> = {};

		async function memory_fn(
			action: string,
			key: string,
			value?: unknown,
		): Promise<unknown> {
			if (action === "get") return shared_memory[key];
			if (action === "set") shared_memory[key] = value;
			return undefined;
		}

		const use_memory =
			raw_call_fn && config.enable_learning ? memory_fn : undefined;

		let issue_by_name: Record<string, Record<string, unknown>> = {};
		for (const i of dag_state.all_issues) issue_by_name[i.name as string] = i;

		while (dag_state.current_level < dag_state.levels.length) {
			const level_names = dag_state.levels[dag_state.current_level];

			const completed_names = new Set(
				dag_state.completed_issues.map((r) => r.issue_name),
			);
			const failed_names = new Set(
				dag_state.failed_issues.map((r) => r.issue_name),
			);
			const done_names = new Set([
				...completed_names,
				...failed_names,
				...dag_state.skipped_issues,
			]);

			const active_issues = (level_names ?? [])
				.filter((name) => issue_by_name[name] && !done_names.has(name))
				.map((name) => issue_by_name[name]!);

			if (!active_issues.length) {
				dag_state.current_level++;
				continue;
			}

			if (note_fn) {
				note_fn(
					`Executing level ${dag_state.current_level}: ${active_issues.map((i) => i!.name as string).join(", ")}`,
					["execution", "level", "start"],
				);
			}

			// Worktree setup
			if (raw_call_fn && dag_state.git_integration_branch) {
				const enriched = await _setup_worktrees(
					dag_state,
					active_issues as Record<string, unknown>[],
					raw_call_fn,
					this.node_id,
					config,
					note_fn,
					dag_state.build_id ?? "",
				);

				// Persist enriched data back
				const enriched_by_name: Record<string, Record<string, unknown>> = {};
				enriched.forEach((e) => {
					enriched_by_name[e.name as string] = e;
				});
				for (let i = 0; i < dag_state.all_issues.length; i++) {
					const enriched_issue =
						enriched_by_name[dag_state.all_issues[i]!.name as string];
					if (enriched_issue && enriched_issue.worktree_path) {
						dag_state.all_issues[i] = enriched_issue;
					}
				}
			}

			dag_state.in_flight_issues = active_issues.map((i) => i.name as string);
			_save_checkpoint(dag_state, note_fn);

			// Execute level
			const level_result = await this._execute_level(
				active_issues,
				execute_fn,
				dag_state,
				config,
				dag_state.current_level,
				raw_call_fn,
				note_fn,
				use_memory,
			);

			dag_state.in_flight_issues = [];

			// Checkpoint
			_save_checkpoint(dag_state, note_fn);

			// Record results
			dag_state.completed_issues.push(...level_result.completed);
			dag_state.failed_issues.push(...level_result.failed);
			for (const skipped of level_result.skipped) {
				if (!dag_state.skipped_issues.includes(skipped.issue_name)) {
					dag_state.skipped_issues.push(skipped.issue_name);
				}
			}

			if (note_fn) {
				note_fn(
					`Level ${dag_state.current_level} complete: completed=${level_result.completed.map((r) => r.issue_name)}, failed=${level_result.failed.map((r) => r.issue_name)}`,
					["execution", "level", "complete"],
				);
			}

			// Level failure abort check
			const total_in_level =
				level_result.completed.length +
				level_result.failed.length +
				level_result.skipped.length;
			if (total_in_level > 0 && config.level_failure_abort_threshold > 0) {
				const failure_ratio = level_result.failed.length / total_in_level;
				if (
					failure_ratio >= config.level_failure_abort_threshold &&
					level_result.failed.length > 1
				) {
					if (note_fn) {
						note_fn(
							`Level ${dag_state.current_level} failure ratio ${(failure_ratio * 100).toFixed(0)}% >= threshold ${(config.level_failure_abort_threshold * 100).toFixed(0)}% — aborting DAG`,
							["execution", "abort", "level_failure_threshold"],
						);
					}
					for (const future_level of dag_state.levels.slice(
						dag_state.current_level + 1,
					)) {
						for (const name of future_level) {
							if (!dag_state.skipped_issues.includes(name)) {
								dag_state.skipped_issues.push(name);
							}
						}
					}
					dag_state.current_level = dag_state.levels.length;
					_save_checkpoint(dag_state, note_fn);
					break;
				}
			}

			// Merge gate
			const file_conflicts =
				(plan_result.file_conflicts as Record<string, unknown>[]) ?? [];
			if (raw_call_fn && dag_state.git_integration_branch) {
				const merge_result = await _merge_level_branches(
					dag_state,
					level_result,
					raw_call_fn,
					this.node_id,
					config,
					issue_by_name,
					file_conflicts,
					note_fn,
				);

				if (merge_result) {
					await _run_integration_tests(
						dag_state,
						merge_result,
						level_result,
						raw_call_fn,
						this.node_id,
						config,
						issue_by_name,
						note_fn,
					);
				}

				const build_id_prefix = dag_state.build_id ?? "";
				const branches_to_clean = active_issues.map((i) => {
					if (i!.branch_name) return i!.branch_name as string;
					const seq = String((i!.sequence_number as number) ?? 0).padStart(
						2,
						"0",
					);
					return build_id_prefix
						? `issue/${build_id_prefix}-${seq}-${i!.name}`
						: `issue/${seq}-${i!.name}`;
				});

				await _cleanup_worktrees(
					dag_state,
					branches_to_clean,
					raw_call_fn,
					this.node_id,
					note_fn,
					dag_state.current_level,
					config.git_model ?? "sonnet",
					config.ai_provider ?? "claude",
					level_result.completed,
				);
			}

			// Debt gate
			const debt_results = level_result.completed.filter(
				(r) => r.outcome === ISSUE_OUTCOME.COMPLETED_WITH_DEBT,
			);
			for (const r of debt_results) {
				for (const debt of r.debt_items ?? []) {
					dag_state.accumulated_debt.push(debt);
				}
				for (const adapt of r.adaptations ?? []) {
					dag_state.adaptation_history.push(
						adapt as unknown as Record<string, unknown>,
					);
				}
				// Enrich downstream with debt notes
				const downstream = find_downstream(r.issue_name, dag_state.all_issues);
				for (let i = 0; i < dag_state.all_issues.length; i++) {
					const iss = dag_state.all_issues[i];
					if (!iss) continue;
					if (downstream.includes(String(iss.name ?? ""))) {
						const notes = [...((iss.debt_notes as string[]) ?? [])];
						const debt_desc =
							r.debt_items
								?.map(
									(d) =>
										((d as Record<string, unknown>).description ??
											(d as Record<string, unknown>).criterion ??
											"") as string,
								)
								.join("; ") ?? "";
						notes.push(
							`NOTE: Upstream '${r.issue_name}' completed with debt: ${debt_desc}`,
						);
						dag_state.all_issues[i] = { ...iss, debt_notes: notes };
					}
				}
			}

			if (note_fn && debt_results.length) {
				note_fn(
					`Debt gate: ${debt_results.length} issues accepted with debt, total debt items: ${dag_state.accumulated_debt.length}`,
					["execution", "debt_gate"],
				);
			}

			// Replan gate
			const unrecoverable = level_result.failed.filter(
				(f) =>
					f.outcome === ISSUE_OUTCOME.FAILED_UNRECOVERABLE ||
					f.outcome === ISSUE_OUTCOME.FAILED_ESCALATED,
			);

			if (
				unrecoverable.length &&
				config.enable_replanning &&
				dag_state.replan_count < config.max_replans
			) {
				const decision = (await raw_call_fn!(`${this.node_id}.run_replanner`, {
					dag_state,
					failed_issues: unrecoverable.map((f) => ({ ...f })),
					replan_model: config.replan_model ?? "sonnet",
					ai_provider: config.ai_provider ?? "claude",
					escalation_notes: unrecoverable
						.filter((f) => f.escalation_context)
						.map((f) => ({
							issue_name: f.issue_name,
							escalation_context: f.escalation_context,
							adaptations: f.adaptations?.map((a) => ({ ...a })),
						})),
				})) as Record<string, unknown>;

				const replan_decision = decision as unknown as ReplanDecision;

				if (replan_decision.action === REPLAN_ACTION.ABORT) {
					dag_state.replan_count++;
					dag_state.replan_history.push(replan_decision);
					if (note_fn)
						note_fn(
							`Replanner decided to ABORT: ${replan_decision.rationale}`,
							["execution", "abort"],
						);
					break;
				}

				if (replan_decision.action === REPLAN_ACTION.CONTINUE) {
					// Enrich downstream with failure notes
					for (const f of unrecoverable) {
						const downstream = find_downstream(
							f.issue_name,
							dag_state.all_issues,
						);
						for (let i = 0; i < dag_state.all_issues.length; i++) {
							const iss = dag_state.all_issues[i];
							if (!iss) continue;
							if (downstream.includes(String(iss.name ?? ""))) {
								const notes = [...((iss.failure_notes as string[]) ?? [])];
								notes.push(
									`WARNING: Upstream issue '${f.issue_name}' failed. Error: ${f.error_message ?? ""}. It was supposed to provide: ${((iss as Record<string, unknown>).depends_on as string[])?.join(", ") ?? ""}. You may need to implement workarounds or stubs for missing functionality.`,
								);
								dag_state.all_issues[i] = { ...iss, failure_notes: notes };
							}
						}
					}
					dag_state.replan_count++;
					dag_state.replan_history.push(replan_decision);
					// Skip downstream
					for (const f of unrecoverable) {
						const downstream = find_downstream(
							f.issue_name,
							dag_state.all_issues,
						);
						for (const name of downstream) {
							if (!dag_state.skipped_issues.includes(name))
								dag_state.skipped_issues.push(name);
						}
					}
				}

				if (
					replan_decision.action === REPLAN_ACTION.MODIFY_DAG ||
					replan_decision.action === REPLAN_ACTION.REDUCE_SCOPE
				) {
					// Apply replan
					const completed_names_set = new Set(
						dag_state.completed_issues.map((r) => r.issue_name),
					);
					const failed_names_set = new Set(
						dag_state.failed_issues.map((r) => r.issue_name),
					);
					const remaining_by_name: Record<string, Record<string, unknown>> = {};
					for (const issue of dag_state.all_issues) {
						const name = String(issue.name ?? "");
						if (!completed_names_set.has(name) && !failed_names_set.has(name)) {
							remaining_by_name[name] = { ...issue };
						}
					}

					// Remove
					for (const name of replan_decision.removed_issue_names) {
						delete remaining_by_name[name];
					}

					// Skip
					for (const name of replan_decision.skipped_issue_names) {
						delete remaining_by_name[name];
						if (!dag_state.skipped_issues.includes(name))
							dag_state.skipped_issues.push(name);
					}

					// Update
					for (const updated of replan_decision.updated_issues) {
						const name = String(updated.name ?? "");
						if (name in remaining_by_name && remaining_by_name[name]) {
							Object.assign(remaining_by_name[name]!, updated);
						}
					}

					// New issues
					let max_seq = 0;
					for (const i of dag_state.all_issues) {
						const seq = (i.sequence_number as number) ?? 0;
						if (seq > max_seq) max_seq = seq;
					}
					for (const new_issue of replan_decision.new_issues) {
						const name = String(new_issue.name ?? "");
						if (name && !(name in remaining_by_name)) {
							const issue_dict = { ...new_issue } as Record<string, unknown>;
							if (!issue_dict.sequence_number) {
								max_seq++;
								issue_dict.sequence_number = max_seq;
							}
							remaining_by_name[name] = issue_dict;
						}
					}

					const remaining = Object.values(remaining_by_name);
					const new_levels = recompute_levels(
						remaining,
						Array.from(completed_names_set),
					);

					dag_state.all_issues = [
						...dag_state.all_issues.filter(
							(i) =>
								completed_names_set.has(String(i.name ?? "")) ||
								failed_names_set.has(String(i.name ?? "")),
						),
						...remaining,
					];
					dag_state.levels = new_levels;
					dag_state.current_level = 0;
					dag_state.replan_count++;
					dag_state.replan_history.push(replan_decision);
					issue_by_name = {};
					for (const i of dag_state.all_issues)
						issue_by_name[i.name as string] = i;
					_save_checkpoint(dag_state, note_fn);
					continue;
				}
			} else if (unrecoverable.length) {
				// Replanning exhausted or disabled — skip downstream
				for (const f of unrecoverable) {
					const downstream = find_downstream(
						f.issue_name,
						dag_state.all_issues,
					);
					for (const name of downstream) {
						if (!dag_state.skipped_issues.includes(name))
							dag_state.skipped_issues.push(name);
					}
				}
				if (note_fn) {
					note_fn(
						`No replanning available — skipping downstream: ${dag_state.skipped_issues.join(", ")}`,
						["execution", "skip"],
					);
				}
			}

			dag_state.current_level++;
		}

		if (note_fn) {
			const total = dag_state.all_issues.length;
			const done = dag_state.completed_issues.length;
			const failed = dag_state.failed_issues.length;
			const skipped = dag_state.skipped_issues.length;
			note_fn(
				`DAG execution complete: ${done}/${total} completed, ${failed} failed, ${skipped} skipped, ${dag_state.replan_count} replans`,
				["execution", "complete"],
			);
		}

		_save_checkpoint(dag_state, note_fn);
		return dag_state;
	}

	private async _execute_single_issue(
		issue: Record<string, unknown>,
		dag_state: DAGState,
		execute_fn:
			| ((
					issue: Record<string, unknown>,
					dag_state: DAGState,
			  ) => Promise<IssueResult>)
			| undefined,
		config: ExecutionConfig,
		raw_call_fn: CallFn | undefined,
		note_fn: ((msg: string, tags?: string[]) => void) | undefined,
		memory_fn:
			| ((action: string, key: string, value?: unknown) => Promise<unknown>)
			| undefined,
	): Promise<IssueResult> {
		const issue_name = String(issue.name ?? "unknown");
		let current_issue = { ...issue };
		const adaptations: unknown[] = [];
		const debt_items: unknown[] = [];
		let last_result: IssueResult | null = null;

		const max_advisor = config.enable_issue_advisor
			? (config.max_advisor_invocations ?? 2)
			: 0;

		const { run_coding_loop } = await import("./coding_loop.js");

		let advisor_round = 0;
		for (; advisor_round <= max_advisor; advisor_round++) {
			let result: IssueResult;

			if (!execute_fn && raw_call_fn) {
				result = await run_coding_loop({
					issue: current_issue,
					dag_state,
					call_fn: raw_call_fn,
					node_id: this.node_id,
					config,
					note_fn,
					memory_fn,
				});
			} else if (execute_fn) {
				try {
					result = await execute_fn(current_issue, dag_state);
				} catch (e) {
					const err_msg = e instanceof Error ? e.message : String(e);
					result = {
						issue_name,
						outcome: ISSUE_OUTCOME.FAILED_UNRECOVERABLE,
						error_message: err_msg,
						error_context: "",
						result_summary: "",
						repo_name: "",
						attempts: 1,
						files_changed: [],
						branch_name: "",
						advisor_invocations: 0,
						adaptations: [],
						debt_items: [],
						split_request: [],
						escalation_context: "",
						final_acceptance_criteria: [],
						iteration_history: [],
					};
				}
			} else {
				throw new Error("No execute_fn or call_fn — cannot execute issue");
			}

			last_result = result;

			if (
				result.outcome === ISSUE_OUTCOME.COMPLETED ||
				result.outcome === ISSUE_OUTCOME.COMPLETED_WITH_DEBT
			) {
				result.adaptations = adaptations as never[];
				result.debt_items = debt_items as never[];
				result.final_acceptance_criteria =
					(current_issue.acceptance_criteria as string[]) ?? [];
				return result;
			}

			if (advisor_round >= max_advisor || !raw_call_fn) break;

			// Invoke Issue Advisor
			if (note_fn) {
				note_fn(
					`Issue Advisor invocation ${advisor_round + 1}/${max_advisor} for ${issue_name}`,
					["issue_advisor", "invoke", issue_name],
				);
			}

			let advisor_decision: Record<string, unknown> = {};
			try {
				advisor_decision = (await _call_with_timeout(
					raw_call_fn(`${this.node_id}.run_issue_advisor`, {
						issue: current_issue,
						original_issue: { ...issue },
						failure_result: { ...result },
						iteration_history:
							(result.iteration_history as Record<string, unknown>[]) ?? [],
						dag_state_summary: {
							completed_issues: dag_state.completed_issues.map((r) => ({
								...(r as Record<string, unknown>),
							})),
							failed_issues: dag_state.failed_issues.map((r) => ({
								...(r as Record<string, unknown>),
							})),
							prd_summary: dag_state.prd_summary ?? "",
							architecture_summary: dag_state.architecture_summary ?? "",
							prd_path: dag_state.prd_path ?? "",
							architecture_path: dag_state.architecture_path ?? "",
							issues_dir: dag_state.issues_dir ?? "",
							artifacts_dir: dag_state.artifacts_dir ?? "",
							repo_path: dag_state.repo_path ?? "",
						},
						advisor_invocation: advisor_round + 1,
						max_advisor_invocations: max_advisor,
						previous_adaptations: adaptations.map((a) => ({
							...(a as Record<string, unknown>),
						})),
						worktree_path:
							(current_issue.worktree_path as string) ??
							dag_state.repo_path ??
							"",
						model: config.issue_advisor_model ?? "sonnet",
						ai_provider: config.ai_provider ?? "claude",
						workspace_manifest: dag_state.workspace_manifest,
					}),
					config.agent_timeout_seconds * 1000,
					`issue_advisor:${issue_name}:${advisor_round + 1}`,
				)) as Record<string, unknown>;
			} catch (e) {
				if (note_fn) {
					note_fn(`Issue Advisor failed for ${issue_name}: ${e}`, [
						"issue_advisor",
						"error",
						issue_name,
					]);
				}
				break;
			}

			const action = (advisor_decision.action as string) ?? "accept_with_debt";

			if (note_fn) {
				note_fn(`Issue Advisor decision for ${issue_name}: ${action}`, [
					"issue_advisor",
					"decision",
					issue_name,
				]);
			}

			if (action === "retry_modified") {
				const adaptation: Record<string, unknown> = {
					adaptation_type: ADVISOR_ACTION.RETRY_MODIFIED,
					original_acceptance_criteria:
						(current_issue.acceptance_criteria as string[]) ?? [],
					modified_acceptance_criteria:
						(advisor_decision.modified_acceptance_criteria as string[]) ?? [],
					dropped_criteria:
						(advisor_decision.dropped_criteria as string[]) ?? [],
					failure_diagnosis:
						(advisor_decision.failure_diagnosis as string) ?? "",
					rationale: (advisor_decision.rationale as string) ?? "",
					downstream_impact:
						(advisor_decision.downstream_impact as string) ?? "",
				};
				adaptations.push(adaptation);

				for (const dropped of (advisor_decision.dropped_criteria as string[]) ??
					[]) {
					debt_items.push({
						type: "dropped_acceptance_criterion",
						criterion: dropped,
						issue_name,
						justification:
							(advisor_decision.modification_justification as string) ?? "",
						severity: "medium",
					});
				}

				current_issue.acceptance_criteria =
					advisor_decision.modified_acceptance_criteria ??
					current_issue.acceptance_criteria;
				continue;
			}

			if (action === "retry_approach") {
				const adaptation: Record<string, unknown> = {
					adaptation_type: ADVISOR_ACTION.RETRY_APPROACH,
					failure_diagnosis:
						(advisor_decision.failure_diagnosis as string) ?? "",
					rationale: (advisor_decision.rationale as string) ?? "",
					new_approach: (advisor_decision.new_approach as string) ?? "",
					downstream_impact:
						(advisor_decision.downstream_impact as string) ?? "",
				};
				adaptations.push(adaptation);

				current_issue = {
					...current_issue,
					retry_context: advisor_decision.new_approach ?? "",
					approach_changes:
						(advisor_decision.approach_changes as string[]) ?? [],
					previous_error: result.error_message,
					retry_diagnosis: advisor_decision.failure_diagnosis,
				};
				continue;
			}

			if (action === "accept_with_debt") {
				const adaptation: Record<string, unknown> = {
					adaptation_type: ADVISOR_ACTION.ACCEPT_WITH_DEBT,
					failure_diagnosis:
						(advisor_decision.failure_diagnosis as string) ?? "",
					rationale: (advisor_decision.rationale as string) ?? "",
					missing_functionality:
						(advisor_decision.missing_functionality as string[]) ?? [],
					severity: (advisor_decision.debt_severity as string) ?? "medium",
					downstream_impact:
						(advisor_decision.downstream_impact as string) ?? "",
				};
				adaptations.push(adaptation);

				for (const missing of (advisor_decision.missing_functionality as string[]) ??
					[]) {
					debt_items.push({
						type: "missing_functionality",
						description: missing,
						issue_name,
						severity: advisor_decision.debt_severity ?? "medium",
					});
				}

				return {
					issue_name,
					outcome: ISSUE_OUTCOME.COMPLETED_WITH_DEBT,
					result_summary:
						(advisor_decision.summary as string) ?? result.result_summary,
					repo_name: result.repo_name,
					error_message: "",
					error_context: "",
					files_changed: result.files_changed ?? [],
					branch_name: result.branch_name ?? "",
					attempts: result.attempts ?? 1,
					advisor_invocations: advisor_round + 1,
					adaptations: adaptations as never[],
					debt_items: debt_items as never[],
					split_request: [],
					escalation_context: "",
					final_acceptance_criteria:
						(current_issue.acceptance_criteria as string[]) ?? [],
					iteration_history:
						(result.iteration_history as Record<string, unknown>[]) ?? [],
				};
			}

			if (action === "escalate_to_replan") {
				return {
					issue_name,
					outcome: ISSUE_OUTCOME.FAILED_ESCALATED,
					result_summary: (advisor_decision.summary as string) ?? "",
					repo_name: result.repo_name,
					error_message:
						(advisor_decision.escalation_reason as string) ??
						result.error_message,
					error_context: result.error_context ?? "",
					files_changed: result.files_changed ?? [],
					branch_name: result.branch_name ?? "",
					attempts: result.attempts ?? 1,
					advisor_invocations: advisor_round + 1,
					adaptations: adaptations as never[],
					debt_items: debt_items as never[],
					split_request: [],
					escalation_context:
						(advisor_decision.suggested_restructuring as string) ?? "",
					final_acceptance_criteria:
						(current_issue.acceptance_criteria as string[]) ?? [],
					iteration_history:
						(result.iteration_history as Record<string, unknown>[]) ?? [],
				};
			}

			if (action === "split") {
				const sub_issues =
					(advisor_decision.sub_issues as Record<string, unknown>[]) ?? [];
				return {
					issue_name,
					outcome: ISSUE_OUTCOME.FAILED_NEEDS_SPLIT,
					result_summary: (advisor_decision.split_rationale as string) ?? "",
					error_message: `Issue advisor recommended splitting into ${sub_issues.length} sub-issues`,
					repo_name: result.repo_name,
					error_context: "",
					files_changed: result.files_changed ?? [],
					branch_name: result.branch_name ?? "",
					attempts: result.attempts ?? 1,
					advisor_invocations: advisor_round + 1,
					adaptations: adaptations as never[],
					debt_items: debt_items as never[],
					split_request: sub_issues as never[],
					escalation_context: "",
					final_acceptance_criteria:
						(current_issue.acceptance_criteria as string[]) ?? [],
					iteration_history:
						(result.iteration_history as Record<string, unknown>[]) ?? [],
				};
			}
		}

		if (last_result) {
			last_result.advisor_invocations = Math.min(
				advisor_round + 1,
				max_advisor,
			);
			last_result.adaptations = adaptations as never[];
			last_result.debt_items = debt_items as never[];
			return last_result;
		}

		return {
			issue_name,
			outcome: ISSUE_OUTCOME.FAILED_UNRECOVERABLE,
			error_message: "No execution attempted",
			error_context: "",
			result_summary: "",
			repo_name: "",
			attempts: 1,
			files_changed: [],
			branch_name: "",
			advisor_invocations: 0,
			adaptations: [],
			debt_items: [],
			split_request: [],
			escalation_context: "",
			final_acceptance_criteria: [],
			iteration_history: [],
		};
	}

	private async _execute_level(
		active_issues: Record<string, unknown>[],
		execute_fn:
			| ((
					issue: Record<string, unknown>,
					dag_state: DAGState,
			  ) => Promise<IssueResult>)
			| undefined,
		dag_state: DAGState,
		config: ExecutionConfig,
		level_index: number,
		raw_call_fn: CallFn | undefined,
		note_fn: ((msg: string, tags?: string[]) => void) | undefined,
		memory_fn:
			| ((action: string, key: string, value?: unknown) => Promise<unknown>)
			| undefined,
	): Promise<LevelResult> {
		const max_concurrent = config.max_concurrent_issues ?? 0;

		let tasks: Promise<IssueResult>[];

		if (max_concurrent > 0 && active_issues.length > max_concurrent) {
			if (note_fn) {
				note_fn(
					`Concurrency limiter: ${active_issues.length} issues, max ${max_concurrent} parallel`,
					["execution", "concurrency_limit"],
				);
			}

			// Sequential batches
			const results: IssueResult[] = [];
			for (let i = 0; i < active_issues.length; i += max_concurrent) {
				const batch = active_issues.slice(i, i + max_concurrent);
				const batch_results = await Promise.all(
					batch.map((issue) =>
						this._execute_single_issue(
							issue,
							dag_state,
							execute_fn,
							config,
							raw_call_fn,
							note_fn,
							memory_fn,
						),
					),
				);
				results.push(...batch_results);
			}
			tasks = Promise.resolve([]) as unknown as Promise<IssueResult>[];
			// Build level result from collected results
			const level_result: LevelResult = {
				level_index,
				completed: [],
				failed: [],
				skipped: [],
			};
			for (const result of results) {
				if (
					result.outcome === ISSUE_OUTCOME.COMPLETED ||
					result.outcome === ISSUE_OUTCOME.COMPLETED_WITH_DEBT
				) {
					level_result.completed.push(result);
				} else if (result.outcome === ISSUE_OUTCOME.SKIPPED) {
					level_result.skipped.push(result);
				} else {
					level_result.failed.push(result);
				}
			}
			return level_result;
		} else {
			tasks = active_issues.map((issue) =>
				this._execute_single_issue(
					issue,
					dag_state,
					execute_fn,
					config,
					raw_call_fn,
					note_fn,
					memory_fn,
				),
			);
		}

		const all_results = await Promise.all(tasks);

		const level_result: LevelResult = {
			level_index,
			completed: [],
			failed: [],
			skipped: [],
		};

		for (let i = 0; i < all_results.length; i++) {
			const result = all_results[i];
			if (!result) continue;
			if (!result.repo_name && active_issues[i]?.target_repo) {
				result.repo_name = active_issues[i]!.target_repo as string;
			}
			if (
				result.outcome === ISSUE_OUTCOME.COMPLETED ||
				result.outcome === ISSUE_OUTCOME.COMPLETED_WITH_DEBT
			) {
				level_result.completed.push(result);
			} else if (result.outcome === ISSUE_OUTCOME.SKIPPED) {
				level_result.skipped.push(result);
			} else {
				level_result.failed.push(result);
			}
		}

		return level_result;
	}
}
