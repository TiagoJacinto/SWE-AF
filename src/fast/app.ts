import "dotenv/config";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { fastPlanTasks } from "./planner.js";
import { fastExecuteTasks } from "./executor.js";
import { fastVerify } from "./verifier.js";
import {
	FastBuildConfigSchema,
	FastBuildResultSchema,
	fastResolveModels,
} from "./schemas.js";

const app = new Hono();

interface BuildInput {
	goal: string;
	repo_path?: string;
	repo_url?: string;
	artifacts_dir?: string;
	additional_context?: string;
	config?: Record<string, unknown>;
}

function repoNameFromUrl(url: string): string {
	const match = url
		.replace(/\.git$/, "")
		.replace(/\/$/, "")
		.match(/\/([^/]+?)$/);
	return (match?.[1] ?? "repo") as string;
}

function runtimeToProvider(runtime: string): string {
	return runtime === "claude_code" ? "claude" : "opencode";
}

app.post("/build", async (c) => {
	const body = (await c.req.json()) as BuildInput;

	const {
		goal,
		repo_path = "",
		repo_url = "",
		artifacts_dir = ".artifacts",
		additional_context = "",
		config = {},
	} = body;

	const cfg = FastBuildConfigSchema.parse(config);

	const effectiveRepoUrl = repo_url || (cfg.repo_url as string);
	if (!effectiveRepoUrl && !repo_path) {
		return c.json(
			{ error: "Either repo_path or repo_url must be provided" },
			400,
		);
	}

	const resolved = fastResolveModels(cfg) as Record<string, string>;
	const aiProvider = runtimeToProvider(cfg.runtime);

	const gitModel = resolved["git_model"] ?? "haiku";
	const pmModel = resolved["pm_model"] ?? "haiku";
	const coderModel = resolved["coder_model"] ?? "haiku";
	const verifierModel = resolved["verifier_model"] ?? "sonnet";

	let resolvedRepoPath = repo_path;
	if (effectiveRepoUrl && !repo_path) {
		resolvedRepoPath = `/workspaces/${repoNameFromUrl(effectiveRepoUrl)}`;
	}

	const absArtifactsDir = `${resolvedRepoPath}/${artifacts_dir}`;

	// ── 1. GIT INIT (non-fatal) ────────────────────────────────────────────────
	let gitIntegrationBranch = "";
	let gitOriginalBranch = "";
	let gitRemoteUrl = "";
	let gitRemoteDefaultBranch = "";

	try {
		const gitResult = await runGitInit({
			repo_path: resolvedRepoPath,
			goal,
			artifacts_dir: absArtifactsDir,
			model: gitModel,
			permission_mode: cfg.permission_mode as string,
			ai_provider: aiProvider,
		});
		if (gitResult.success) {
			gitIntegrationBranch = gitResult.integration_branch;
			gitOriginalBranch = gitResult.original_branch;
			gitRemoteUrl = gitResult.remote_url ?? "";
			gitRemoteDefaultBranch = gitResult.remote_default_branch ?? "";
		}
	} catch (e) {
		console.debug("[fast_build] git_init non-fatal:", e);
	}

	// ── 2. PLAN + EXECUTE ───────────────────────────────────────────────────────
	let planResult: Record<string, unknown> = {};
	let executionResult: Record<string, unknown> = {};

	try {
		const tasksResult = await fastPlanTasks({
			goal,
			repo_path: resolvedRepoPath,
			max_tasks: cfg.max_tasks,
			pm_model: pmModel,
			permission_mode: cfg.permission_mode as string,
			ai_provider: aiProvider,
			additional_context,
			artifacts_dir: absArtifactsDir,
		});
		planResult = tasksResult as unknown as Record<string, unknown>;

		const execResult = await fastExecuteTasks(
			(planResult.tasks as Array<{
				name: string;
				title?: string;
				description?: string;
				acceptance_criteria?: string[];
				files_to_create?: string[];
				files_to_modify?: string[];
			}>) ?? [],
			{
				repo_path: resolvedRepoPath,
				coder_model: coderModel,
				permission_mode: cfg.permission_mode as string,
				ai_provider: aiProvider,
				task_timeout_seconds: cfg.task_timeout_seconds,
				artifacts_dir: absArtifactsDir,
				agent_max_turns: cfg.agent_max_turns,
			},
		);
		executionResult = execResult as unknown as Record<string, unknown>;
	} catch (e) {
		if (e instanceof Error && e.message.includes("timeout")) {
			executionResult = {
				timed_out: true,
				task_results: [],
				completed_count: 0,
				failed_count: 0,
			};
		} else {
			throw e;
		}
	}

	// ── 3. VERIFY (non-fatal) ────────────────────────────────────────────────────
	let verification: Record<string, unknown> = {};
	try {
		const prd = (planResult.prd as Record<string, unknown>) || {
			validated_description: goal,
			acceptance_criteria: [],
			must_have: [],
			nice_to_have: [],
			out_of_scope: [],
		};
		const taskResultsArr =
			(executionResult.task_results as Array<{
				task_name: string;
				outcome?: string;
				summary?: string;
			}>) ?? [];
		const verifyResult = await fastVerify({
			prd: prd as Parameters<typeof fastVerify>[0]["prd"],
			repo_path: resolvedRepoPath,
			task_results: taskResultsArr,
			verifier_model: verifierModel,
			permission_mode: cfg.permission_mode as string,
			ai_provider: aiProvider,
			artifacts_dir: absArtifactsDir,
		});
		verification = verifyResult as unknown as Record<string, unknown>;
	} catch (e) {
		verification = { passed: false, summary: `Verification failed: ${e}` };
	}

	const success = Boolean(verification.passed);

	// ── 4. FINALIZE (non-fatal) ─────────────────────────────────────────────────
	try {
		await runRepoFinalize({
			repo_path: resolvedRepoPath,
			artifacts_dir: absArtifactsDir,
			model: gitModel,
			permission_mode: cfg.permission_mode as string,
			ai_provider: aiProvider,
		});
	} catch (e) {
		console.debug("[fast_build] finalize non-fatal:", e);
	}

	// ── 5. GITHUB PR (if enabled) ───────────────────────────────────────────────
	let prUrl = "";
	if (gitRemoteUrl && cfg.enable_github_pr) {
		try {
			const baseBranch =
				(cfg.github_pr_base as string) || gitRemoteDefaultBranch || "main";
			const completedCount = Number(executionResult.completed_count ?? 0);
			const taskResultsArr = (executionResult.task_results as unknown[]) ?? [];

			const buildSummary =
				`${success ? "Success" : "Partial"}: ` +
				`${completedCount}/${taskResultsArr.length} tasks completed` +
				`, verification: ${(verification.summary as string) ?? ""}`;

			const completedIssues = (taskResultsArr as Record<string, unknown>[])
				.filter((r) => r["outcome"] === "completed")
				.map((r) => ({
					issue_name: String(r["task_name"] ?? ""),
					result_summary: String(r["summary"] ?? ""),
				}));

			const prResult = await runGitHubPR({
				repo_path: resolvedRepoPath,
				integration_branch: gitIntegrationBranch,
				base_branch: baseBranch,
				goal,
				build_summary: buildSummary,
				completed_issues: completedIssues,
				accumulated_debt: [],
				artifacts_dir: absArtifactsDir,
				model: gitModel,
				permission_mode: cfg.permission_mode as string,
				ai_provider: aiProvider,
			});
			prUrl = prResult.pr_url ?? "";
		} catch (e) {
			console.debug("[fast_build] github_pr non-fatal:", e);
		}
	}

	const completedCount = Number(executionResult.completed_count ?? 0);
	const taskResultsArr = (executionResult.task_results as unknown[]) ?? [];
	const summary =
		`${success ? "Success" : "Partial"}: ` +
		`${completedCount}/${taskResultsArr.length} tasks completed` +
		(verification.summary ? `, verification: ${verification.summary}` : "");

	const result = FastBuildResultSchema.parse({
		plan_result: planResult,
		execution_result: executionResult,
		verification,
		success,
		summary,
		pr_url: prUrl,
	});

	return c.json(result);
});

async function runGitInit(params: {
	repo_path: string;
	goal: string;
	artifacts_dir: string;
	model: string;
	permission_mode: string;
	ai_provider: string;
}): Promise<{
	success: boolean;
	integration_branch: string;
	original_branch: string;
	initial_commit_sha: string;
	mode: string;
	remote_url?: string;
	remote_default_branch?: string;
}> {
	void params;
	await new Promise((r) => setTimeout(r, 10));
	return {
		success: true,
		integration_branch: "swe/build",
		original_branch: "main",
		initial_commit_sha: "abc123",
		mode: "integration",
		remote_url: "",
		remote_default_branch: "main",
	};
}

async function runRepoFinalize(params: {
	repo_path: string;
	artifacts_dir: string;
	model: string;
	permission_mode: string;
	ai_provider: string;
}): Promise<void> {
	void params;
	await new Promise((r) => setTimeout(r, 10));
}

async function runGitHubPR(params: {
	repo_path: string;
	integration_branch: string;
	base_branch: string;
	goal: string;
	build_summary: string;
	completed_issues: { issue_name: string; result_summary: string }[];
	accumulated_debt: unknown[];
	artifacts_dir: string;
	model: string;
	permission_mode: string;
	ai_provider: string;
}): Promise<{ success: boolean; pr_url: string; error_message: string }> {
	void params;
	await new Promise((r) => setTimeout(r, 10));
	return {
		success: false,
		pr_url: "",
		error_message: "PR not yet implemented",
	};
}

export { app };

const port = parseInt(process.env.PORT ?? "8004", 10);
console.log(`[swe-fast] starting on 0.0.0.0:${port}`);
serve({ fetch: app.fetch, port });
