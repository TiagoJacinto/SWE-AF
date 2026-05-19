import { is_fatal_error, FatalHarnessError } from "./fatal_error.js";

const ENVELOPE_KEYS = new Set([
	"execution_id",
	"run_id",
	"node_id",
	"type",
	"target",
	"status",
	"duration_ms",
	"timestamp",
	"result",
	"error_message",
	"cost",
]);

function hasEnvelopeKeys(obj: Record<string, unknown>): boolean {
	for (const key of Object.keys(obj)) {
		if (ENVELOPE_KEYS.has(key)) return true;
	}
	return false;
}

export function unwrap_call_result<T = unknown>(
	result: unknown,
	label = "call",
): T {
	if (typeof result !== "object" || result === null) {
		return result as T;
	}

	const dict = result as Record<string, unknown>;

	if (!hasEnvelopeKeys(dict)) {
		return result as T;
	}

	const status = String(dict.status ?? "").toLowerCase();
	if (["failed", "error", "cancelled", "timeout"].includes(status)) {
		const err = (dict.error_message ?? dict.error ?? "unknown") as string;
		if (is_fatal_error(err)) {
			throw new FatalHarnessError(err);
		}
		throw new Error(`${label} failed (status=${status}): ${err}`);
	}

	const inner = dict.result;
	if (inner !== undefined && inner !== null) {
		return inner as T;
	}

	return result as T;
}
