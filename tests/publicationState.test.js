import test from "node:test";
import assert from "node:assert/strict";
import {
  resolvePublicationState,
  isPublishedStatus,
} from "../utils/publicationState.js";

test("resolvePublicationState rejects scheduling without permission", () => {
  const result = resolvePublicationState({
    statusInput: "scheduled",
    publishAtInput: "2025-01-01T10:00",
    canSchedule: false,
  });
  assert.equal(result.isValid, false);
  assert.ok(result.errors.find((error) => error.code === "forbidden_schedule"));
});

test("resolvePublicationState validates future scheduling", () => {
  const now = new Date("2024-01-01T10:00:00Z");
  const result = resolvePublicationState({
    statusInput: "scheduled",
    publishAtInput: "2024-01-02T12:30",
    canSchedule: true,
    now,
  });
  assert.equal(result.isValid, true);
  assert.equal(result.status, "scheduled");
  assert.ok(result.publishAt);
  const parsed = new Date(result.publishAt);
  assert.ok(parsed.getTime() > now.getTime());
});

test("resolvePublicationState rejects past scheduling", () => {
  const now = new Date("2024-01-01T10:00:00Z");
  const result = resolvePublicationState({
    statusInput: "scheduled",
    publishAtInput: "2023-12-31T23:00",
    canSchedule: true,
    now,
  });
  assert.equal(result.isValid, false);
  assert.ok(result.errors.find((error) => error.code === "publish_at_in_past"));
});

test("isPublishedStatus handles scheduled content", () => {
  const now = new Date("2024-01-01T00:00:00Z");
  assert.equal(isPublishedStatus("published", null, { now }), true);
  assert.equal(
    isPublishedStatus("scheduled", "2024-01-02T00:00:00Z", { now }),
    false,
  );
  assert.equal(
    isPublishedStatus("scheduled", "2023-12-31T23:59:59Z", { now }),
    true,
  );
});
