import { test } from "node:test";
import assert from "node:assert/strict";
import { updateBannerModel } from "../update-ui.js";

test("updateBannerModel shows an actionable available update", () => {
  const model = updateBannerModel({
    status: "available",
    localRef: "be13e53",
    remoteRef: "63d528c",
    message: "Update available",
  });

  assert.equal(model.visible, true);
  assert.equal(model.canUpdate, true);
  assert.equal(model.title, "Update available");
  assert.match(model.detail, /be13e53 -> 63d528c/);
});

test("updateBannerModel warns when local changes block auto update", () => {
  const model = updateBannerModel({
    status: "dirty",
    message: "Local changes present; automatic update is disabled",
  });

  assert.equal(model.visible, true);
  assert.equal(model.canUpdate, false);
  assert.equal(model.title, "Update check needs attention");
  assert.match(model.detail, /Local changes present/);
});

test("updateBannerModel hides current or absent update state", () => {
  assert.equal(updateBannerModel(null).visible, false);
  assert.equal(updateBannerModel({ status: "current" }).visible, false);
});
