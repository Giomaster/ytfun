import assert from "node:assert/strict";
import test from "node:test";
import { auditRightsManifest } from "../src/compliance.js";
import type { RightsManifest } from "../src/types.js";

test("auditRightsManifest accepts approved owned assets", async () => {
  const manifest: RightsManifest = {
    projectTitle: "Owned edit",
    assets: [
      {
        id: "intro",
        localPath: "assets/intro.mp4",
        licenseBasis: "owned",
        start: "00:00:00",
        duration: "00:00:06",
        editorialPurpose: "Introduces the original idea with footage created by the channel.",
        approvedBy: "editor",
      },
    ],
  };

  const audit = await auditRightsManifest(manifest);
  assert.equal(audit.ok, true);
});

test("auditRightsManifest rejects permission assets without evidence", async () => {
  const manifest: RightsManifest = {
    projectTitle: "Permission edit",
    assets: [
      {
        id: "clip",
        localPath: "assets/clip.mp4",
        licenseBasis: "permission",
        start: "00:00:00",
        duration: "00:00:06",
        editorialPurpose: "Supports a specific commentary point in the video.",
        approvedBy: "editor",
      },
    ],
  };

  const audit = await auditRightsManifest(manifest);
  assert.equal(audit.ok, false);
  assert.ok(audit.errors.some((error) => error.includes("permissionEvidence")));
});
