/**
 * What the jev calls cost: the SDK reports tokens on every response, the rates come from TypeSafe's
 * published table unless JEV_LENS_PRICE_* overrides them, and on the OpenRouter gateway the account's
 * real spend is fetched from the key endpoint instead of being estimated.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const { client } = vi.hoisted(() => ({ client: { calls: [] as any[], result: undefined as any } }));

vi.mock("@typesafe-ai/sdk", () => ({
	TypeSafeClient: class {
		constructor(options: unknown) { client.calls.push(options); }
		systemOne() { return Promise.resolve(client.result); }
	},
}));

import {
	estimateUsd, fetchOpenRouterKeyUsage, formatUsd, isOpenRouter, JevClassifier, JevPresend, PUBLISHED_RATES,
	recordJevCall, resolveRates, type JevUsageSample,
} from "../src/index.ts";

const totals = (input: number, output: number, calls = 1) => ({ calls, input, output });

afterEach(() => {
	vi.unstubAllGlobals();
	client.calls = [];
});

describe("rates", () => {
	it("defaults to the published table: input billed, output free, no per-call fee", () => {
		expect(resolveRates({})).toEqual(PUBLISHED_RATES);
		expect(resolveRates({})).toEqual({ inputPerM: 0.042, outputPerM: 0, perCall: 0 });
	});

	it("honours explicit overrides and ignores a value that is not a rate", () => {
		expect(resolveRates({ JEV_LENS_PRICE_IN_PER_M: "1.5", JEV_LENS_PRICE_OUT_PER_M: "0.6", JEV_LENS_PRICE_PER_CALL: "0.0025" }))
			.toEqual({ inputPerM: 1.5, outputPerM: 0.6, perCall: 0.0025 });
		// A typo must not silently price jev at zero.
		expect(resolveRates({ JEV_LENS_PRICE_IN_PER_M: "free", JEV_LENS_PRICE_OUT_PER_M: "-2", JEV_LENS_PRICE_PER_CALL: "   " }))
			.toEqual(PUBLISHED_RATES);
	});
});

describe("estimateUsd", () => {
	it("prices measured tokens", () => {
		expect(estimateUsd(totals(1_000_000, 500_000), PUBLISHED_RATES)).toBeCloseTo(0.042, 10);
		// A realistic decision: ~800 input tokens, output free.
		expect(estimateUsd(totals(800, 20), PUBLISHED_RATES)).toBeCloseTo(0.0000336, 12);
	});

	it("prices output when the rates say so, and adds a per-call fee when configured", () => {
		expect(estimateUsd(totals(0, 1_000_000), { inputPerM: 0, outputPerM: 3, perCall: 0 })).toBeCloseTo(3, 10);
		expect(estimateUsd(totals(0, 0, 2), { inputPerM: 0, outputPerM: 0, perCall: 0.0025 })).toBeCloseTo(0.005, 10);
	});
});

describe("formatUsd", () => {
	it("keeps enough decimals for amounts this small", () => {
		expect(formatUsd(0)).toBe("$0");
		expect(formatUsd(0.0000336)).toBe("$0.000034");
		expect(formatUsd(0.0017)).toBe("$0.0017");
		expect(formatUsd(114.91120215)).toBe("$114.9112");
	});
});

describe("isOpenRouter", () => {
	it("recognises the gateway however the root is written", () => {
		for (const url of ["https://openrouter.ai", "https://openrouter.ai/api", "https://openrouter.ai/api/", "  https://openrouter.ai/api  "]) {
			expect(isOpenRouter(url), url).toBe(true);
		}
	});

	it("does not mistake another host for it, and tolerates nonsense", () => {
		for (const url of ["https://api.typesafe.ai", "https://openrouter.ai.example.com/api", "not a url", "", undefined]) {
			expect(isOpenRouter(url), String(url)).toBe(false);
		}
	});
});

describe("recordJevCall", () => {
	it("passes one sample per call through, counting a response that omits usage", () => {
		const seen: JevUsageSample[] = [];
		recordJevCall((s) => seen.push(s), "classify", { model: "jev-latest", usage: { input_tokens: 10, output_tokens: 2 } }, 5);
		recordJevCall((s) => seen.push(s), "choose", {}, 7);
		expect(seen).toEqual([
			{ stage: "classify", input: 10, output: 2, model: "jev-latest", ms: 5 },
			{ stage: "choose", input: 0, output: 0, model: "", ms: 7 },
		]);
	});

	it("does nothing without a meter", () => {
		expect(() => recordJevCall(undefined, "choose", { usage: { input_tokens: 1, output_tokens: 1 } }, 1)).not.toThrow();
	});
});

describe("metering the pipeline", () => {
	it("reports the pre-send choice with its stage, tokens and model", async () => {
		const seen: JevUsageSample[] = [];
		const fake = {
			systemOne: async () => ({
				model: "jev-latest",
				usage: { input_tokens: 900, output_tokens: 12 },
				answers: { view: { choice: "outline", probabilities: { outline: 1 }, confidence: 1 }, needs_full: { noul: 0.2 } },
			}),
		};
		const presend = new JevPresend(fake as never, "jev-latest", undefined, (s) => seen.push(s));
		const answer = await presend.choose({} as never, ["outline", "full"]);
		expect(answer.choice).toBe("outline");
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ stage: "choose", input: 900, output: 12, model: "jev-latest" });
	});

	it("reports the expansion step separately, so a two-call decision is visible", async () => {
		const seen: JevUsageSample[] = [];
		const fake = { systemOne: async () => ({ usage: { input_tokens: 400, output_tokens: 4 }, answers: { b0: { noul: 0.9 } } }) };
		const presend = new JevPresend(fake as never, "jev-latest", undefined, (s) => seen.push(s));
		await presend.expand({ blocks: [{ name: "f", from: 1, to: 2 }], file: { kind: "code" } } as never, ["outline"] as never);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ stage: "expand", input: 400, output: 4 });
	});

	it("reports post-send classification through the same client path", async () => {
		client.result = { model: "jev-latest", usage: { input_tokens: 1200, output_tokens: 8 }, answers: { needed: { noul: 0.3 }, outcome_only: { noul: 0.8 } } };
		const seen: JevUsageSample[] = [];
		const classifier = new JevClassifier({ apiKey: "sk-or-test", model: "jev-latest", baseURL: undefined }, (s) => seen.push(s));
		const p = await classifier.classifyToolResult({} as never);
		expect(p).toEqual({ needed: 0.3, outcomeOnly: 0.8 });
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ stage: "classify", input: 1200, output: 8, model: "jev-latest" });
	});
});

describe("OpenRouter's own numbers", () => {
	it("asks the key endpoint and returns what OpenRouter reports", async () => {
		const calls: { url: string; init: any }[] = [];
		vi.stubGlobal("fetch", async (url: string, init: any) => {
			calls.push({ url, init });
			return { ok: true, json: async () => ({ data: { usage: 114.91, usage_daily: 0.05, usage_weekly: 0.05, usage_monthly: 3.62 } }) };
		});
		const usage = await fetchOpenRouterKeyUsage({ apiKey: "sk-or-test", baseURL: "https://openrouter.ai/api" });
		expect(usage).toEqual({ usage: 114.91, usageDaily: 0.05, usageWeekly: 0.05, usageMonthly: 3.62 });
		expect(calls[0].url).toBe("https://openrouter.ai/api/v1/key");
		expect(calls[0].init.headers.Authorization).toBe("Bearer sk-or-test");
	});

	it("returns nothing instead of throwing when the endpoint fails or answers oddly", async () => {
		vi.stubGlobal("fetch", async () => ({ ok: false, json: async () => ({}) }));
		expect(await fetchOpenRouterKeyUsage({ apiKey: "k", baseURL: "https://openrouter.ai/api" })).toBeUndefined();
		vi.stubGlobal("fetch", async () => { throw new Error("offline"); });
		expect(await fetchOpenRouterKeyUsage({ apiKey: "k", baseURL: "https://openrouter.ai/api" })).toBeUndefined();
		vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({ data: { no_usage: true } }) }));
		expect(await fetchOpenRouterKeyUsage({ apiKey: "k", baseURL: "https://openrouter.ai/api" })).toBeUndefined();
	});

	it("does nothing at all without a key or an endpoint", async () => {
		const spy = vi.fn();
		vi.stubGlobal("fetch", spy);
		expect(await fetchOpenRouterKeyUsage({ baseURL: "https://openrouter.ai/api" })).toBeUndefined();
		expect(await fetchOpenRouterKeyUsage({ apiKey: "k" })).toBeUndefined();
		expect(spy).not.toHaveBeenCalled();
	});
});
