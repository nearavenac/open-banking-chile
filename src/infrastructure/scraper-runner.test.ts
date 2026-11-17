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
