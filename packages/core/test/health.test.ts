import { describe, expect, it } from "vitest";
import { APIError, APIConnectionError, APITimeoutError } from "@typesafe-ai/sdk";
import { describeError, Health } from "../src/health.ts";

describe("session health", () => {
	it("counts repeated failures but warns only once per stage", () => {
		const health = new Health();
		expect(health.failing).toBe(false);
		for (let i = 0; i < 3; i++) health.failure("presend", new Error("secret provider response"));
		expect(health.failing).toBe(true);
		expect(health.warnings()).toHaveLength(1);
		expect(health.warnings()).toEqual([]);
		expect(health.lines()[0]).toContain("3 (last attempt failed)");
		health.success("presend");
		expect(health.failing).toBe(false);
		expect(health.lines()[0]).toContain("a later attempt succeeded");
		health.failure("presend", undefined);
		expect(health.warnings()).toEqual([]);
		health.failure("postsend", undefined);
		expect(health.warnings()).toHaveLength(1);
		health.success("presend");
		expect(health.failing).toBe(true); // post-send still failing
	});

	it.each([[400, "request format"], [401, "API key"], [402, "credits and billing"], [403, "account permissions"], [404, "model and API endpoint"], [408, "timed out"], [422, "request format"], [429, "usage limit"], [500, "server error"], [504, "timed out"], [418, "unexpected HTTP response"]])("gives safe advice for status %s", (status, advice) => {
		const health = new Health();
		health.failure("presend", { status, message: "ts_secret" });
		const text = [...health.warnings(), ...health.lines()].join("\n");
		expect(text).toContain(advice);
		expect(text).toContain(`HTTP ${status}:`);
		expect(text).not.toContain("ts_secret");
	});

	it.each([
		[new APITimeoutError(15000), "Request timed out"],
		[new APIConnectionError("ts_secret"), "Connection failed"],
		[new TypeError("ts_secret"), "TypeError"],
		[new Error("ts_secret"), "Unclassified error"],
	])("distinguishes failures without an HTTP response", (error, advice) => {
		const health = new Health();
		health.failure("presend", error);
		const text = [...health.warnings(), ...health.lines()].join("\n");
		expect(text).toContain(advice);
		expect(text).toContain("no HTTP status");
		expect(text).not.toContain("ts_secret");
	});

	it("names a network-level TypeError through its cause instead of calling it an unknown bug", () => {
		const health = new Health();
		const cause = Object.assign(new Error("getaddrinfo ENOTFOUND openrouter.ai"), { code: "ENOTFOUND" });
		health.failure("presend", Object.assign(new TypeError("fetch failed"), { cause }));
		const text = [...health.warnings(), ...health.lines()].join("\n");
		expect(text).toContain("Connection failed (TypeError → ENOTFOUND).");
		expect(text).not.toContain("unknown");
		expect(text).not.toContain("openrouter.ai"); // the cause's message stays out of what the agent reads
	});

	it("reports an abort as an abort rather than an unknown bug", () => {
		const health = new Health();
		const cause = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
		health.failure("presend", Object.assign(new TypeError("fetch failed"), { cause }));
		expect(health.lines()[0]).toContain("Request aborted");
	});

	it("describes the failure for the log, which is what makes it answerable later", () => {
		const cause = Object.assign(new Error("connect ECONNRESET 203.0.113.5:443"), { code: "ECONNRESET" });
		const detail = describeError(Object.assign(new TypeError("fetch failed"), { cause }));
		expect(detail).toMatchObject({ name: "TypeError", message: "fetch failed", cause: { name: "Error", message: "connect ECONNRESET 203.0.113.5:443", code: "ECONNRESET" } });
		expect(detail.frames?.length).toBeGreaterThan(0);
	});

	it("keeps arbitrary text out of the warning while the log keeps the message", () => {
		const health = new Health();
		health.failure("presend", Object.assign(new TypeError("fetch failed"), { cause: { name: "Error", code: "ts_secret", message: "ts_secret" } }));
		expect(health.lines()[0]).toContain("TypeError"); // an unrecognised code earns no claim
		expect(health.lines()[0]).not.toContain("ts_secret");
		const detail = describeError({ name: "Error", code: "ts_secret", message: "ts_secret" });
		expect(detail.code).toBeUndefined();
		expect(detail.message).toBe("ts_secret");
	});

	it("survives error values that are not ordinary errors", () => {
		const trapped = Object.defineProperty({}, "message", { get() { throw new Error("trap"); } });
		for (const value of [undefined, null, "boom", 42, Symbol("s"), trapped]) expect(() => describeError(value)).not.toThrow();
		expect(describeError("boom")).toMatchObject({ name: "string", message: "boom" });
		expect(describeError(undefined)).toMatchObject({ name: "undefined" });
	});

	it("handles an SDK payment error without exposing its response or headers", () => {
		const health = new Health();
		health.failure("presend", new APIError(402, { message: "ts_secret", input: "private source" }, new Headers({ "x-typesafe-request-id": "private-id" })));
		const text = [...health.warnings(), ...health.lines()].join("\n");
		expect(text).toContain("HTTP 402: Payment required");
		for (const secret of ["ts_secret", "private source", "private-id"]) expect(text).not.toContain(secret);
	});

	it.each(["ts_secret", "402 ts_secret", NaN, Infinity, 402.5, 999])("does not echo malformed status values: %s", (status) => {
		const health = new Health();
		health.failure("presend", { status, name: "ts_secret", message: "ts_secret", body: "ts_secret" });
		const text = [...health.warnings(), ...health.lines()].join("\n");
		expect(text).toContain("Unclassified error");
		expect(text).not.toContain("ts_secret");
	});
});
