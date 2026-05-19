import type { FastVerificationResult } from "./schemas.js";

export interface VerifierOptions {
	repo_path: string;
	verifier_model?: string;
	permission_mode?: string;
	ai_provider?: string;
	artifacts_dir?: string;
}

interface TaskResultDict {
	task_name: string;
	outcome?: string;
	summary?: string;
}

interface PRD {
	validated_description?: string;
	acceptance_criteria?: string[];
	must_have?: string[];
	nice_to_have?: string[];
	out_of_scope?: string[];
}

async function runVerifierCall(
	opts: VerifierOptions,
): Promise<FastVerificationResult> {
	return {
		passed: false,
		summary: "Verification not yet implemented",
		criteria_results: [],
		suggested_fixes: [],
	};
}

export async function fastVerify({
	prd,
	repo_path,
	task_results,
	verifier_model = "sonnet",
	permission_mode = "",
	ai_provider = "claude",
	artifacts_dir = "",
}: {
	prd: PRD;
	repo_path: string;
	task_results: TaskResultDict[];
	verifier_model?: string;
	permission_mode?: string;
	ai_provider?: string;
	artifacts_dir?: string;
}): Promise<FastVerificationResult> {
	const opts: VerifierOptions = {
		repo_path,
		verifier_model,
		permission_mode,
		ai_provider,
		artifacts_dir,
	};

	try {
		const completed_issues = task_results
			.filter((tr) => tr.outcome === "completed")
			.map((tr) => ({
				issue_name: tr.task_name,
				result_summary: tr.summary ?? "",
			}));

		const failed_issues = task_results
			.filter((tr) => tr.outcome !== "completed")
			.map((tr) => ({
				issue_name: tr.task_name,
				result_summary: tr.summary ?? "",
			}));

		const result = await runVerifierCall(opts);

		return {
			passed: result.passed,
			summary: result.summary,
			criteria_results: result.criteria_results,
			suggested_fixes: result.suggested_fixes,
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			passed: false,
			summary: `Verification failed: ${msg}`,
			criteria_results: [],
			suggested_fixes: [],
		};
	}
}
