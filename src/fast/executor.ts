import type { FastExecutionResult, FastTaskResult } from "./schemas.js";

export interface ExecutorOptions {
	repo_path: string;
	coder_model?: string;
	permission_mode?: string;
	ai_provider?: string;
	task_timeout_seconds?: number;
	agent_max_turns?: number;
	artifacts_dir?: string;
}

interface TaskDict {
	name: string;
	title?: string;
	description?: string;
	acceptance_criteria?: string[];
	files_to_create?: string[];
	files_to_modify?: string[];
}

async function runCoderTask(
	task: TaskDict,
	opts: ExecutorOptions,
): Promise<FastTaskResult> {
	const timeout = opts.task_timeout_seconds ?? 300;
	const start = Date.now();

	const issue = {
		name: task.name,
		title: task.title ?? task.name,
		description: task.description ?? "",
		acceptance_criteria: task.acceptance_criteria ?? [],
		files_to_create: task.files_to_create ?? [],
		files_to_modify: task.files_to_modify ?? [],
		testing_strategy: "",
	};

	const project_context = {
		artifacts_dir: opts.artifacts_dir ?? "",
		repo_path: opts.repo_path,
	};

	let timeoutId: ReturnType<typeof setTimeout>;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutId = setTimeout(
			() => reject(new Error(`Timed out after ${timeout}s`)),
			timeout * 1000,
		);
	});

	try {
		const coderPromise = simulateCoderCall({
			issue,
			worktree_path: opts.repo_path,
			iteration: 1,
			iteration_id: task.name,
			project_context,
			model: opts.coder_model ?? "haiku",
			permission_mode: opts.permission_mode ?? "",
			ai_provider: opts.ai_provider ?? "claude",
			agent_max_turns: opts.agent_max_turns ?? 50,
		});

		const result = await Promise.race([coderPromise, timeoutPromise]);
		clearTimeout(timeoutId!);

		return {
			task_name: task.name,
			outcome: result.complete ? "completed" : "failed",
			files_changed: result.files_changed ?? [],
			summary: result.summary ?? "",
			error: "",
		};
	} catch (err) {
		clearTimeout(timeoutId!);
		const msg = err instanceof Error ? err.message : String(err);
		if (msg.includes("Timed out")) {
			return {
				task_name: task.name,
				outcome: "timeout" as const,
				files_changed: [],
				summary: "",
				error: msg,
			};
		}
		return {
			task_name: task.name,
			outcome: "failed" as const,
			files_changed: [],
			summary: "",
			error: msg,
		};
	}
}

async function simulateCoderCall(params: {
	issue: Record<string, unknown>;
	worktree_path: string;
	iteration: number;
	iteration_id: string;
	project_context: Record<string, unknown>;
	model: string;
	permission_mode: string;
	ai_provider: string;
	agent_max_turns: number;
}): Promise<{ complete: boolean; files_changed: string[]; summary: string }> {
	await new Promise((r) => setTimeout(r, 50));
	return {
		complete: true,
		files_changed: [],
		summary: `Task ${params.iteration_id} completed`,
	};
}

export async function fastExecuteTasks(
	tasks: TaskDict[],
	opts: ExecutorOptions,
): Promise<FastExecutionResult> {
	const taskResults: FastTaskResult[] = [];

	for (const task of tasks) {
		const result = await runCoderTask(task, opts);
		taskResults.push(result);
	}

	const completed = taskResults.filter((r) => r.outcome === "completed").length;
	const failed = taskResults.filter((r) => r.outcome === "failed").length;

	return {
		task_results: taskResults,
		completed_count: completed,
		failed_count: failed,
		timed_out: taskResults.some((r) => r.outcome === "timeout"),
	};
}
