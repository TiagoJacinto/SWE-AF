export function recompute_levels(
	remaining_issues: Record<string, unknown>[],
	completed_names: string[],
): string[][] {
	const name_set = new Set(remaining_issues.map((i) => String(i.name ?? "")));
	const in_degree: Record<string, number> = {};
	const dependents: Record<string, string[]> = {};

	for (const issue of remaining_issues) {
		const name = String(issue.name ?? "");
		in_degree[name] = 0;
	}

	for (const issue of remaining_issues) {
		const name = String(issue.name ?? "");
		for (const dep of (issue.depends_on as string[]) ?? []) {
			if (name_set.has(dep) && !completed_names.includes(dep)) {
				in_degree[name]!++;
				if (!dependents[dep]) dependents[dep] = [];
				dependents[dep].push(name);
			}
		}
	}

	const queue: string[] = [];
	for (const [name, degree] of Object.entries(in_degree)) {
		if (degree === 0) queue.push(name);
	}

	// TypeScript can't infer that in_degree entries are initialized to numbers
	// since we only set them when processing remaining_issues, so we need assertions
	const levels: string[][] = [];
	let processed = 0;

	while (queue.length > 0) {
		const level = [...queue];
		levels.push(level);
		processed += level.length;
		queue.length = 0;

		for (const name of level) {
			const deps = dependents[name] ?? [];
			for (const dep_name of deps) {
				in_degree[dep_name] = (in_degree[dep_name] ?? 0) - 1;
				if (in_degree[dep_name] === 0) {
					queue.push(dep_name);
				}
			}
		}
	}

	if (processed !== remaining_issues.length) {
		const cycle_nodes = Object.entries(in_degree)
			.filter(([, d]) => d > 0)
			.map(([n]) => n);
		throw new Error(
			`Dependency cycle detected among issues: ${cycle_nodes.join(", ")}`,
		);
	}

	return levels;
}

export function find_downstream(
	issue_name: string,
	all_issues: Record<string, unknown>[],
): string[] {
	const dependents: Record<string, string[]> = {};

	for (const issue of all_issues) {
		for (const dep of (issue.depends_on as string[]) ?? []) {
			if (!dependents[dep]) dependents[dep] = [];
			dependents[dep].push(String(issue.name ?? ""));
		}
	}

	const visited = new Set<string>();
	const queue: string[] = [...(dependents[issue_name] ?? [])];

	while (queue.length > 0) {
		const name = queue.shift()!;
		if (visited.has(name)) continue;
		visited.add(name);
		queue.push(...(dependents[name] ?? []));
	}

	return Array.from(visited);
}
