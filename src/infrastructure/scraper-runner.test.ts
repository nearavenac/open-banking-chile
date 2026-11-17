import { describe, it, expect, vi } from "vitest";

const close = vi.fn(async () => {});
vi.mock("./browser.js", () => ({
  launchBrowser: vi.fn(async () => ({
    browser: { pages: async () => [], close },
    debugLog: [],
  })),
}));

import { runScraper } from "./scraper-runner.js";

describe("runScraper timeoutMs", () => {
  it("closes the browser and reports an error when the scrape outlives the limit", async () => {
    const result = await runScraper(
      "x",
      { rut: "1", password: "p", timeoutMs: 20 },
      {},
      () => new Promise(() => {}),
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/tiempo máximo/);
    expect(close).toHaveBeenCalled();
  });
});

describe("closeBrowserSafely", () => {
  it("kills the process when close() hangs", async () => {
    const { closeBrowserSafely } = await import("../utils.js");
    const kill = vi.fn(() => true);
    await closeBrowserSafely({ close: () => new Promise<void>(() => {}), process: () => ({ kill }) }, 20);
    expect(kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("does not kill a browser that closes in time", async () => {
    const { closeBrowserSafely } = await import("../utils.js");
    const kill = vi.fn(() => true);
    await closeBrowserSafely({ close: async () => {}, process: () => ({ kill }) }, 50);
    expect(kill).not.toHaveBeenCalled();
  });
});
