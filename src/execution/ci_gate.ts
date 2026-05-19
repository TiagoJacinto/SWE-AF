import type { CIFailedCheck, CIWatchResult } from "./schemas.js";
import { CI_STATUS } from "./schemas.js";

const PENDING_BUCKETS = new Set(["pending", "queued"]);
const FAILURE_BUCKETS = new Set(["fail", "cancel"]);
const LOG_TAIL_CHARS = 3000;

const RUN_ID_RE = /\/actions\/runs\/(\d+)(?:\/|$)/;

export type CommandRunner = (cmd: string[], cwd: string) => SubprocessResult;

export interface SubprocessResult {
	stdout: string;
	stderr: string;
	returncode: number;
}

export function default_runner(cmd: string[], cwd: string): SubprocessResult {
	const { execFileSync } =
		require("node:child_process") as typeof import("node:child_process");
	try {
		const result = execFileSync(cmd[0]!, cmd.slice(1), {
			cwd: cwd || undefined,
			encoding: "utf-8",
		} as { cwd?: string; encoding: "utf-8" });
		return { stdout: result as string, stderr: "", returncode: 0 };
	} catch (err) {
		const error = err as { status?: number; stderr?: string; stdout?: string };
		return {
			stdout: (error.stdout as string) ?? "",
			stderr: (error.stderr as string) ?? "",
			returncode: error.status ?? 1,
		};
	}
}

function parse_checks(payload: string): Record<string, unknown>[] {
	const text = (payload ?? "").trim();
	if (!text) return [];
	try {
		const data = JSON.parse(text);
		if (!Array.isArray(data))
			throw new Error(`Expected JSON array, got ${typeof data}`);
		return data as Record<string, unknown>[];
	} catch (e) {
		throw new Error(`Failed to parse checks: ${e}`);
	}
}

function is_conclusive(checks: Record<string, unknown>[]): boolean {
	return checks.every((c) => !PENDING_BUCKETS.has(String(c.bucket ?? "")));
}

function classify(checks: Record<string, unknown>[]): "failed" | "passed" {
	for (const c of checks) {
		if (FAILURE_BUCKETS.has(String(c.bucket ?? ""))) return "failed";
	}
	return "passed";
}

function extract_run_id(details_url: string): string {
	const match = RUN_ID_RE.exec(details_url);
	return match ? (match[1] ?? "") : "";
}

function tail(text: string, max_chars = LOG_TAIL_CHARS): string {
	if (text.length <= max_chars) return text;
	return `…[truncated]…\n${text.slice(-max_chars)}`;
}

function fetch_failed_logs(
	repo_path: string,
	run_id: string,
	runner: CommandRunner,
): string {
	if (!run_id) return "";
	const proc = runner(["gh", "run", "view", run_id, "--log-failed"], repo_path);
	let body = proc.stdout ?? "";
	if (proc.returncode !== 0 && !body) {
		body = proc.stderr ?? "";
	}
	return tail(body);
}

function build_failed_checks(
	raw_checks: Record<string, unknown>[],
	repo_path: string,
	runner: CommandRunner,
): CIFailedCheck[] {
	const failures: CIFailedCheck[] = [];
	for (const c of raw_checks) {
		if (!FAILURE_BUCKETS.has(String(c.bucket ?? ""))) continue;
		const details_url = (c.link ?? c.detailsUrl ?? "") as string;
		const run_id = extract_run_id(details_url);
		const logs_excerpt = fetch_failed_logs(repo_path, run_id, runner);
		failures.push({
			name: (c.name ?? "?") as string,
			workflow: (c.workflow ?? "") as string,
			conclusion: (c.state ?? c.bucket ?? "") as string,
			details_url,
			logs_excerpt,
		});
	}
	return failures;
}

export async function watch_pr_checks({
	repo_path,
	pr_number,
	wait_seconds = 1500,
	poll_seconds = 30,
	head_sha = "",
	runner,
	sleep,
	now,
}: {
	repo_path: string;
	pr_number: number;
	wait_seconds?: number;
	poll_seconds?: number;
	head_sha?: string;
	runner?: CommandRunner;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}): Promise<CIWatchResult> {
	const cmd_runner = runner ?? default_runner;
	const sleeper = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
	const clock = now ?? (() => Date.now() / 1000);

	let start = clock();
	const expected_sha = (head_sha ?? "").trim().toLowerCase();

	function elapsed(): number {
		return Math.floor(clock() - start);
	}

	let last_checks: Record<string, unknown>[] = [];
	let saw_any_check = false;
	let saw_any_for_sha = false;

	const fields = "bucket,state,name,workflow,link,headSha";

	while (true) {
		const proc = cmd_runner(
			["gh", "pr", "checks", String(pr_number), "--json", fields],
			repo_path,
		);

		if (proc.returncode !== 0) {
			const stderr = (proc.stderr ?? "").trim();
			try {
				last_checks = parse_checks(proc.stdout ?? "");
			} catch {
				last_checks = [];
			}
			if (!last_checks.length) {
				return {
					status: CI_STATUS.error,
					pr_number,
					elapsed_seconds: elapsed(),
					summary: `gh pr checks failed: ${stderr.slice(0, 300)}`,
					failed_checks: [],
				};
			}
		} else {
			try {
				last_checks = parse_checks(proc.stdout ?? "");
			} catch (e) {
				return {
					status: CI_STATUS.error,
					pr_number,
					elapsed_seconds: elapsed(),
					summary: `Could not parse gh pr checks output: ${e}`,
					failed_checks: [],
				};
			}
		}

		let sha_unsupported = false;
		let checks_for_verdict: Record<string, unknown>[];

		if (expected_sha) {
			const sha_matched = last_checks.filter((c) => {
				const c_sha = (String(c.headSha ?? "") || "").trim().toLowerCase();
				return !c_sha || c_sha === expected_sha;
			});
			checks_for_verdict = sha_matched;

			const has_sha_match = last_checks.some(
				(c) =>
					(String(c.headSha ?? "") || "").trim().toLowerCase() === expected_sha,
			);
			if (has_sha_match) saw_any_for_sha = true;

			if (
				last_checks.length &&
				!last_checks.some((c) => (String(c.headSha ?? "") || "").trim())
			) {
				sha_unsupported = true;
			}
		} else {
			checks_for_verdict = last_checks;
		}

		if (last_checks.length) saw_any_check = true;

		const verdict_eligible =
			expected_sha && sha_unsupported
				? checks_for_verdict.length > 0
				: checks_for_verdict.length > 0 &&
					(expected_sha ? saw_any_for_sha : true);

		if (verdict_eligible && is_conclusive(checks_for_verdict)) {
			const verdict = classify(checks_for_verdict);
			if (verdict === "passed") {
				return {
					status: CI_STATUS.passed,
					pr_number,
					elapsed_seconds: elapsed(),
					summary: `All ${checks_for_verdict.length} check(s) passed`,
					failed_checks: [],
				};
			}
			const failures = build_failed_checks(
				checks_for_verdict,
				repo_path,
				cmd_runner,
			);
			return {
				status: CI_STATUS.failed,
				pr_number,
				elapsed_seconds: elapsed(),
				failed_checks: failures,
				summary: `${failures.length} of ${checks_for_verdict.length} check(s) failing`,
			};
		}

		if (elapsed() >= wait_seconds) {
			if (!saw_any_check || (expected_sha && !saw_any_for_sha)) {
				return {
					status: CI_STATUS.no_checks,
					pr_number,
					elapsed_seconds: elapsed(),
					summary:
						`No checks reported in ${wait_seconds}s — PR has no CI configured or checks not yet started` +
						(expected_sha && !saw_any_for_sha
							? ` for ${expected_sha.slice(0, 10)}`
							: ""),
					failed_checks: [],
				};
			}
			return {
				status: CI_STATUS.timed_out,
				pr_number,
				elapsed_seconds: elapsed(),
				summary: `Checks still pending after ${wait_seconds}s (${checks_for_verdict.length} reporting)`,
				failed_checks: [],
			};
		}

		await sleeper(poll_seconds * 1000);
	}
}

export async function mark_pr_ready({
	repo_path,
	pr_number,
	runner,
}: {
	repo_path: string;
	pr_number: number;
	runner?: CommandRunner;
}): Promise<{ success: boolean; message: string }> {
	const cmd_runner = runner ?? default_runner;
	const proc = cmd_runner(["gh", "pr", "ready", String(pr_number)], repo_path);
	if (proc.returncode === 0) {
		return {
			success: true,
			message: `PR #${pr_number} marked ready for review`,
		};
	}
	return {
		success: false,
		message: ((proc.stderr ?? "") || "gh pr ready failed").slice(0, 300),
	};
}
