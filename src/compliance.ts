import { access } from "node:fs/promises";
import { resolve } from "node:path";
import type { ManifestAudit, RightsAsset, RightsManifest } from "./types.js";
import { parseDurationToSeconds } from "./time.js";

const allowedLicenseBases = new Set([
  "owned",
  "licensed",
  "creative_commons",
  "permission",
  "public_domain",
  "fair_use_review",
]);

export async function auditRightsManifest(
  manifest: RightsManifest,
  options: { maxClipSeconds?: number; requireHumanApproval?: boolean; checkFiles?: boolean } = {},
): Promise<ManifestAudit> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const maxClipSeconds = options.maxClipSeconds ?? 12;
  const requireHumanApproval = options.requireHumanApproval ?? true;

  if (!manifest.projectTitle) errors.push("projectTitle is required");
  if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) {
    errors.push("assets must contain at least one clip");
  }

  for (const [index, asset] of (manifest.assets ?? []).entries()) {
    await auditAsset(asset, index, { errors, warnings, maxClipSeconds, requireHumanApproval, checkFiles: options.checkFiles });
  }

  return { ok: errors.length === 0, errors, warnings };
}

async function auditAsset(
  asset: RightsAsset,
  index: number,
  context: {
    errors: string[];
    warnings: string[];
    maxClipSeconds: number;
    requireHumanApproval: boolean;
    checkFiles?: boolean;
  },
): Promise<void> {
  const label = asset.id || `assets[${index}]`;

  if (!asset.id) context.errors.push(`assets[${index}].id is required`);
  if (!asset.localPath) context.errors.push(`${label}: localPath is required`);
  if (!asset.licenseBasis) context.errors.push(`${label}: licenseBasis is required`);
  if (asset.licenseBasis && !allowedLicenseBases.has(asset.licenseBasis)) {
    context.errors.push(`${label}: unsupported licenseBasis "${asset.licenseBasis}"`);
  }
  if (!asset.editorialPurpose || asset.editorialPurpose.trim().length < 20) {
    context.errors.push(`${label}: editorialPurpose must explain why this clip is needed`);
  }
  if (context.requireHumanApproval && !asset.approvedBy) {
    context.errors.push(`${label}: approvedBy is required by this workflow`);
  }

  validateEvidence(asset, label, context.errors, context.warnings);
  validateClipLength(asset, label, context.maxClipSeconds, context.errors, context.warnings);

  if (context.checkFiles && asset.localPath) {
    try {
      await access(resolve(process.cwd(), asset.localPath));
    } catch {
      context.errors.push(`${label}: local file does not exist at ${asset.localPath}`);
    }
  }
}

function validateEvidence(asset: RightsAsset, label: string, errors: string[], warnings: string[]): void {
  switch (asset.licenseBasis) {
    case "owned":
      break;
    case "licensed":
    case "creative_commons":
    case "permission":
    case "public_domain":
      if (!asset.permissionEvidence) {
        errors.push(`${label}: permissionEvidence is required for ${asset.licenseBasis}`);
      }
      break;
    case "fair_use_review":
      if (!asset.fairUseRationale || asset.fairUseRationale.trim().length < 50) {
        errors.push(`${label}: fairUseRationale must document the transformation rationale`);
      }
      if (!asset.reviewedBy) {
        errors.push(`${label}: reviewedBy is required for fair_use_review`);
      }
      warnings.push(`${label}: fair use is case-by-case and can still receive claims`);
      break;
  }

  if (asset.sourceUrl?.includes("youtube.com") && asset.licenseBasis === "owned") {
    warnings.push(`${label}: sourceUrl is YouTube but licenseBasis is owned; confirm this is your channel/content`);
  }
}

function validateClipLength(
  asset: RightsAsset,
  label: string,
  maxClipSeconds: number,
  errors: string[],
  warnings: string[],
): void {
  try {
    const seconds = parseDurationToSeconds(asset.duration);
    if (seconds <= 0) errors.push(`${label}: duration must be greater than zero`);
    if (seconds > maxClipSeconds) {
      warnings.push(`${label}: duration is ${seconds}s, above preferred max ${maxClipSeconds}s`);
    }
  } catch (error) {
    errors.push(`${label}: ${(error as Error).message}`);
  }

  try {
    parseDurationToSeconds(asset.start);
  } catch (error) {
    errors.push(`${label}: invalid start: ${(error as Error).message}`);
  }
}
