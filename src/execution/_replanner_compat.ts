export async function invoke_replanner_compat(
	dag_state: Record<string, unknown>,
	failed_issues: Record<string, unknown>[],
	config: Record<string, unknown>,
	note_fn?: (msg: string, tags?: string[]) => void,
): Promise<Record<string, unknown>> {
	const failed_names = (failed_issues as { issue_name: string }[]).map(
		(f) => f.issue_name,
	);

	if (note_fn) {
		note_fn(
			`Replanning triggered: failed issues = ${failed_names.join(", ")}`,
			["execution", "replan", "start"],
		);
	}

	// Fallback: return abort decision
	const fallback: Record<string, unknown> = {
		action: "abort",
		rationale: "Replanner agent unavailable in TypeScript executor.",
		summary: "Replanner failure — automatic abort.",
		updated_issues: [],
		removed_issue_names: [],
		skipped_issue_names: [],
		new_issues: [],
	};

	if (note_fn) {
		note_fn("Replanner not available — falling back to ABORT", [
			"execution",
			"replan",
			"fallback",
		]);
	}

	return fallback;
}
