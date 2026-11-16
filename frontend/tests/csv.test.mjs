import assert from "node:assert/strict";
import test from "node:test";
import { csvField } from "../src/utils/csv.js";

test("csvField leaves plain text alone and quotes commas, quotes and line breaks", () => {
  assert.equal(csvField("Ada Lovelace"), "Ada Lovelace");
  assert.equal(csvField("a,b"), '"a,b"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField("two\nlines"), '"two\nlines"');
  assert.equal(csvField("a\rb"), '"a\rb"');
  assert.equal(csvField(undefined), "");
});

test("csvField neutralizes leading formula characters", () => {
  for (const lead of ["=", "+", "-", "@", "\t", "\r"]) {
    const field = csvField(`${lead}cmd`);
    assert.ok(field.replace(/^"/, "").startsWith("'"), JSON.stringify(field));
  }
  assert.equal(csvField("=1+1"), "'=1+1");
  assert.equal(csvField('=HYPERLINK("x","y")'), `"'=HYPERLINK(""x"",""y"")"`);
  assert.equal(csvField("a=b"), "a=b");
});

test("csvField can keep a value exact", () => {
  assert.equal(csvField("-abc", { neutralize: false }), "-abc");
  assert.equal(csvField("-a,c", { neutralize: false }), '"-a,c"');
});
