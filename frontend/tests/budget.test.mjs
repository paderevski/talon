import assert from "node:assert/strict";
import test from "node:test";
import { parseAmount } from "../src/utils/budget.js";

test("parseAmount accepts dollars with up to two decimals", () => {
  assert.equal(parseAmount("5"), 5);
  assert.equal(parseAmount(" 2.50 "), 2.5);
  assert.equal(parseAmount(".75"), 0.75);
  assert.equal(parseAmount("100000"), 100000);
});

test("parseAmount refuses zero, negatives, junk, too many decimals and over the limit", () => {
  for (const text of ["", " ", ".", "0", "0.00", "-1", "1e3", "abc", "1.234", "$5", "1,000", "100000.01"]) {
    assert.equal(parseAmount(text), null, `Expected ${JSON.stringify(text)} refused`);
  }
});
