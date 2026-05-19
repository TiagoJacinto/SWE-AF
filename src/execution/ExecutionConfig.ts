import { z } from "zod";

export const AdvisorActionEnum = z.nativeEnum({
	RETRY_MODIFIED: "retry_modified",
	RETRY_APPROACH: "retry_approach",
	SPLIT: "split",
	ACCEPT_WITH_DEBT: "accept_with_debt",
	ESCALATE_TO_REPLAN: "escalate_to_replan",
});
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
export type IssueOutcome = z.infer<typeof IssueOutcomeEnum>;

export const ReplanActionEnum = z.nativeEnum({
	CONTINUE: "continue",
	MODIFY_DAG: "modify_dag",
	REDUCE_SCOPE: "reduce_scope",
	ABORT: "abort",
});
export type ReplanAction = z.infer<typeof ReplanActionEnum>;

export const ExecutionConfigSchema = z.object({
	git_model: z.string().default("sonnet"),
	ai_provider: z.string().default("claude"),
	coder_model: z.string().default("sonnet"),
	code_reviewer_model: z.string().default("sonnet"),
	qa_model: z.string().default("sonnet"),
	qa_synthesizer_model: z.string().default("sonnet"),
	replan_model: z.string().default("sonnet"),
	merger_model: z.string().default("sonnet"),
	integration_tester_model: z.string().default("sonnet"),
	git_init_max_retries: z.number().int().default(3),
	git_init_retry_delay: z.number().default(1.0),
	max_retries_per_issue: z.number().int().default(2),
	max_replans: z.number().int().default(2),
	enable_replanning: z.boolean().default(true),
	max_integration_test_retries: z.number().int().default(1),
	enable_integration_testing: z.boolean().default(true),
	max_coding_iterations: z.number().int().default(5),
	agent_timeout_seconds: z.number().int().default(2700),
	max_advisor_invocations: z.number().int().default(2),
	enable_issue_advisor: z.boolean().default(true),
	permission_mode: z.string().default(""),
	enable_learning: z.boolean().default(false),
	max_concurrent_issues: z.number().int().default(0),
	level_failure_abort_threshold: z.number().default(0.8),
	issue_writer_model: z.string().default("sonnet"),
	retry_advisor_model: z.string().default("sonnet"),
	issue_advisor_model: z.string().default("sonnet"),
});
export type ExecutionConfig = z.infer<typeof ExecutionConfigSchema>;
