import test from "node:test";
import assert from "node:assert/strict";

import { createRateLimiter } from "../middleware/rateLimit.js";

function createMockReq() {
  return { ip: "203.0.113.42", headers: {} };
}

function createMockRes() {
  const headers = new Map();
  return {
    statusCode: null,
    body: null,
    headersSent: false,
    set(header, value) {
      headers.set(header, String(value));
      return this;
    },
    get(header) {
      return headers.get(header);
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(payload) {
      this.headersSent = true;
      this.body = payload;
      return this;
    },
  };
}

test("rate limiter purges expired entries automatically", async () => {
  const windowMs = 50;
  const limiter = createRateLimiter({ windowMs, limit: 1 });
  const hits = limiter._getHitsForTesting();

  const req = createMockReq();
  const res = createMockRes();

  let nextCalled = 0;
  const next = () => {
    nextCalled += 1;
  };

  // First request should be allowed and counted.
  limiter(req, res, next);
  assert.equal(nextCalled, 1);
  assert.equal(res.statusCode, null);
  assert.equal(hits.size, 1);

  // Immediate second request exceeds the limit and should be blocked.
  const resSecond = createMockRes();
  limiter(req, resSecond, next);
  assert.equal(resSecond.statusCode, 429);
  assert.equal(resSecond.get("Retry-After"), "1");
  assert.equal(nextCalled, 1, "next should not be called again once limited");
  assert.equal(hits.size, 1, "entry should still exist until it expires");

  // Wait for the window to expire; the scheduled cleanup should remove the entry.
  await new Promise((resolve) => setTimeout(resolve, windowMs + 30));
  assert.equal(hits.size, 0, "entry should be automatically purged after the window");
});
