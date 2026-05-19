import { z } from "zod";

export const DEFAULT_AGENT_MAX_TURNS = 150;

export const RUNTIME_VALUES = ["claude_code", "open_code"] as const;
export type RuntimeValue = (typeof RUNTIME_VALUES)[number];

export const AdvisorActionEnum = z.nativeEnum({
	RETRY_MODIFIED: "retry_modified",
	RETRY_APPROACH: "retry_approach",
	SPLIT: "split",
	ACCEPT_WITH_DEBT: "accept_with_debt",
	ESCALATE_TO_REPLAN: "escalate_to_replan",
});
export const ADVISOR_ACTION = {
	RETRY_MODIFIED: "retry_modified",
	RETRY_APPROACH: "retry_approach",
	SPLIT: "split",
	ACCEPT_WITH_DEBT: "accept_with_debt",
	ESCALATE_TO_REPLAN: "escalate_to_replan",
} as const;
export type AdvisorAction = z.infer<typeof AdvisorActionEnum>;

export const IssueOutcomeEnum = z.nativeEnum({
	COMPLETED: "completed",
	COMPLETED_WITH_DEBT: "completed_with_debt",
	FAILED_RETRYABLE: "failed_retryable",
	FAILED_UNRECOVERABLE: "failed_unrecoverable",
	FAILED_NEEDS_SPLIT: "failed_needs_split",
	FAILED_ESCALATED: "failed_escalated",
	SKIPPED: "skipped",
});
export const ISSUE_OUTCOME = {
	COMPLETED: "completed",
	COMPLETED_WITH_DEBT: "completed_with_debt",
	FAILED_RETRYABLE: "failed_retryable",
	FAILED_UNRECOVERABLE: "failed_unrecoverable",
	FAILED_NEEDS_SPLIT: "failed_needs_split",
	FAILED_ESCALATED: "failed_escalated",
	SKIPPED: "skipped",
} as const;
export type IssueOutcome = z.infer<typeof IssueOutcomeEnum>;

export const ReplanActionEnum = z.nativeEnum({
	CONTINUE: "continue",
	MODIFY_DAG: "modify_dag",
	REDUCE_SCOPE: "reduce_scope",
	ABORT: "abort",
});
export const REPLAN_ACTION = {
	CONTINUE: "continue",
	MODIFY_DAG: "modify_dag",
	REDUCE_SCOPE: "reduce_scope",
	ABORT: "abort",
} as const;
export type ReplanAction = z.infer<typeof ReplanActionEnum>;

export const QASynthesisActionEnum = z.nativeEnum({
	FIX: "fix",
	APPROVE: "approve",
	BLOCK: "block",
});
export type QASynthesisAction = z.infer<typeof QASynthesisActionEnum>;

export const CIStatusEnum = z.nativeEnum({
	passed: "passed",
	failed: "failed",
	timed_out: "timed_out",
	no_checks: "no_checks",
	error: "error",
});
export const CI_STATUS = {
	passed: "passed",
	failed: "failed",
	timed_out: "timed_out",
	no_checks: "no_checks",
	error: "error",
} as const;
export type CIStatus = z.infer<typeof CIStatusEnum>;

const roleValidator = z.union([z.literal("primary"), z.literal("dependency")]);

export const RepoSpecSchema = z.object({
	repo_url: z
		.string()
		.default("")
		.refine(
			(v) =>
				!v ||
				v.startsWith("http://") ||
				v.startsWith("https://") ||
				v.startsWith("git@"),
			{
				message: "repo_url must be an HTTP(S) or SSH git URL",
			},
		),
	repo_path: z.string().default(""),
	role: roleValidator,
	branch: z.string().default(""),
	sparse_paths: z.array(z.string()).default([]),
	mount_point: z.string().default(""),
	create_pr: z.boolean().default(true),
});
export type RepoSpec = z.infer<typeof RepoSpecSchema>;

export const WorkspaceRepoSchema = z.object({
	repo_name: z.string(),
	repo_url: z.string(),
	role: roleValidator,
	absolute_path: z.string(),
	branch: z.string(),
	sparse_paths: z.array(z.string()).default([]),
	create_pr: z.boolean().default(true),
	git_init_result: z.record(z.unknown()).nullable().default(null),
});
export type WorkspaceRepo = z.infer<typeof WorkspaceRepoSchema>;

export const WorkspaceManifestSchema = z.object({
	workspace_root: z.string(),
	repos: z.array(WorkspaceRepoSchema),
	primary_repo_name: z.string(),
});
export type WorkspaceManifest = z.infer<typeof WorkspaceManifestSchema>;

export const RepoPRResultSchema = z.object({
	repo_name: z.string(),
	repo_url: z.string(),
	success: z.boolean(),
	pr_url: z.string().default(""),
	pr_number: z.number().int().default(0),
	error_message: z.string().default(""),
});
export type RepoPRResult = z.infer<typeof RepoPRResultSchema>;

export const IssueAdaptationSchema = z.object({
	adaptation_type: AdvisorActionEnum,
	original_acceptance_criteria: z.array(z.string()).default([]),
	modified_acceptance_criteria: z.array(z.string()).default([]),
	dropped_criteria: z.array(z.string()).default([]),
	failure_diagnosis: z.string().default(""),
	rationale: z.string().default(""),
	new_approach: z.string().default(""),
	missing_functionality: z.array(z.string()).default([]),
	downstream_impact: z.string().default(""),
	severity: z.string().default("medium"),
});
export type IssueAdaptation = z.infer<typeof IssueAdaptationSchema>;

export const SplitIssueSpecSchema = z.object({
	name: z.string(),
	title: z.string(),
	description: z.string(),
	acceptance_criteria: z.array(z.string()),
	depends_on: z.array(z.string()).default([]),
	provides: z.array(z.string()).default([]),
	files_to_create: z.array(z.string()).default([]),
	files_to_modify: z.array(z.string()).default([]),
	parent_issue_name: z.string().default(""),
});
export type SplitIssueSpec = z.infer<typeof SplitIssueSpecSchema>;

export const IssueAdvisorDecisionSchema = z.object({
	action: AdvisorActionEnum,
	failure_diagnosis: z.string(),
	failure_category: z.string().default(""),
	rationale: z.string(),
	confidence: z.number().min(0).max(1).default(0.5),
	modified_acceptance_criteria: z.array(z.string()).default([]),
	dropped_criteria: z.array(z.string()).default([]),
	modification_justification: z.string().default(""),
	new_approach: z.string().default(""),
	approach_changes: z.array(z.string()).default([]),
	sub_issues: z.array(SplitIssueSpecSchema).default([]),
	split_rationale: z.string().default(""),
	missing_functionality: z.array(z.string()).default([]),
	debt_severity: z.string().default("medium"),
	escalation_reason: z.string().default(""),
	dag_impact: z.string().default(""),
	suggested_restructuring: z.string().default(""),
	downstream_impact: z.string().default(""),
	summary: z.string().default(""),
});
export type IssueAdvisorDecision = z.infer<typeof IssueAdvisorDecisionSchema>;

export const IssueResultSchema = z.object({
	issue_name: z.string(),
	outcome: IssueOutcomeEnum,
	result_summary: z.string().default(""),
	error_message: z.string().default(""),
	error_context: z.string().default(""),
	attempts: z.number().int().default(1),
	files_changed: z.array(z.string()).default([]),
	branch_name: z.string().default(""),
	repo_name: z.string().default(""),
	advisor_invocations: z.number().int().default(0),
	adaptations: z.array(IssueAdaptationSchema).default([]),
	debt_items: z.array(z.record(z.unknown())).default([]),
	split_request: z.array(SplitIssueSpecSchema).nullable().default(null),
	escalation_context: z.string().default(""),
	final_acceptance_criteria: z.array(z.string()).default([]),
	iteration_history: z.array(z.record(z.unknown())).default([]),
});
export type IssueResult = z.infer<typeof IssueResultSchema>;

export const LevelResultSchema = z.object({
	level_index: z.number().int(),
	completed: z.array(IssueResultSchema).default([]),
	failed: z.array(IssueResultSchema).default([]),
	skipped: z.array(IssueResultSchema).default([]),
});
export type LevelResult = z.infer<typeof LevelResultSchema>;

export const ReplanDecisionSchema = z.object({
	action: ReplanActionEnum,
	rationale: z.string(),
	updated_issues: z.array(z.record(z.unknown())).default([]),
	removed_issue_names: z.array(z.string()).default([]),
	skipped_issue_names: z.array(z.string()).default([]),
	new_issues: z.array(z.record(z.unknown())).default([]),
	summary: z.string().default(""),
});
export type ReplanDecision = z.infer<typeof ReplanDecisionSchema>;

export const DAGStateSchema = z.object({
	repo_path: z.string().default(""),
	artifacts_dir: z.string().default(""),
	prd_path: z.string().default(""),
	architecture_path: z.string().default(""),
	issues_dir: z.string().default(""),
	original_plan_summary: z.string().default(""),
	prd_summary: z.string().default(""),
	architecture_summary: z.string().default(""),
	all_issues: z.array(z.record(z.unknown())).default([]),
	levels: z.array(z.array(z.string())).default([]),
	completed_issues: z.array(IssueResultSchema).default([]),
	failed_issues: z.array(IssueResultSchema).default([]),
	skipped_issues: z.array(z.string()).default([]),
	in_flight_issues: z.array(z.string()).default([]),
	current_level: z.number().int().default(0),
	replan_count: z.number().int().default(0),
	replan_history: z.array(ReplanDecisionSchema).default([]),
	max_replans: z.number().int().default(2),
	git_integration_branch: z.string().default(""),
	git_original_branch: z.string().default(""),
	git_initial_commit: z.string().default(""),
	git_mode: z.string().default(""),
	pending_merge_branches: z.array(z.string()).default([]),
	merged_branches: z.array(z.string()).default([]),
	unmerged_branches: z.array(z.string()).default([]),
	worktrees_dir: z.string().default(""),
	build_id: z.string().default(""),
	merge_results: z.array(z.record(z.unknown())).default([]),
	integration_test_results: z.array(z.record(z.unknown())).default([]),
	accumulated_debt: z.array(z.record(z.unknown())).default([]),
	adaptation_history: z.array(z.record(z.unknown())).default([]),
	workspace_manifest: z.record(z.unknown()).nullable().default(null),
});
export type DAGState = z.infer<typeof DAGStateSchema>;

export const GitInitResultSchema = z.object({
	mode: z.string(),
	original_branch: z.string(),
	integration_branch: z.string(),
	initial_commit_sha: z.string(),
	success: z.boolean(),
	error_message: z.string().default(""),
	remote_url: z.string().default(""),
	remote_default_branch: z.string().default(""),
	repo_name: z.string().default(""),
});
export type GitInitResult = z.infer<typeof GitInitResultSchema>;

export const WorkspaceInfoSchema = z.object({
	issue_name: z.string(),
	branch_name: z.string(),
	worktree_path: z.string(),
});
export type WorkspaceInfo = z.infer<typeof WorkspaceInfoSchema>;

export const MergeResultSchema = z.object({
	success: z.boolean(),
	merged_branches: z.array(z.string()).default([]),
	failed_branches: z.array(z.string()).default([]),
	conflict_resolutions: z.array(z.record(z.unknown())).default([]),
	merge_commit_sha: z.string().default(""),
	pre_merge_sha: z.string().default(""),
	needs_integration_test: z.boolean(),
	integration_test_rationale: z.string().default(""),
	summary: z.string(),
	repo_name: z.string().default(""),
});
export type MergeResult = z.infer<typeof MergeResultSchema>;

export const IntegrationTestResultSchema = z.object({
	passed: z.boolean(),
	tests_written: z.array(z.string()).default([]),
	tests_run: z.number().int(),
	tests_passed: z.number().int(),
	tests_failed: z.number().int(),
	failure_details: z.array(z.record(z.unknown())).default([]),
	summary: z.string(),
});
export type IntegrationTestResult = z.infer<typeof IntegrationTestResultSchema>;

export const RetryAdviceSchema = z.object({
	should_retry: z.boolean(),
	diagnosis: z.string(),
	strategy: z.string(),
	modified_context: z.string(),
	confidence: z.number().min(0).max(1).default(0.5),
});
export type RetryAdvice = z.infer<typeof RetryAdviceSchema>;

export const CriterionResultSchema = z.object({
	criterion: z.string(),
	passed: z.boolean(),
	evidence: z.string(),
	issue_name: z.string().default(""),
});
export type CriterionResult = z.infer<typeof CriterionResultSchema>;

export const VerificationResultSchema = z.object({
	passed: z.boolean(),
	criteria_results: z.array(CriterionResultSchema),
	summary: z.string(),
	suggested_fixes: z.array(z.string()).default([]),
});
export type VerificationResult = z.infer<typeof VerificationResultSchema>;

export const CoderResultSchema = z.object({
	files_changed: z.array(z.string()).default([]),
	summary: z.string().default(""),
	complete: z.boolean().default(true),
	iteration_id: z.string().default(""),
	tests_passed: z.boolean().nullable().default(null),
	test_summary: z.string().default(""),
	codebase_learnings: z.array(z.string()).default([]),
	agent_retro: z.record(z.unknown()).default({}),
	repo_name: z.string().default(""),
});
export type CoderResult = z.infer<typeof CoderResultSchema>;

export const QAResultSchema = z.object({
	passed: z.boolean(),
	summary: z.string().default(""),
	test_failures: z.array(z.record(z.unknown())).default([]),
	coverage_gaps: z.array(z.string()).default([]),
	iteration_id: z.string().default(""),
});
export type QAResult = z.infer<typeof QAResultSchema>;

export const CodeReviewResultSchema = z.object({
	approved: z.boolean(),
	summary: z.string().default(""),
	blocking: z.boolean().default(false),
	debt_items: z.array(z.record(z.unknown())).default([]),
	iteration_id: z.string().default(""),
});
export type CodeReviewResult = z.infer<typeof CodeReviewResultSchema>;

export const QASynthesisResultSchema = z.object({
	action: QASynthesisActionEnum,
	summary: z.string().default(""),
	stuck: z.boolean().default(false),
	iteration_id: z.string().default(""),
});
export type QASynthesisResult = z.infer<typeof QASynthesisResultSchema>;

export const BuildConfigSchema = z.object({
	runtime: z.enum(["claude_code", "open_code"]).default("claude_code"),
	models: z.record(z.string(), z.string()).nullable().default(null),
	max_review_iterations: z.number().int().default(2),
	max_plan_revision_iterations: z.number().int().default(2),
	max_retries_per_issue: z.number().int().default(2),
	max_replans: z.number().int().default(2),
	enable_replanning: z.boolean().default(true),
	max_verify_fix_cycles: z.number().int().default(1),
	git_init_max_retries: z.number().int().default(3),
	git_init_retry_delay: z.number().default(1.0),
	max_integration_test_retries: z.number().int().default(1),
	enable_integration_testing: z.boolean().default(true),
	max_coding_iterations: z.number().int().default(5),
	agent_max_turns: z.number().int().default(DEFAULT_AGENT_MAX_TURNS),
	execute_fn_target: z.string().default(""),
	permission_mode: z.string().default(""),
	repo_url: z.string().default(""),
	repos: z.array(RepoSpecSchema).default([]),
	enable_github_pr: z.boolean().default(true),
	github_pr_base: z.string().default(""),
	check_ci: z.boolean().default(true),
	max_ci_fix_cycles: z.number().int().default(2),
	ci_wait_seconds: z.number().int().default(1500),
	ci_poll_seconds: z.number().int().default(30),
	ci_startup_grace_seconds: z.number().int().default(30),
	agent_timeout_seconds: z.number().int().default(2700),
	max_advisor_invocations: z.number().int().default(2),
	enable_issue_advisor: z.boolean().default(true),
	enable_learning: z.boolean().default(false),
	max_concurrent_issues: z.number().int().default(3),
	level_failure_abort_threshold: z.number().default(0.8),
	approval_expires_in_hours: z.number().int().default(72),
});
export type BuildConfig = z.infer<typeof BuildConfigSchema>;

export const BuildResultSchema = z.object({
	plan_result: z.record(z.unknown()),
	dag_state: z.record(z.unknown()),
	verification: z.record(z.unknown()).nullable(),
	success: z.boolean(),
	summary: z.string(),
	pr_results: z.array(RepoPRResultSchema).default([]),
	ci_gate_results: z.array(z.record(z.unknown())).default([]),
});
export type BuildResult = z.infer<typeof BuildResultSchema>;

export const RepoFinalizeResultSchema = z.object({
	success: z.boolean(),
	files_removed: z.array(z.string()).default([]),
	gitignore_updated: z.boolean().default(false),
	summary: z.string().default(""),
});
export type RepoFinalizeResult = z.infer<typeof RepoFinalizeResultSchema>;

export const GitHubPRResultSchema = z.object({
	success: z.boolean(),
	pr_url: z.string().default(""),
	pr_number: z.number().int().default(0),
	error_message: z.string().default(""),
});
export type GitHubPRResult = z.infer<typeof GitHubPRResultSchema>;

export const CIFailedCheckSchema = z.object({
	name: z.string(),
	workflow: z.string().default(""),
	conclusion: z.string().default(""),
	details_url: z.string().default(""),
	logs_excerpt: z.string().default(""),
});
export type CIFailedCheck = z.infer<typeof CIFailedCheckSchema>;

export const CIWatchResultSchema = z.object({
	status: CIStatusEnum,
	pr_number: z.number().int(),
	elapsed_seconds: z.number().int().default(0),
	failed_checks: z.array(CIFailedCheckSchema).default([]),
	summary: z.string().default(""),
});
export type CIWatchResult = z.infer<typeof CIWatchResultSchema>;

export const CIFixResultSchema = z.object({
	fixed: z.boolean(),
	files_changed: z.array(z.string()).default([]),
	commit_sha: z.string().default(""),
	pushed: z.boolean().default(false),
	summary: z.string().default(""),
	rejected_workarounds: z.array(z.string()).default([]),
	error_message: z.string().default(""),
});
export type CIFixResult = z.infer<typeof CIFixResultSchema>;

export const ReviewCommentRefSchema = z.object({
	comment_id: z.number().int().default(0),
	thread_id: z.string().default(""),
	path: z.string().default(""),
	line: z.number().int().default(0),
	author: z.string().default(""),
	body: z.string().default(""),
	url: z.string().default(""),
});
export type ReviewCommentRef = z.infer<typeof ReviewCommentRefSchema>;

export const AddressedCommentSchema = z.object({
	comment_id: z.number().int().default(0),
	thread_id: z.string().default(""),
	addressed: z.boolean(),
	note: z.string().default(""),
});
export type AddressedComment = z.infer<typeof AddressedCommentSchema>;

export const PRResolveResultSchema = z.object({
	fixed: z.boolean(),
	merge_resolved: z.boolean().default(false),
	files_changed: z.array(z.string()).default([]),
	commit_shas: z.array(z.string()).default([]),
	pushed: z.boolean().default(false),
	addressed_comments: z.array(AddressedCommentSchema).default([]),
	summary: z.string().default(""),
	rejected_workarounds: z.array(z.string()).default([]),
	error_message: z.string().default(""),
});
export type PRResolveResult = z.infer<typeof PRResolveResultSchema>;

export const CodingTaskSchema = z.object({
	name: z.string(),
	title: z.string(),
	description: z.string(),
	acceptance_criteria: z.array(z.string()),
	files_to_create: z.array(z.string()).default([]),
	files_to_modify: z.array(z.string()).default([]),
	files_to_delete: z.array(z.string()).default([]),
	estimated_minutes: z.number().int().default(5),
	constraints: z.array(z.string()).default([]),
});
export type CodingTask = z.infer<typeof CodingTaskSchema>;

export const CodingPlanResultSchema = z.object({
	tasks: z.array(CodingTaskSchema),
	rationale: z.string().default(""),
	risks: z.array(z.string()).default([]),
	fallback_used: z.boolean().default(false),
});
export type CodingPlanResult = z.infer<typeof CodingPlanResultSchema>;
