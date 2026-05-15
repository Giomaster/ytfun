import assert from "node:assert/strict";
import test from "node:test";
import { parseDurationToSeconds } from "../src/time.js";

test("parseDurationToSeconds handles clocks, raw seconds, and ISO durations", () => {
  assert.equal(parseDurationToSeconds("12"), 12);
  assert.equal(parseDurationToSeconds("00:12"), 12);
  assert.equal(parseDurationToSeconds("01:02:03"), 3723);
  assert.equal(parseDurationToSeconds("PT1H2M3S"), 3723);
});
