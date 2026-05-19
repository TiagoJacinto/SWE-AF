import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { FastPlanResultSchema } from "./schemas.js";
import {
	FAST_PLANNER_SYSTEM_PROMPT,
	fastPlannerTaskPrompt,
} from "./prompts.js";

function runtimeToProvider(runtime: string): string {
	return runtime === "claude_code" ? "claude" : "opencode";
}

function getModel(provider: string, modelName: string) {
	if (provider === "claude" || provider === "claude-code") {
		return anthropic(modelName);
	}
	return openai(modelName);
}

function fallbackPlan(goal: string) {
	return {
		tasks: [
			{
				name: "implement-goal",
				title: "Implement goal",
				description: goal,
				acceptance_criteria: ["Goal is implemented successfully."],
				files_to_create: [],
				files_to_modify: [],
				estimated_minutes: 5,
			},
		],
		rationale: "Fallback plan: LLM did not return a parseable result.",
		fallback_used: true,
	};
}

export async function fastPlanTasks({
	goal,
	repo_path,
	max_tasks = 10,
	pm_model = "haiku",
	permission_mode = "",
	ai_provider = "claude",
	additional_context = "",
	artifacts_dir = "",
}: {
	goal: string;
	repo_path: string;
	max_tasks?: number;
	pm_model?: string;
	permission_mode?: string;
	ai_provider?: string;
	additional_context?: string;
	artifacts_dir?: string;
}): Promise<ReturnType<typeof FastPlanResultSchema.parse>> {
	const prompt = fastPlannerTaskPrompt({
		goal,
		repo_path,
		max_tasks,
		additional_context,
	});

	const provider = ai_provider === "claude" ? "claude-code" : ai_provider;
	const model = getModel(provider, pm_model);

	try {
		const result = await generateText({
			model,
			system: FAST_PLANNER_SYSTEM_PROMPT,
			prompt,
			maxRetries: 3,
			temperature: 0,
		});

		const parsed = FastPlanResultSchema.safeParse(result.toString());

		if (!parsed.success) {
			console.debug("[fast_planner] parse failed, using fallback");
			return fallbackPlan(goal);
		}

		let plan = parsed.data;
		if (plan.tasks.length > max_tasks) {
			plan = { ...plan, tasks: plan.tasks.slice(0, max_tasks) };
		}

		return plan;
	} catch (err) {
		console.debug("[fast_planner] LLM call failed, using fallback:", err);
		return fallbackPlan(goal);
	}
}
