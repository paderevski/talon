import assert from "node:assert/strict";
import test from "node:test";
import { isPageHidden, logPollDelayMs } from "../src/utils/polling.js";

test("log polling starts at 2 s and slows down while a job is quiet", () => {
  assert.equal(logPollDelayMs(0), 2000);
  assert.equal(logPollDelayMs(4), 2000);
  assert.equal(logPollDelayMs(5), 5000);
  assert.equal(logPollDelayMs(9), 5000);
  assert.equal(logPollDelayMs(10), 10000);
  assert.equal(logPollDelayMs(500), 10000);
});

test("the wait never gets shorter as quiet polls pile up", () => {
  let previous = 0;
  for (let quiet = 0; quiet < 100; quiet += 1) {
    const ms = logPollDelayMs(quiet);
    assert.ok(ms >= previous, `quiet=${quiet}`);
    previous = ms;
  }
});

test("log polling treats missing or odd counts as a fresh start", () => {
  for (const value of [undefined, null, NaN, -3, "x"]) {
    assert.equal(logPollDelayMs(value), 2000, String(value));
  }
});

test("isPageHidden is false where there is no document (tests, server)", () => {
  assert.equal(isPageHidden(), false);
});
