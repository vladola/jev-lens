export type Stage = "presend" | "postsend";

type StageHealth = { failures: number; failing: boolean; reason: string; notified: boolean };

/** One error as data, for the local log. Kept separate from the warning, which stays redacted. */
export interface ErrorDetail {
	name: string;
	message: string;
	status?: number;
	code?: string;
	cause?: { name: string; message: string; code?: string };
	frames?: string[];
}

/** Node and SDK error codes are SCREAMING_CASE; anything else is dropped rather than echoed. */
function codeOf(value: unknown): string | undefined {
	return typeof value === "string" && /^[A-Z][A-Z0-9_.-]{0,39}$/.test(value) ? value : undefined;
}

function fieldOf(value: unknown, max: number): string {
	if (typeof value === "string") return value.slice(0, max);
	if (value === null || value === undefined || typeof value === "object") return "";
	return String(value).slice(0, max);
}

/**
 * Describe an error for the local log: name, message, cause and the first stack frames. The classified sentence
 * alone ("TypeError during compression") is what left a real failure unanswerable afterwards. This never throws,
 * because it runs inside catch blocks, and it never reaches the agent: `warnings()` and `lines()` stay redacted.
 */
export function describeError(error: unknown): ErrorDetail {
	try {
		const e = error && typeof error === "object" ? error as Record<string, unknown> : {};
		const cause = e.cause && typeof e.cause === "object" ? e.cause as Record<string, unknown> : undefined;
		const stack = typeof e.stack === "string" ? e.stack.split("\n").slice(1, 5).map((line) => line.trim().slice(0, 160)).filter(Boolean) : [];
		const detail: ErrorDetail = {
			name: fieldOf(e.name, 40) || (error === null ? "null" : typeof error),
			message: fieldOf(e.message, 300) || fieldOf(error, 300),
		};
		if (typeof e.status === "number") detail.status = e.status;
		const code = codeOf(e.code);
		if (code) detail.code = code;
		if (cause) {
			const causeCode = codeOf(cause.code);
			detail.cause = { name: fieldOf(cause.name, 40) || "Object", message: fieldOf(cause.message, 200), ...(causeCode ? { code: causeCode } : {}) };
		}
		if (stack.length) detail.frames = stack;
		return detail;
	} catch {
		return { name: "UnreadableError", message: "" };
	}
}

/** Report only validated status codes and fixed advice, never raw provider data. */
function failureReason(error: unknown): string {
	const e = error && typeof error === "object" ? error as { status?: unknown; name?: unknown; cause?: { name?: unknown; code?: unknown } } : {};
	const status = typeof e.status === "number" && Number.isInteger(e.status) && e.status >= 100 && e.status <= 599 ? e.status : undefined;
	if (status !== undefined) {
		const advice = status === 402 ? "Payment required. Check your TypeSafe credits and billing at https://console.typesafe.ai."
			: status === 401 ? "Authentication failed. Check your TypeSafe API key."
			: status === 403 ? "Access denied. Check your TypeSafe API key and account permissions."
			: status === 429 ? "TypeSafe rejected the request because of a usage limit. Check your rate limits and quota at https://console.typesafe.ai."
			: status === 400 || status === 422 ? "TypeSafe rejected the request format. Check SDK compatibility and the model configuration."
			: status === 404 ? "TypeSafe could not find the requested resource. Check the model and API endpoint."
			: status === 408 || status === 504 ? "The API request timed out. Retry later."
			: status >= 500 ? "TypeSafe reported a server error. Retry later and check service availability."
			: "TypeSafe returned an unexpected HTTP response. Check service availability and account settings.";
		return `HTTP ${status}: ${advice}`;
	}
	if (e.name === "APITimeoutError" || e.name === "TimeoutError") return "Request timed out (no HTTP status). Check your connection and TypeSafe service availability.";
	if (e.name === "APIConnectionError") return "Connection failed (no HTTP status). Check your network, proxy, and TypeSafe service availability.";
	if (e.name === "TypeSafeError") return "TypeSafe SDK error (no HTTP status). Check SDK compatibility and configuration.";
	// A network-level fetch failure arrives as `TypeError: fetch failed` with the real reason on its cause — that is
	// what a reset connection, a DNS failure or an unreachable host looks like, so name it. No cause, no claim.
	const cause = e.cause;
	if (e.name === "AbortError" || cause?.name === "AbortError") return "Request aborted (no HTTP status).";
	const causeCode = codeOf(cause?.code);
	if (causeCode) return `Connection failed (${typeof e.name === "string" ? e.name : "Error"} → ${causeCode}). Check your network, proxy, and TypeSafe service availability.`;
	if (e.name === "TypeError" || e.name === "RangeError" || e.name === "SyntaxError") return `${e.name} during compression (no HTTP status). The cause is unknown. Report this as a jev-lens bug if it persists.`;
	return "Unclassified error (no HTTP status). The cause is unknown. Report this as a jev-lens bug if it persists.";
}

/** Session-local failure counters. Never expose provider error messages or credentials. */
export class Health {
	private stages: Record<Stage, StageHealth> = {
		presend: { failures: 0, failing: false, reason: "", notified: false },
		postsend: { failures: 0, failing: false, reason: "", notified: false },
	};

	failure(stage: Stage, error: unknown): void {
		const reason = failureReason(error);
		Object.assign(this.stages[stage], { failures: this.stages[stage].failures + 1, failing: true, reason });
	}

	success(stage: Stage): void { this.stages[stage].failing = false; }

	get failing(): boolean { return Object.values(this.stages).some((s) => s.failing); }

	/** At most one warning per stage per session, including work completed without a UI context. */
	warnings(): string[] {
		return (Object.entries(this.stages) as [Stage, StageHealth][]).flatMap(([stage, state]) => {
			if (!state.failures || state.notified) return [];
			state.notified = true;
			const effect = stage === "presend" ? "Full output was kept." : "The affected result was not pruned.";
			return [`jev-lens: ${stage === "presend" ? "Pre-send compression" : "Post-send classification"} failed. ${effect} ${state.reason} See /jev-lens stats. Further failures appear there without repeated warnings.`];
		});
	}

	lines(): string[] {
		return (Object.entries(this.stages) as [Stage, StageHealth][]).map(([stage, state]) =>
			`${stage} failures: ${state.failures}${state.failures ? state.failing ? ` (last attempt failed). ${state.reason}` : " (a later attempt succeeded)" : ""}`);
	}
}
