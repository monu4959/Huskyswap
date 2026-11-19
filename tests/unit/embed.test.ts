// embed(): a failed model load is not cached, so the next call tries again.
// The transformers.js pipeline is mocked; no model is downloaded.

import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ pipeline: vi.fn() }));
vi.mock("@huggingface/transformers", () => ({ env: {}, pipeline: h.pipeline }));

const { embed } = await import("@/lib/agent/embed.ts");

describe("embed: model loading", () => {
  it("retries the load after a failure, then keeps the loaded model", async () => {
    const extractor = vi.fn(async (texts: string[]) => ({ tolist: () => texts.map(() => [0.5]) }));
    h.pipeline.mockRejectedValueOnce(new Error("download failed")).mockResolvedValue(extractor);
    await expect(embed(["a"])).rejects.toThrow("download failed");
    expect(await embed(["a", "b"])).toEqual([[0.5], [0.5]]);
    expect(await embed(["c"])).toEqual([[0.5]]);
    expect(h.pipeline).toHaveBeenCalledTimes(2);
  });
});
