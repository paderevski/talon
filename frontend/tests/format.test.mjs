import assert from "node:assert/strict";
import test from "node:test";
import { formatBlock, formatClassName, formatDollars } from "../src/utils/format.js";

test("formatDollars shows dollars with cents, commas and a sign", () => {
  assert.equal(formatDollars(8.4), "$8.40");
  assert.equal(formatDollars(0), "$0.00");
  assert.equal(formatDollars(-5), "-$5.00"); // an overdrawn personal budget
  assert.equal(formatDollars(100000), "$100,000.00");
  assert.equal(formatDollars("12.5"), "$12.50");
  assert.equal(formatDollars(0.125), "$0.13");
});

test("formatDollars shows a dash for anything that is not an amount", () => {
  for (const value of [null, undefined, "", " ", "abc", NaN, Infinity, true, false, {}, []]) {
    assert.equal(formatDollars(value), "—", JSON.stringify(value));
  }
});

test("formatBlock and formatClassName", () => {
  assert.equal(formatBlock("5"), "Block 5");
  assert.equal(formatBlock(" 5 "), "Block 5");
  assert.equal(formatBlock("5A"), "5A");
  assert.equal(formatBlock(""), "");
  assert.equal(formatBlock(null), "");
  assert.equal(formatClassName("Calculus", "5"), "Calculus · Block 5");
  assert.equal(formatClassName("Legacy", ""), "Legacy");
});
