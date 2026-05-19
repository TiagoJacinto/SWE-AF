import { z } from "zod";

export const DEFAULT_AGENT_MAX_TURNS = 50;

const RUNTIME_VALUES = ["claude_code", "open_code"] as const;
type RuntimeValue = (typeof RUNTIME_VALUES)[number];

const _FAST_ROLES = [
	"pm_model",
	"coder_model",
	"verifier_model",
	"git_model",
] as const;

const _ROLE_KEY_MAP: Record<string, string> = {
	pm: "pm_model",
	coder: "coder_model",
	verifier: "verifier_model",
	git: "git_model",
};

const _RUNTIME_DEFAULTS: Record<string, string> = {
	claude_code: "haiku",
	open_code: "qwen/qwen-2.5-coder-32b-instruct",
};

export const FastTaskSchema = z.object({
	name: z.string(),
	title: z.string(),
	description: z.string(),
	acceptance_criteria: z.array(z.string()),
	files_to_create: z.array(z.string()).default([]),
	files_to_modify: z.array(z.string()).default([]),
	estimated_minutes: z.number().int().default(5),
});
export type FastTask = z.infer<typeof FastTaskSchema>;

export const FastPlanResultSchema = z.object({
	tasks: z.array(FastTaskSchema),
	rationale: z.string().default(""),
	fallback_used: z.boolean().default(false),
});
export type FastPlanResult = z.infer<typeof FastPlanResultSchema>;

export const FastTaskResultSchema = z.object({
	task_name: z.string(),
	outcome: z.enum(["completed", "failed", "timeout"]),
	files_changed: z.array(z.string()).default([]),
	summary: z.string().default(""),
	error: z.string().default(""),
});
export type FastTaskResult = z.infer<typeof FastTaskResultSchema>;

export const FastExecutionResultSchema = z.object({
	task_results: z.array(FastTaskResultSchema),
	completed_count: z.number().int(),
	failed_count: z.number().int(),
	timed_out: z.boolean().default(false),
});
export type FastExecutionResult = z.infer<typeof FastExecutionResultSchema>;

export const FastVerificationResultSchema = z.object({
	passed: z.boolean(),
	summary: z.string().default(""),
	criteria_results: z.array(z.record(z.unknown())).default([]),
	suggested_fixes: z.array(z.string()).default([]),
});
export type FastVerificationResult = z.infer<
	typeof FastVerificationResultSchema
>;

export const FastBuildConfigSchema = z.object({
	runtime: z.enum(RUNTIME_VALUES).default("claude_code"),
	models: z.record(z.string(), z.string()).nullable().default(null),
	max_tasks: z.number().int().default(10),
	task_timeout_seconds: z.number().int().default(300),
	build_timeout_seconds: z.number().int().default(600),
	enable_github_pr: z.boolean().default(true),
	github_pr_base: z.string().default(""),
	permission_mode: z.string().default(""),
	repo_url: z.string().default(""),
	agent_max_turns: z.number().int().default(DEFAULT_AGENT_MAX_TURNS),
});
export type FastBuildConfig = z.infer<typeof FastBuildConfigSchema>;

export const FastBuildResultSchema = z.object({
	plan_result: z.record(z.unknown()),
	execution_result: z.record(z.unknown()),
	verification: z.record(z.unknown()).nullable().default(null),
	success: z.boolean(),
	summary: z.string(),
	pr_url: z.string().default(""),
});
export type FastBuildResult = z.infer<typeof FastBuildResultSchema>;

export function fastResolveModels(
	config: FastBuildConfig,
): Record<string, string> {
	const runtimeDefault = _RUNTIME_DEFAULTS[config.runtime] ?? "haiku";
	const resolved: Record<string, string> = {};

	for (const role of _FAST_ROLES) {
		resolved[role] = runtimeDefault;
	}

	if (config.models) {
		const validKeys = new Set(["default", ...Object.keys(_ROLE_KEY_MAP)]);
		for (const key of Object.keys(config.models)) {
			if (!validKeys.has(key)) {
				throw new Error(
					`Unknown role key ${JSON.stringify(key)} in models dict. Valid keys are: ${Array.from(validKeys).sort().join(", ")}`,
				);
			}
		}

		if ("default" in config.models) {
			for (const role of _FAST_ROLES) {
				resolved[role] = config.models["default"]!;
			}
		}

		for (const [roleKey, resolvedKey] of Object.entries(_ROLE_KEY_MAP)) {
			if (roleKey in config.models) {
				resolved[resolvedKey] = config.models[roleKey]!;
			}
		}
	}

	return resolved;
}
