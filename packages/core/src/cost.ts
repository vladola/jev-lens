/**
 * What the jev calls themselves cost.
 *
 * Every `systemOne` response carries the tokens it consumed, so the extension can account for its own
 * spend exactly. The rates are a separate question: jev is billed for input tokens only, and TypeSafe
 * publishes $0.042 per million input tokens for jev-latest with output free, which is the default table
 * here. `JEV_LENS_PRICE_IN_PER_M`, `JEV_LENS_PRICE_OUT_PER_M` and `JEV_LENS_PRICE_PER_CALL` override it
 * when a host knows better rates.
 *
 * On the OpenRouter gateway those rates are not what the account is charged (`typesafe/jev-router` is
 * listed there as free), so OpenRouter is asked for its own numbers instead: `GET /v1/key` reports the
 * key's real spend. That figure covers every request the key has made, not only jev, so it is reported
 * as its own line rather than mixed into the estimate.
 */

/** Which step of the pipeline made the call. */
export type JevStage = "choose" | "expand" | "classify";

/** One measured jev call. */
export interface JevUsageSample {
	stage: JevStage;
	/** Input tokens the provider billed. */
	input: number;
	/** Output tokens the provider billed (free on jev, but recorded as reported). */
	output: number;
	/** The model the provider answered with (`model` is echoed on every response). */
	model: string;
	ms: number;
}

/** Receives one sample per jev call. Hosts use it to total and log the extension's own usage. */
export type JevMeter = (sample: JevUsageSample) => void;

/** The part of a `systemOne` response this module reads. */
export interface JevCallResult {
	usage?: { input_tokens?: number; output_tokens?: number };
	model?: string;
}

/**
 * Record one measured call. A provider that omits `usage` still counts as a call, with unknown tokens at
 * zero, so a missing field cannot crash a tool result or silently drop the call from the totals.
 */
export function recordJevCall(meter: JevMeter | undefined, stage: JevStage, result: JevCallResult, ms: number): void {
	if (!meter) return;
	const input = Number(result.usage?.input_tokens ?? 0);
	const output = Number(result.usage?.output_tokens ?? 0);
	meter({
		stage,
		input: Number.isFinite(input) ? input : 0,
		output: Number.isFinite(output) ? output : 0,
		model: typeof result.model === "string" ? result.model : "",
		ms,
	});
}

/** Measured jev consumption, summed over a session or a log span. */
export interface JevTotals {
	calls: number;
	input: number;
	output: number;
}

/** Rates in USD per million tokens, plus an optional flat price per call. */
export interface JevRates {
	inputPerM: number;
	outputPerM: number;
	perCall: number;
}

/**
 * TypeSafe's published rates for jev-latest: input is billed at $0.042 per million tokens and output is
 * free (the model answers with typed probabilities rather than generated text).
 */
export const PUBLISHED_RATES: JevRates = { inputPerM: 0.042, outputPerM: 0, perCall: 0 };

export const RATE_ENV = ["JEV_LENS_PRICE_IN_PER_M", "JEV_LENS_PRICE_OUT_PER_M", "JEV_LENS_PRICE_PER_CALL"] as const;

/** Parse one rate: a finite non-negative number, else undefined. */
function rateOf(raw: string | undefined): number | undefined {
	if (raw === undefined || raw.trim() === "") return undefined;
	const value = Number(raw.trim());
	return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * The published table with any explicitly configured rate applied. A host that is billed differently
 * (a negotiated rate, or a provider that charges for output) sets the variables; an unparseable value
 * is ignored rather than silently priced as zero.
 */
export function resolveRates(env: NodeJS.ProcessEnv = process.env): JevRates {
	return {
		inputPerM: rateOf(env.JEV_LENS_PRICE_IN_PER_M) ?? PUBLISHED_RATES.inputPerM,
		outputPerM: rateOf(env.JEV_LENS_PRICE_OUT_PER_M) ?? PUBLISHED_RATES.outputPerM,
		perCall: rateOf(env.JEV_LENS_PRICE_PER_CALL) ?? PUBLISHED_RATES.perCall,
	};
}

/** True when the configured Jev API root is the OpenRouter gateway, which reports its own spend. */
export function isOpenRouter(baseURL: string | undefined): boolean {
	if (typeof baseURL !== "string" || baseURL.trim() === "") return false;
	try {
		const host = new URL(baseURL.trim()).hostname.toLowerCase();
		return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
	} catch {
		return false;
	}
}

/** What the measured tokens would cost at the given rates. */
export function estimateUsd(totals: JevTotals, rates: JevRates): number {
	return (
		(totals.input / 1_000_000) * rates.inputPerM +
		(totals.output / 1_000_000) * rates.outputPerM +
		totals.calls * rates.perCall
	);
}

/**
 * Money at the scale these numbers live on: a jev decision costs tens of millionths of a dollar, so
 * small amounts keep six decimals instead of collapsing to `$0.00`.
 */
export function formatUsd(usd: number): string {
	if (!Number.isFinite(usd) || usd < 0) return "—";
	if (usd === 0) return "$0";
	if (usd < 0.01) return `$${usd.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
	return `$${usd.toFixed(4)}`;
}

/** What OpenRouter reports for the key behind these calls. */
export interface OpenRouterKeyUsage {
	/** Total spend on the key, USD. */
	usage: number;
	usageDaily: number;
	usageWeekly: number;
	usageMonthly: number;
}

/**
 * OpenRouter's own accounting for the API key: real spend, not an estimate. This is the only cost
 * figure OpenRouter exposes to a normal (non-management) key — per-model and per-day breakdowns need a
 * management key, and the per-generation endpoint needs a generation id the SDK does not return.
 *
 * Fails soft: any error, timeout, or unexpected body yields undefined so stats still print.
 */
export async function fetchOpenRouterKeyUsage(cfg: {
	apiKey?: string;
	baseURL?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}): Promise<OpenRouterKeyUsage | undefined> {
	const { apiKey, baseURL } = cfg;
	if (!apiKey || !baseURL) return undefined;
	const url = `${baseURL.trim().replace(/\/+$/, "")}/v1/key`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), cfg.timeoutMs ?? 3000);
	const onAbort = () => controller.abort();
	cfg.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const res = await fetch(url, {
			headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
			signal: controller.signal,
		});
		if (!res.ok) return undefined;
		const body = (await res.json()) as { data?: Record<string, unknown> };
		const data = body?.data;
		if (!data || typeof data.usage !== "number") return undefined;
		const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
		return {
			usage: data.usage,
			usageDaily: num(data.usage_daily),
			usageWeekly: num(data.usage_weekly),
			usageMonthly: num(data.usage_monthly),
		};
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
		cfg.signal?.removeEventListener("abort", onAbort);
	}
}
