import test from "node:test";
import assert from "node:assert/strict";
import { escapeHtml } from "../src/popup/helpers";

test("escapeHtml escapes html-sensitive characters", () => {
  assert.equal(
    escapeHtml(`a&b<c>"d"'e`),
    "a&amp;b&lt;c&gt;&quot;d&quot;&#39;e"
  );
});

test("escapeHtml tolerates undefined and null values", () => {
  assert.equal(escapeHtml(undefined), "");
  assert.equal(escapeHtml(null), "");
});

test("escapeHtml coerces non-string values safely", () => {
  assert.equal(escapeHtml(123), "123");
  assert.equal(escapeHtml(false), "false");
});
