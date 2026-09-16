import { test } from "node:test";
import assert from "node:assert/strict";
import { extractCode } from "./client.js";

test("extractCode: from a redirect URL", () => {
  assert.equal(extractCode("appie://login-exit?code=abc123&state=x"), "abc123");
  assert.equal(extractCode("  https://login.ah.nl/x?foo=1&code=A%2FB "), "A/B");
});

test("extractCode: bare code", () => {
  assert.equal(extractCode("justacode"), "justacode");
});

test("extractCode: rejects junk", () => {
  assert.equal(extractCode("no code here"), null);
  assert.equal(extractCode("https://login.ah.nl/secure/oauth/authorize?client_id=appie"), null);
  assert.equal(extractCode(""), null);
});
