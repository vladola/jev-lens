/**
 * The endpoint and model a host talks to: PI_JEV_BASE_URL / TYPESAFE_BASE_URL select the Jev API root
 * (the OpenRouter gateway serves jev-latest at https://openrouter.ai/api/v1/systemone), and every
 * client goes through createTypeSafeClient so the endpoint cannot be dropped on one code path.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const { ctor } = vi.hoisted(() => ({ ctor: vi.fn() }));

vi.mock("@typesafe-ai/sdk", () => ({
	TypeSafeClient: class {
		constructor(options: unknown) { ctor(options); }
		systemOne() { throw new Error("the mocked client must not be called in this test"); }
	},
}));

import { createTypeSafeClient, JevClassifier } from "../src/classifier.ts";
import { loadConfig } from "../src/config.ts";

const ENV = ["PI_JEV_BASE_URL", "TYPESAFE_BASE_URL", "JEV_LENS_MODEL"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

afterEach(() => {
	for (const k of ENV) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	ctor.mockClear();
});

describe("endpoint and model config", () => {
	it("resolves the Jev API root from PI_JEV_BASE_URL, then TYPESAFE_BASE_URL", () => {
		delete process.env.PI_JEV_BASE_URL;
		delete process.env.TYPESAFE_BASE_URL;
		expect(loadConfig().baseURL).toBeUndefined();

		process.env.TYPESAFE_BASE_URL = "https://typesafe.example";
		expect(loadConfig().baseURL).toBe("https://typesafe.example");

		process.env.PI_JEV_BASE_URL = "https://openrouter.ai/api";
		expect(loadConfig().baseURL).toBe("https://openrouter.ai/api");

		process.env.PI_JEV_BASE_URL = "  ";
		expect(loadConfig().baseURL).toBe("https://typesafe.example");
	});

	it("defaults the jev model to jev-latest", () => {
		delete process.env.JEV_LENS_MODEL;
		expect(loadConfig().model).toBe("jev-latest");

		process.env.JEV_LENS_MODEL = "typesafe/jev-1.13-20260917";
		expect(loadConfig().model).toBe("typesafe/jev-1.13-20260917");
	});
});

describe("createTypeSafeClient", () => {
	it("hands the configured endpoint to the SDK, and omits it when unset", () => {
		createTypeSafeClient({ apiKey: "sk-or-test", baseURL: "https://openrouter.ai/api" });
		expect(ctor).toHaveBeenCalledWith({ apiKey: "sk-or-test", baseURL: "https://openrouter.ai/api" });

		ctor.mockClear();
		createTypeSafeClient({ apiKey: "sk-or-test", baseURL: undefined });
		expect(ctor).toHaveBeenCalledWith({ apiKey: "sk-or-test" });
	});

	it("is the single construction path for both classifiers", () => {
		ctor.mockClear();
		new JevClassifier({ apiKey: "k", model: "jev-latest", baseURL: "https://openrouter.ai/api" });
		expect(ctor).toHaveBeenCalledWith({ apiKey: "k", baseURL: "https://openrouter.ai/api" });
	});
});
