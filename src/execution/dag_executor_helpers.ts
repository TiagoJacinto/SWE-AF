import type { DAGState, ReplanDecision } from "./schemas.js";
import { REPLAN_ACTION } from "./schemas.js";
import { recompute_levels, find_downstream } from "./dag_utils.js";

export function apply_replan(
	dag_state: DAGState,
	decision: ReplanDecision,
): DAGState {
	if (decision.action === REPLAN_ACTION.ABORT) {
		dag_state.replan_count++;
		dag_state.replan_history.push(decision);
		return dag_state;
	}

	if (decision.action === REPLAN_ACTION.CONTINUE) {
		dag_state.replan_count++;
		dag_state.replan_history.push(decision);
		return dag_state;
	}

	const completed_names = new Set(
		dag_state.completed_issues.map((r) => r.issue_name),
	);
	const failed_names = new Set(
		dag_state.failed_issues.map((r) => r.issue_name),
	);

	const remaining_by_name: Record<string, Record<string, unknown>> = {};
	for (const issue of dag_state.all_issues) {
		const name = String(issue.name ?? "");
		if (!completed_names.has(name) && !failed_names.has(name)) {
			remaining_by_name[name] = { ...issue } as Record<string, unknown>;
		}
	}

	const removed = new Set(decision.removed_issue_names);
	for (const name of removed) {
		delete remaining_by_name[name];
	}

	const skipped = new Set(decision.skipped_issue_names);
	for (const name of skipped) {
		delete remaining_by_name[name];
		if (!dag_state.skipped_issues.includes(name)) {
			dag_state.skipped_issues.push(name);
		}
	}

	for (const updated of decision.updated_issues) {
		const name = String(updated.name ?? "");
		if (name in remaining_by_name && remaining_by_name[name]) {
			Object.assign(remaining_by_name[name]!, updated);
		}
	}

	const target_repo_by_name: Record<string, string> = {};
	for (const i of dag_state.all_issues) {
		const tr = i.target_repo as string | undefined;
		if (tr) target_repo_by_name[String(i.name ?? "")] = tr;
	}

	let max_seq = 0;
	for (const i of dag_state.all_issues) {
		const seq = (i.sequence_number as number) ?? 0;
		if (seq > max_seq) max_seq = seq;
	}

	for (const new_issue of decision.new_issues) {
		const name = String(new_issue.name ?? "");
		if (name && !(name in remaining_by_name)) {
			const issue_dict = new_issue as Record<string, unknown>;
			if (!issue_dict.sequence_number) {
				max_seq++;
				issue_dict.sequence_number = max_seq;
			}
			if (!issue_dict.target_repo && dag_state.workspace_manifest) {
				for (const dep of (issue_dict.depends_on as string[]) ?? []) {
					const inherited = target_repo_by_name[dep];
					if (inherited) {
						issue_dict.target_repo = inherited;
						break;
					}
				}
			}
			remaining_by_name[name] = issue_dict;
		}
	}

	const remaining = Object.values(remaining_by_name);

	const new_levels = recompute_levels(remaining, Array.from(completed_names));

	dag_state.all_issues = [
		...dag_state.all_issues.filter(
			(i) =>
				completed_names.has(String(i.name ?? "")) ||
				failed_names.has(String(i.name ?? "")),
		),
		...remaining,
	];
	dag_state.levels = new_levels;
	dag_state.current_level = 0;
	dag_state.replan_count++;
	dag_state.replan_history.push(decision);

	return dag_state;
}

export function _skip_downstream(
	dag_state: DAGState,
	failed: { issue_name: string }[],
): DAGState {
	for (const failure of failed) {
		const downstream = find_downstream(
			failure.issue_name,
			dag_state.all_issues,
		);
		for (const name of downstream) {
			if (!dag_state.skipped_issues.includes(name)) {
				dag_state.skipped_issues.push(name);
			}
		}
	}
	return dag_state;
}

export function _enrich_downstream_with_failure_notes(
	dag_state: DAGState,
	failed: { issue_name: string; error_message?: string }[],
): DAGState {
	for (const failure of failed) {
		const downstream = find_downstream(
			failure.issue_name,
			dag_state.all_issues,
		);
		for (let i = 0; i < dag_state.all_issues.length; i++) {
			const issue = dag_state.all_issues[i];
			if (!issue) continue;
			if (downstream.includes(String(issue.name ?? ""))) {
				const notes = [...((issue.failure_notes ?? []) as string[])];
				notes.push(
					`WARNING: Upstream issue '${failure.issue_name}' failed. Error: ${failure.error_message ?? ""}. ` +
						`It was supposed to provide: ${(issue.depends_on as string[])?.join(", ") ?? ""}. ` +
						`You may need to implement workarounds or stubs for missing functionality.`,
				);
				dag_state.all_issues[i] = { ...issue, failure_notes: notes };
			}
		}
	}
	return dag_state;
}

export { recompute_levels, find_downstream } from "./dag_utils.js";
