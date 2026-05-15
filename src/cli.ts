#!/usr/bin/env node
import { auditRightsManifest } from "./compliance.js";
import { loadScopeConfig } from "./config.js";
import { buildEditPlan, compileManifest } from "./compiler.js";
import { createDemoVideo } from "./demo.js";
import { readJsonFile, writeJsonFile, writeTextFile } from "./io.js";
import { buildDiscoveryOutput, buildShortlist, draftScript } from "./orchestrator.js";
import { createViralFailsDemo } from "./viralFailsDemo.js";
import { discoverFromYouTube } from "./youtube.js";
import { createRealCaseDemo } from "./realCaseDemo.js";
import { createFirstPartyShorts, loadFirstPartyShortsConfig } from "./firstPartyShorts.js";
import { authenticateYouTubeUpload, publishYouTubeQueue } from "./youtubePublish.js";
import { loadThumbnailConfig, renderThumbnails } from "./thumbnails.js";
import type { DiscoveryOutput, RightsManifest, ShortlistOutput } from "./types.js";

type Args = Record<string, string | boolean>;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  try {
    switch (command) {
      case "discover":
        await discover(args);
        break;
      case "shortlist":
        await shortlist(args);
        break;
      case "draft-script":
        await draft(args);
        break;
      case "audit-manifest":
        await auditManifest(args);
        break;
      case "compile":
        await compile(args);
        break;
      case "edit-plan":
        await editPlan(args);
        break;
      case "demo-video":
        await demoVideo(args);
        break;
      case "viral-fails-demo":
        await viralFailsDemo(args);
        break;
      case "real-case-demo":
        await realCaseDemo(args);
        break;
      case "shorts-from-original":
        await shortsFromOriginal(args);
        break;
      case "youtube-auth":
        await youtubeAuth(args);
        break;
      case "publish-queue":
        await publishQueue(args);
        break;
      case "thumbnail":
        await thumbnail(args);
        break;
      case "help":
      case undefined:
        printHelp();
        break;
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}

async function discover(args: Args): Promise<void> {
  const scopePath = stringArg(args, "scope");
  const outPath = stringArg(args, "out", "data/discoveries.json");
  const config = await loadScopeConfig(scopePath);
  const candidates = await discoverFromYouTube(config);
  const output = buildDiscoveryOutput(config, candidates);
  await writeJsonFile(outPath, output);
  console.log(`Wrote ${output.candidates.length} candidates to ${outPath}`);
}

async function shortlist(args: Args): Promise<void> {
  const scopePath = stringArg(args, "scope");
  const discoveriesPath = stringArg(args, "discoveries");
  const outPath = stringArg(args, "out", "data/shortlist.json");
  const config = await loadScopeConfig(scopePath);
  const discoveries = await readJsonFile<DiscoveryOutput>(discoveriesPath);
  const output = buildShortlist(config, discoveries);
  await writeJsonFile(outPath, output);
  console.log(`Wrote ${output.candidates.length} shortlisted candidates to ${outPath}`);
}

async function draft(args: Args): Promise<void> {
  const shortlistPath = stringArg(args, "shortlist");
  const outPath = stringArg(args, "out", "data/script.md");
  const shortlist = await readJsonFile<ShortlistOutput>(shortlistPath);
  await writeTextFile(outPath, draftScript(shortlist));
  console.log(`Wrote script draft to ${outPath}`);
}

async function auditManifest(args: Args): Promise<void> {
  const manifestPath = stringArg(args, "manifest");
  const manifest = await readJsonFile<RightsManifest>(manifestPath);
  const audit = await auditRightsManifest(manifest, { checkFiles: Boolean(args["check-files"]) });
  printAudit(audit.errors, audit.warnings);
  if (!audit.ok) process.exitCode = 1;
}

async function editPlan(args: Args): Promise<void> {
  const manifestPath = stringArg(args, "manifest");
  const outPath = stringArg(args, "out", "data/edit-plan.json");
  const videoOut = stringArg(args, "video-out", "data/final.mp4");
  const manifest = await readJsonFile<RightsManifest>(manifestPath);
  const audit = await auditRightsManifest(manifest);
  printAudit(audit.errors, audit.warnings);
  if (!audit.ok) {
    process.exitCode = 1;
    return;
  }
  await writeJsonFile(outPath, buildEditPlan(manifest, videoOut));
  console.log(`Wrote edit plan to ${outPath}`);
}

async function compile(args: Args): Promise<void> {
  const manifestPath = stringArg(args, "manifest");
  const outPath = stringArg(args, "out", "data/final.mp4");
  const manifest = await readJsonFile<RightsManifest>(manifestPath);
  const plan = await compileManifest(manifest, outPath);
  await writeJsonFile("data/last-edit-plan.json", plan);
  console.log(`Compiled ${plan.clips.length} clips to ${outPath}`);
}

async function demoVideo(args: Args): Promise<void> {
  const outPath = stringArg(args, "out", "data/demo/ytfun-scoring-demo.mp4");
  const plan = await createDemoVideo(outPath);
  console.log(`Created demo video with ${plan.clips.length} owned clips at ${outPath}`);
}

async function viralFailsDemo(args: Args): Promise<void> {
  const outPath = stringArg(args, "out", "data/cases/cassetadas-viral/cassetadas-viral-demo.mp4");
  const result = await createViralFailsDemo(outPath);
  if (!result.audit.ok) {
    printAudit(result.audit.errors, result.audit.warnings);
    process.exitCode = 1;
    return;
  }
  printAudit(result.audit.errors, result.audit.warnings);
  console.log(`Created 2-minute viral fails demo at ${outPath}`);
}

async function realCaseDemo(args: Args): Promise<void> {
  const outPath = stringArg(args, "out", "data/cases/real-cassetadas/real-cassetadas-demo.mp4");
  const visuals = stringArg(args, "visuals", "none");
  if (visuals !== "none" && visuals !== "minimal") {
    throw new Error("--visuals must be either none or minimal");
  }
  const result = await createRealCaseDemo(outPath, { visualMode: visuals });
  if (!result.audit.ok) {
    printAudit(result.audit.errors, result.audit.warnings);
    process.exitCode = 1;
    return;
  }
  printAudit(result.audit.errors, result.audit.warnings);
  console.log(`Created real licensed-footage case at ${outPath}`);
}

async function shortsFromOriginal(args: Args): Promise<void> {
  const configPath = stringArg(args, "config");
  const outDir = stringArg(args, "out-dir", "data/shorts");
  const config = await loadFirstPartyShortsConfig(configPath);
  const result = await createFirstPartyShorts(config, outDir);
  console.log(`Created ${result.output.shorts.length} first-party Shorts in ${outDir}`);
}

async function youtubeAuth(args: Args): Promise<void> {
  const clientSecretPath = stringArg(args, "client-secret", "config/youtube-oauth-client.json");
  const tokenPath = stringArg(args, "token", "data/youtube-token.json");
  const redirectUri = typeof args["redirect-uri"] === "string" ? args["redirect-uri"] : undefined;
  const port = typeof args.port === "string" ? Number(args.port) : undefined;
  await authenticateYouTubeUpload({ clientSecretPath, tokenPath, redirectUri, port });
  console.log(`Saved YouTube OAuth token to ${tokenPath}`);
}

async function publishQueue(args: Args): Promise<void> {
  const queuePath = stringArg(args, "queue");
  const clientSecretPath = stringArg(args, "client-secret", "config/youtube-oauth-client.json");
  const tokenPath = stringArg(args, "token", "data/youtube-token.json");
  const outPath = stringArg(args, "out", "data/youtube-publish-results.json");
  const redirectUri = typeof args["redirect-uri"] === "string" ? args["redirect-uri"] : undefined;
  const execute = Boolean(args.execute);
  const allowPublic = Boolean(args["allow-public"]);
  const results = await publishYouTubeQueue({
    queuePath,
    clientSecretPath,
    tokenPath,
    outPath,
    execute,
    allowPublic,
    redirectUri,
  });
  const mode = execute ? "Uploaded" : "Dry run wrote";
  console.log(`${mode} ${results.length} YouTube publish result(s) to ${outPath}`);
}

async function thumbnail(args: Args): Promise<void> {
  const configPath = stringArg(args, "config", "examples/thumbnail.json");
  const outDir = stringArg(args, "out-dir", "data/thumbnails");
  const config = await loadThumbnailConfig(configPath);
  const output = await renderThumbnails(config, outDir);
  console.log(`Generated ${output.files.length} thumbnail(s) in ${outDir}`);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function stringArg(args: Args, name: string, fallback?: string): string {
  const value = args[name] ?? fallback;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`--${name} is required`);
  }
  return value;
}

function printAudit(errors: string[], warnings: string[]): void {
  if (errors.length === 0 && warnings.length === 0) {
    console.log("Manifest audit passed.");
    return;
  }
  for (const warning of warnings) console.warn(`warning: ${warning}`);
  for (const error of errors) console.error(`error: ${error}`);
}

function printHelp(): void {
  console.log(`ytfun

Commands:
  discover       --scope examples/scope.json --out data/discoveries.json
  shortlist      --scope examples/scope.json --discoveries data/discoveries.json --out data/shortlist.json
  draft-script   --shortlist data/shortlist.json --out data/script.md
  audit-manifest --manifest examples/rights-manifest.json [--check-files]
  edit-plan      --manifest examples/rights-manifest.json --out data/edit-plan.json --video-out data/final.mp4
  compile        --manifest examples/rights-manifest.json --out data/final.mp4
  demo-video     --out data/demo/ytfun-scoring-demo.mp4
  viral-fails-demo --out data/cases/cassetadas-viral/cassetadas-viral-demo.mp4
  real-case-demo --out data/cases/real-cassetadas/real-cassetadas-demo.mp4 [--visuals none|minimal]
  shorts-from-original --config examples/first-party-cuts.json --out-dir data/shorts/example
  youtube-auth --client-secret config/youtube-oauth-client.json --token data/youtube-token.json
  publish-queue --queue examples/youtube-publish-queue.json --out data/youtube-publish-results.json [--execute]
  thumbnail --config examples/thumbnail.json --out-dir data/thumbnails/example
`);
}

await main();
