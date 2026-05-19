const FATAL_PATTERNS: RegExp[] = [
	/credit balance is too low/i,
	/insufficient.{0,20}credits?/i,
	/billing.{0,20}(expired|inactive|suspended)/i,
	/invalid.{0,10}api.?key/i,
	/invalid.{0,10}x-api-key/i,
	/(your )?api key is not valid/i,
	/authentication failed/i,
	/account has been disabled/i,
	/account.{0,10}is disabled/i,
	/unauthorized/i,
	/quota.{0,20}exceeded/i,
];

export class FatalHarnessError extends Error {
	original_message: string;

	constructor(message: string) {
		super(`Fatal API error (non-retryable): ${message}`);
		this.name = "FatalHarnessError";
		this.original_message = message;
	}
}

export function is_fatal_error(error_message: string): boolean {
	if (!error_message) return false;
	return FATAL_PATTERNS.some((p) => p.test(error_message));
}

export function check_fatal_harness_error(result: {
	is_error?: boolean;
	error_message?: string;
}): void {
	if (!result.is_error) return;
	const msg = result.error_message ?? "";
	if (is_fatal_error(msg)) {
		throw new FatalHarnessError(msg);
	}
}
