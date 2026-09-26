/**
 * Cost reporting in `/jev-lens stats`: jev's own calls and tokens are counted as they happen, and the money
 * is the provider's own per-call charge whenever it reports one. The rate table is the fallback for a
 * provider that reports tokens without a charge — and it is never a claim about what an API key has spent
 * elsewhere, which is a different question and a much larger number.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

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

/**
 * Start the extension, then plant a log of earlier sessions in this project and ask for stats: what jev has
 * cost here overall comes from those lines, not from the current (empty) session.
 */
async function statsWithLog(lines: string[]) {
	const mod: any = await import("../index.ts");
	const { pi, emit, commands, notes } = fakePi();
	mod.default(pi);
	const ctx = ctxFor(notes);
	await emit("session_start", { reason: "startup" }, ctx);
	mkdirSync(join(ctx.cwd, ".pi"), { recursive: true });
	writeFileSync(join(ctx.cwd, ".pi", "jev-lens.log"), lines.join("\n") + "\n");
	await commands.get("jev-lens").handler("stats", ctx);
	return notes.join("\n");
}

describe("cost in /jev-lens stats", () => {
	let mod: any;
	beforeAll(async () => {
		mod = await import("../index.ts");
	});

	/** One `jev_call` log line, as the meter writes it. */
	const call = (over: Record<string, unknown> = {}) => JSON.stringify({ t: 2, event: "jev_call", stage: "choose", in: 1000, out: 10, ...over });

	it("prices measured tokens with the published rates when the provider reported no charge", async () => {
		delete process.env.TYPESAFE_API_KEY;
		delete process.env.OPENROUTER_API_KEY;
		delete process.env.PI_JEV_BASE_URL;
		for (const k of ["JEV_LENS_PRICE_IN_PER_M", "JEV_LENS_PRICE_OUT_PER_M", "JEV_LENS_PRICE_PER_CALL"]) delete process.env[k];
		expect(mod).toBeDefined();
		const text = await stats();
		expect(text).toContain("cost: 0 jev calls");
		expect(text).toContain("0 in / 0 out tokens · ≈$0 at $0.042/M in, $0/M out");
		// Only what jev's own calls measured is reported: never a key's spend on other traffic.
		expect(text).not.toContain("openrouter");
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

	it("totals what this project's log recorded in earlier sessions", async () => {
		process.env.JEV_LENS_LOG = "1";
		const text = await statsWithLog([
			JSON.stringify({ t: 1, event: "session_start", mode: "off" }),
			call(),
			JSON.stringify({ t: 3, event: "jev_call", stage: "expand", in: 500, out: 5 }),
			JSON.stringify({ t: 4, event: "usage", input: 999 }),
			JSON.stringify({ t: 5, event: "session_start", mode: "off" }),
			JSON.stringify({ t: 6, event: "jev_call", stage: "choose", in: 3000, out: 30 }),
			"a half-written line",
		]);
		// Lines written before the cost was recorded carry no charge, so 4500 input tokens at the published
		// $0.042/M (output free) are priced instead of being dropped.
		expect(text).toContain("lifetime (this project's log): 3 jev calls over 2 sessions · 4500 in / 45 out tokens · ≈$0.000189 at $0.042/M in, $0/M out");
	});

	it("reports the provider's own charge when the calls carry one", async () => {
		process.env.JEV_LENS_LOG = "1";
		const text = await statsWithLog([
			JSON.stringify({ t: 1, event: "session_start", mode: "off" }),
			// Two real calls: 333 and 2283 input tokens, each charged at $0.042/M.
			call({ in: 333, out: 22, usd: 0.000013986, reported: true }),
			call({ t: 3, stage: "expand", in: 2283, out: 22, usd: 0.000095886, reported: true }),
		]);
		const lifetime = text.split("\n").find((line) => line.startsWith("lifetime "))!;
		expect(lifetime).toContain("2 jev calls over 1 sessions · 2616 in / 44 out tokens · $0.00011 charged");
		// Every call in the log carried a charge, so this line quotes no rate at all. (The session line still
		// does: it has no calls yet and nothing to quote a charge from.)
		expect(lifetime).not.toContain("at $0.042/M in");
	});

	it("says how much of a mixed log was charged rather than guessed", async () => {
		process.env.JEV_LENS_LOG = "1";
		const text = await statsWithLog([
			call({ usd: 0.000042, reported: true }),
			call({ t: 3, stage: "classify" }),
		]);
		expect(text).toContain("2 jev calls · 2000 in / 20 out tokens · $0.000084 (1/2 charged, the rest at $0.042/M in)");
	});
});
