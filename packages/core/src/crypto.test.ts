import { test } from "node:test";
import assert from "node:assert/strict";
import { decryptSecret, encryptSecret } from "./crypto.js";

test("encrypt/decrypt round trip", () => {
  const secret = "a-long-session-secret";
  const blob = encryptSecret("my-refresh-token", secret);
  assert.notEqual(blob, "my-refresh-token");
  assert.equal(decryptSecret(blob, secret), "my-refresh-token");
});

test("wrong key fails to decrypt", () => {
  const blob = encryptSecret("x", "key-one");
  assert.throws(() => decryptSecret(blob, "key-two"));
});

test("tamper is detected (GCM auth tag)", () => {
  const blob = encryptSecret("x", "k");
  const parts = blob.split(".");
  const bad = [parts[0], parts[1], parts[2], parts[3], Buffer.from("zzzz").toString("base64url")].join(".");
  assert.throws(() => decryptSecret(bad, "k"));
});
