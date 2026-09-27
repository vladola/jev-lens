/**
 * Staying out of the way.
 *
 * The extension sits on the critical path of every large tool result, so when it cannot do its job well it must do
 * nothing at all: no view, no footer, no counters, no status text. Two cases are covered here — no key (the mock is
 * a deliberate tool for tests and dry runs, not a stand-in to compress with), and a decision that outruns the wait
 * budget (a slow provider must not make the agent wait out the SDK timeout). A failing provider still fails open and
 * is retried on the next result; only the wait is capped.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension from "../index.ts";
import { JevPresend, MockClassifier, MockPresend } from "jev-lens";

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "jev-passthrough-")); dirs.push(dir); return dir; };

function harness() {
	const handlers = new Map<string, any[]>(), entries: any[] = [], tools = new Map<string, any>(), commands = new Map<string, any>();
	extension({ on: (n: string, h: any) => handlers.set(n, [...(handlers.get(n) ?? []), h]), registerTool: (t: any) => tools.set(t.name, t), registerCommand: (name: string, def: any) => commands.set(name, def), appendEntry: (customType: string, data: any) => entries.push({ customType, data }) } as any);
	const ctx = { cwd: temp(), hasUI: false, sessionManager: { getEntries: () => [], getBranch: () => [] } };
	const emit = async (n: string, event: any = {}, context = ctx) => {
		let returned: any;
		for (const h of handlers.get(n) ?? []) returned = (await h(event, context)) ?? returned;
		return returned;
	};
	return { emit, ctx, entries, tools, commands };
}
const ui = (h: ReturnType<typeof harness>) => ({ ...h.ctx, hasUI: true, ui: { notify: vi.fn(), setStatus: vi.fn() } });
const stats = async (h: ReturnType<typeof harness>, ctx: any) => {
	await h.commands.get("jev-lens").handler("stats", ctx);
	return ctx.ui.notify.mock.lastCall?.[0] as string;
};
/** A read result with real candidate views, so the pre-send path runs for real. */
const code = readFileSync(new URL("../../../eval/fixture/src/categories.js", import.meta.url), "utf8");
const event = { toolName: "read", toolCallId: "r", input: { path: "a.js" }, content: [{ type: "text", text: code }], isError: false };

beforeEach(() => {
	vi.stubEnv("JEV_LENS_CLASSIFIER", ""); // the mock is opt-in; these tests never assume it
	vi.stubEnv("JEV_LENS_MODE", "off");
	vi.stubEnv("JEV_LENS_VARIANT", "");
	vi.stubEnv("JEV_LENS_UI", "0");
	vi.stubEnv("JEV_LENS_LOG", "0");
	vi.stubEnv("JEV_LENS_PRESEND_WAIT_MS", "60000");
	vi.stubEnv("TYPESAFE_API_KEY", "");
	vi.stubEnv("OPENROUTER_API_KEY", "");
	vi.stubEnv("JEV_LENS_KEY_FILE", join(temp(), "absent.json")); // never read the developer's real stored key
});
afterEach(() => {
	vi.restoreAllMocks(); vi.unstubAllEnvs();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("no key", () => {
	it("does nothing at all, exactly as if it were not installed", async () => {
		const h = harness(), ctx = ui(h);
		await h.emit("session_start", {}, ctx);
		expect(await h.emit("tool_result", event, ctx)).toBeUndefined();
		expect(ctx.ui.notify).not.toHaveBeenCalled(); // no warning: there is nothing to report
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("jev-lens", undefined); // no tag either
		const s = await stats(h, ctx);
		expect(s).toContain("classifier=inactive (no API key");
		expect(s).toContain("0/0 large results compressed");
		expect(s).toContain("presend failures: 0");
	});
	it("does not classify after the fact either", async () => {
		vi.stubEnv("JEV_LENS_MODE", "rolling");
		const classify = vi.spyOn(MockClassifier.prototype, "classifyToolResult");
		const h = harness();
		await h.emit("session_start");
		await h.emit("turn_end", { toolResults: [event] });
		await h.emit("agent_end");
		expect(classify).not.toHaveBeenCalled();
	});
	it("turns on without a restart once a key is stored", async () => {
		const choose = vi.spyOn(JevPresend.prototype, "choose").mockResolvedValue({ choice: "full", probabilities: { full: 1 }, needsFull: 1, confidence: 1 });
		const h = harness(), ctx = ui(h);
		await h.emit("session_start", {}, ctx);
		expect(await stats(h, ctx)).toContain("inactive");
		await h.commands.get("jev-lens").handler("key sk-not-a-real-key", ctx);
		expect(await stats(h, ctx)).not.toContain("inactive");
		await h.emit("tool_result", event, ctx);
		expect(choose).toHaveBeenCalled();
	});
});

describe("wait budget", () => {
	it("passes the result through, aborts the request, and does not call it a failure", async () => {
		vi.stubEnv("JEV_LENS_CLASSIFIER", "mock");
		vi.stubEnv("JEV_LENS_PRESEND_WAIT_MS", "60");
		let seen: AbortSignal | undefined;
		vi.spyOn(MockPresend.prototype, "choose").mockImplementation((_s: any, _k: any, signal?: AbortSignal) => { seen = signal; return new Promise(() => {}) as never; });
		const h = harness(), ctx = ui(h);
		await h.emit("session_start", {}, ctx);
		expect(await h.emit("tool_result", event, ctx)).toBeUndefined(); // the full text goes through
		expect(seen?.aborted).toBe(true); // the request was abandoned, not left running
		expect(ctx.ui.notify).not.toHaveBeenCalled(); // a slow provider is not an error to report
		const s = await stats(h, ctx);
		expect(s).toContain("1 passed through past the 60ms wait budget");
		expect(s).toContain("presend failures: 0");
	});
	it("fails open and keeps trying after a provider error", async () => {
		vi.stubEnv("JEV_LENS_CLASSIFIER", "mock");
		const choose = vi.spyOn(MockPresend.prototype, "choose").mockRejectedValue({ status: 500, message: "boom" });
		const h = harness(), ctx = ui(h);
		await h.emit("session_start", {}, ctx);
		expect(await h.emit("tool_result", event, ctx)).toBeUndefined();
		expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
		expect(ctx.ui.notify.mock.calls[0][0]).toContain("Full output was kept");
		choose.mockResolvedValue({ choice: "full", probabilities: { full: 1 }, needsFull: 1, confidence: 1 });
		await h.emit("tool_result", event, ctx);
		expect(choose).toHaveBeenCalledTimes(2); // retried rather than standing down
		expect(await stats(h, ctx)).toContain("presend failures: 1 (a later attempt succeeded)");
	});
	it("records what actually failed, because the warning is not allowed to say", async () => {
		vi.stubEnv("JEV_LENS_CLASSIFIER", "mock");
		vi.stubEnv("JEV_LENS_LOG", ""); // the log is where the raw error is kept
		const h = harness(), ctx = ui(h);
		const cause = Object.assign(new Error("getaddrinfo ENOTFOUND openrouter.ai"), { code: "ENOTFOUND" });
		vi.spyOn(MockPresend.prototype, "choose").mockRejectedValue(Object.assign(new TypeError("fetch failed"), { cause }));
		await h.emit("session_start", {}, ctx);
		expect(await h.emit("tool_result", event, ctx)).toBeUndefined();
		const entries = readFileSync(join(h.ctx.cwd, ".pi", "jev-lens.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
		const failure = entries.find((e) => e.event === "presend_error");
		expect(failure).toMatchObject({ tool: "read", detail: { name: "TypeError", message: "fetch failed", cause: { name: "Error", message: "getaddrinfo ENOTFOUND openrouter.ai", code: "ENOTFOUND" } } });
		expect(typeof failure.ms).toBe("number");
		// And the user hears the cause rather than "report this as a bug".
		expect(ctx.ui.notify.mock.calls[0][0]).toContain("Connection failed (TypeError → ENOTFOUND)");
	});
});
