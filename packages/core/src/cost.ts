/**
 * What the jev calls themselves cost.
 *
 * Every `systemOne` response carries the tokens it consumed and, on every provider we have seen, the charge
 * for that call as `usage.cost`. That figure is authoritative, so it is what the extension adds up: the
 * tokens are measured, the money is the provider's own number.
 *
 * The rate table below is the fallback for a provider that reports tokens but no charge. jev is billed for
 * input tokens only, TypeSafe publishes $0.042 per million input tokens for jev-latest with output free,
 * and `JEV_LENS_PRICE_IN_PER_M`, `JEV_LENS_PRICE_OUT_PER_M` and `JEV_LENS_PRICE_PER_CALL` override the
 * table when a host knows better rates.
 *
 * A key-wide spend figure (OpenRouter's `GET /v1/key`, for instance) is deliberately unused: it covers every
 * request the key makes, so it says nothing about jev — a key doing other work shows a number larger by
 * orders of magnitude. Measured per call, or not at all.
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
	/** What this call cost, USD: the provider's own figure when it reports one, else priced at the rates. */
	usd: number;
	/** True when `usd` is the provider's figure rather than an estimate. */
	reported: boolean;
	/** The model the provider answered with (`model` is echoed on every response). */
	model: string;
	ms: number;
}

/** Receives one sample per jev call. Hosts use it to total and log the extension's own usage. */
export type JevMeter = (sample: JevUsageSample) => void;

/** The part of a `systemOne` response this module reads. */
export interface JevCallResult {
	usage?: { input_tokens?: number; output_tokens?: number; cost?: number };
	model?: string;
}

/**
 * Record one measured call, priced by the provider when it says what it charged and by the rate table
 * otherwise. A provider that omits `usage` still counts as a call, with unknown tokens at zero, so a
 * missing field cannot crash a tool result or silently drop the call from the totals.
 */
export function recordJevCall(meter: JevMeter | undefined, stage: JevStage, result: JevCallResult, ms: number): void {
	if (!meter) return;
	const input = Number(result.usage?.input_tokens ?? 0);
	const output = Number(result.usage?.output_tokens ?? 0);
	const inTokens = Number.isFinite(input) ? input : 0;
	const outTokens = Number.isFinite(output) ? output : 0;
	const charged = Number(result.usage?.cost);
	const reported = Number.isFinite(charged) && charged >= 0;
	meter({
		stage,
		input: inTokens,
		output: outTokens,
		usd: reported ? charged : estimateUsd({ calls: 1, input: inTokens, output: outTokens }, resolveRates()),
		reported,
		model: typeof result.model === "string" ? result.model : "",
		ms,
	});
}

/** Measured jev consumption and what it cost, summed over a session or a log span. */
export interface JevTotals {
	calls: number;
	input: number;
	output: number;
	/** Total cost in USD: provider-reported figures, plus estimates for calls that came without one. */
	usd: number;
	/** How many calls contributed a provider-reported figure. */
	reported: number;
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

/** What the measured tokens would cost at the given rates. */
export function estimateUsd(totals: Pick<JevTotals, "calls" | "input" | "output">, rates: JevRates): number {
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
