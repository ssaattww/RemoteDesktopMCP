import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fixture, FIXTURE_PASSWORD_HASH } from "./fixture.js";
import { hashPassword, verifyPassword } from "../src/hash-password.js";

test("password hash generation and verification remain functional", async () => {
  const hash = await hashPassword("correct-horse-battery");
  assert.match(hash, /^scrypt\$[^$]+\$[^$]+$/);
  assert.equal(await verifyPassword("correct-horse-battery", hash), true);
  assert.equal(await verifyPassword("incorrect-test-password", hash), false);
});

test("fixture reuses a verified test password hash and can skip unused service startup", async () => {
  const f = await fixture({ initializeService: false });
  try {
    assert.equal(f.service.cfg.users[0]?.passwordHash, FIXTURE_PASSWORD_HASH);
    assert.equal(await verifyPassword("correct-horse-battery", FIXTURE_PASSWORD_HASH), true);
    assert.equal(await verifyPassword("incorrect-test-password", FIXTURE_PASSWORD_HASH), false);
    await assert.rejects(readFile(path.join(f.data, "audit.jsonl"), "utf8"), { code: "ENOENT" });
  } finally {
    await f.cleanup();
  }
});
