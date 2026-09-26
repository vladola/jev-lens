/**
 * Cost reporting in `/jev-lens stats`: jev's own calls and tokens are counted as they happen, the rates
 * are the published table unless JEV_LENS_PRICE_* overrides them, and on the OpenRouter gateway the
 * account's real spend comes from the key endpoint instead of arithmetic.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.JEV_LENS_CLASSIFIER = "mock";
process.env.JEV_LENS_MODE = "rolling";
process.env.JEV_LENS_LOG = "0";

const ENV = ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "PI_JEV_BASE_URL", "JEV_LENS_PRICE_IN_PER_M", "JEV_LENS_PRICE_OUT_PER_M", "JEV_LENS_PRICE_PER_CALL"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

afterEach(() => {
	for (const k of ENV) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	vi.unstubAllGlobals();
});

type Handler = (event: any, ctx: any) => Promise<any> | any;

/** Minimal stand-in for pi's ExtensionAPI; `notes` collects everything the UI was told. */
function fakePi() {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, any>();
	const notes: string[] = [];
	const pi = {
		registerTool: () => {},
		on: (event: string, h: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), h]),
		appendEntry: () => {},
		registerCommand: (name: string, def: any) => commands.set(name, def),
	};
	const emit = async (event: string, payload: any, ctx: any) => {
		let result: any;
		for (const h of handlers.get(event) ?? []) result = (await h({ type: event, ...payload }, ctx)) ?? result;
		return result;
	};
	return { pi, emit, commands, notes };
}

function ctxFor(notes: string[]) {
	return {
		cwd: mkdtempSync(join(tmpdir(), "jevcost-")),
		hasUI: false,
		mode: "print",
		signal: undefined,
		ui: { notify: (message: string) => notes.push(message), setStatus() {} },
		sessionManager: { getEntries: () => [], getBranch: () => [] },
	};
}

/** Start the extension with the current environment and return what `/jev-lens stats` prints. */
async function stats() {
	const mod: any = await import("../index.ts");
	const { pi, emit, commands, notes } = fakePi();
	mod.default(pi);
	const ctx = ctxFor(notes);
	await emit("session_start", { reason: "startup" }, ctx);
	await commands.get("jev-lens").handler("stats", ctx);
	return notes.join("\n");
}

describe("cost in /jev-lens stats", () => {
	let mod: any;
	beforeAll(async () => {
		mod = await import("../index.ts");
	});

	it("counts jev's own calls and tokens and prices them with the published rates", async () => {
		delete process.env.TYPESAFE_API_KEY;
		delete process.env.OPENROUTER_API_KEY;
		delete process.env.PI_JEV_BASE_URL;
		for (const k of ["JEV_LENS_PRICE_IN_PER_M", "JEV_LENS_PRICE_OUT_PER_M", "JEV_LENS_PRICE_PER_CALL"]) delete process.env[k];
		expect(mod).toBeDefined();
		const text = await stats();
		expect(text).toContain("cost: 0 jev calls");
		expect(text).toContain("0 in / 0 out tokens ≈ $0 at $0.042/M in, $0/M out");
		// No OpenRouter endpoint configured: nothing is fetched and nothing is claimed about it.
		expect(text).not.toContain("openrouter:");
	});

	it("shows configured rates instead of the published ones", async () => {
		delete process.env.TYPESAFE_API_KEY;
		delete process.env.OPENROUTER_API_KEY;
		delete process.env.PI_JEV_BASE_URL;
		process.env.JEV_LENS_PRICE_IN_PER_M = "1.5";
		process.env.JEV_LENS_PRICE_OUT_PER_M = "0.6";
		process.env.JEV_LENS_PRICE_PER_CALL = "0.0025";
		const text = await stats();
		expect(text).toContain("at $1.5/M in, $0.6/M out, $0.0025/call");
	});

	it("reports OpenRouter's own spend for the key, and only for an OpenRouter endpoint", async () => {
		const urls: string[] = [];
		vi.stubGlobal("fetch", async (url: string) => {
			urls.push(url);
			return { ok: true, json: async () => ({ data: { usage: 114.91, usage_daily: 0.05, usage_weekly: 0.05, usage_monthly: 3.62 } }) };
		});
		process.env.TYPESAFE_API_KEY = "sk-or-test";
		process.env.PI_JEV_BASE_URL = "https://openrouter.ai/api";
		const text = await stats();
		expect(urls).toEqual(["https://openrouter.ai/api/v1/key"]);
		expect(text).toContain("openrouter: key usage $114.9100");
		expect(text).toContain("(today $0.0500, month $3.6200)");
		expect(text).toContain("every request on this key, not only jev");
	});

	it("still prints the estimate when OpenRouter does not answer", async () => {
		vi.stubGlobal("fetch", async () => { throw new Error("offline"); });
		process.env.TYPESAFE_API_KEY = "sk-or-test";
		process.env.PI_JEV_BASE_URL = "https://openrouter.ai/api";
		const text = await stats();
		expect(text).toContain("cost: 0 jev calls");
		expect(text).toContain("openrouter: spend not reported");
	});

	it("does not ask OpenRouter when there is no key", async () => {
		const spy = vi.fn();
		vi.stubGlobal("fetch", spy);
		delete process.env.TYPESAFE_API_KEY;
		delete process.env.OPENROUTER_API_KEY;
		process.env.PI_JEV_BASE_URL = "https://openrouter.ai/api";
		await stats();
		expect(spy).not.toHaveBeenCalled();
	});

	it("totals what this project's log recorded in earlier sessions", async () => {
		delete process.env.TYPESAFE_API_KEY;
		delete process.env.OPENROUTER_API_KEY;
		process.env.JEV_LENS_LOG = "1";
		const { pi, emit, commands, notes } = fakePi();
		mod.default(pi);
		const ctx = ctxFor(notes);
		await emit("session_start", { reason: "startup" }, ctx);
		mkdirSync(join(ctx.cwd, ".pi"), { recursive: true });
		writeFileSync(join(ctx.cwd, ".pi", "jev-lens.log"), [
			JSON.stringify({ t: 1, event: "session_start", mode: "off" }),
			JSON.stringify({ t: 2, event: "jev_call", stage: "choose", in: 1000, out: 10 }),
			JSON.stringify({ t: 3, event: "jev_call", stage: "expand", in: 500, out: 5 }),
			JSON.stringify({ t: 4, event: "usage", input: 999 }),
			JSON.stringify({ t: 5, event: "session_start", mode: "off" }),
			JSON.stringify({ t: 6, event: "jev_call", stage: "choose", in: 3000, out: 30 }),
			"a half-written line",
		].join("\n") + "\n");
		await commands.get("jev-lens").handler("stats", ctx);
		// 4500 input tokens at the published $0.042/M, output free.
		expect(notes.join("\n")).toContain("lifetime (this project's log): 3 jev calls over 2 sessions · 4500 in / 45 out tokens ≈ $0.000189");
	});
});
