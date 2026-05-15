import assert from "node:assert/strict";
import test from "node:test";
import { loadFirstPartyShortsConfig } from "../src/firstPartyShorts.js";

test("loadFirstPartyShortsConfig validates the example manifest", async () => {
  const config = await loadFirstPartyShortsConfig("examples/first-party-cuts.json");

  assert.equal(config.visualMode, "none");
  assert.equal(config.shorts.length, 2);
  assert.equal(config.shorts[0]?.id, "hook-001");
});
