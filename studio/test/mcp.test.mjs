import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('stdio MCP negotiates, lists tools and persists a series across restarts', { timeout: 15_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ytfun-mcp-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../src/mcp.mjs', import.meta.url));
  const privateEnv = join(directory, 'private.env');
  await writeFile(privateEnv, `YTFUN_STUDIO_DIR=${directory}\nYTFUN_REMOTE_ASSEMBLY_ONLY=true\n`, { mode: 0o600 });
  const connect = async () => {
    const client = new Client({ name: 'ci-studio-client', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [script], env: { PATH: process.env.PATH ?? '', YTFUN_PRIVATE_ENV_FILE: privateEnv }, stderr: 'pipe' }));
    return client;
  };
  const client = await connect();
  t.after(() => client.close());
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 45);
  const reviewSchema = tools.tools.find(tool => tool.name === 'ytfun_episode_approve').inputSchema.properties.review;
  const ownerReview = reviewSchema.anyOf.find(schema => schema.properties.mode?.const === 'owner_accepted_technical');
  assert.equal(ownerReview.properties.renderWatched.const, false);
  assert.ok(ownerReview.required.includes('technicalAcceptance'));
  assert.equal(ownerReview.properties.technicalAcceptance.additionalProperties, false);
  assert.equal(ownerReview.properties.technicalAcceptance.properties.ownerAcceptedImperfections.const, true);
  const policyText = await readFile(new URL('../docs/ai-meow-operation.md', import.meta.url), 'utf8');
  const director = await client.getPrompt({ name: 'studio-director', arguments: { direction: 'Use the existing sphere collection.' } });
  assert.equal(director.messages[0].content.text, `AI Meow policy source: studio/docs/ai-meow-operation.md (ytfun://studio/operation-policy).\nRequested direction: Use the existing sphere collection.\n\n${policyText}`);
  const policyResource = await client.readResource({ uri: 'ytfun://studio/operation-policy' });
  assert.equal(policyResource.contents[0].text, policyText);
  assert.ok(tools.tools.some(tool => tool.name === 'ytfun_tiktok_export'));
  assert.ok(tools.tools.some(tool => tool.name === 'ytfun_tiktok_publish'));
  assert.deepEqual(tools.tools.find(tool => tool.name === 'ytfun_tiktok_publish').inputSchema.properties.privacy, { type: 'string', const: 'public' });
  assert.ok(tools.tools.some(tool => tool.name === 'ytfun_facebook_publish'));
  assert.ok(tools.tools.some(tool => tool.name === 'ytfun_kwai_export'));
  assert.ok(tools.tools.some(tool => tool.name === 'ytfun_delivery_enqueue'));
  const reschedule = tools.tools.find(tool => tool.name === 'ytfun_delivery_reschedule').inputSchema;
  assert.equal(reschedule.properties.expectedClaim.additionalProperties, false);
  assert.deepEqual(reschedule.properties.expectedClaim.required.sort(), ['accountId', 'bindingSha256', 'dueAt', 'madeForKids', 'mode', 'platform', 'privacy', 'providerAccountId', 'renderSha256', 'reviewHash']);
  assert.deepEqual(reschedule.properties.expectedClaim.properties.platform.enum, ['youtube', 'facebook', 'tiktok', 'kwai']);
  assert.deepEqual(reschedule.properties.expectedClaim.properties.privacy.enum, ['private', 'unlisted', 'public']);
  for (const key of ['providerAccountId', 'bindingSha256']) assert.ok(reschedule.properties.expectedClaim.properties[key].anyOf.some(value => value.type === 'null'));
  assert.deepEqual(reschedule.properties.expectedClaim.properties.madeForKids.type, ['boolean', 'null']);
  const cadenceSchema = tools.tools.find(tool => tool.name === 'ytfun_project_cadence_update').inputSchema.properties.cadence;
  assert.equal(cadenceSchema.properties.minHoursBetweenPosts.minimum, 0);
  assert.equal(cadenceSchema.properties.minHoursBetweenPosts.maximum, undefined);
  assert.ok(cadenceSchema.properties.maxPostsPerRollingDay.anyOf.some(value => value.type === 'null'));
  assert.ok(cadenceSchema.properties.maxPostsPerRollingDay.anyOf.some(value => value.type === 'integer' && value.maximum === 9007199254740991));
  const migration = tools.tools.find(tool => tool.name === 'ytfun_zernio_delivery_migrate').inputSchema;
  assert.deepEqual(migration.properties.expectedMode.enum, ['official_api', 'experimental_session_rest']);
  assert.ok(migration.required.includes('expectedReviewHash'));
  const consent = tools.tools.find(tool => tool.name === 'ytfun_tiktok_zernio_consent_record').inputSchema;
  const ownerConsent = consent.properties.attestation.anyOf.find(schema => schema.properties.previewWitness.const === 'owner');
  const delegatedConsent = consent.properties.attestation.anyOf.find(schema => schema.properties.previewWitness.const === 'authorized_agent');
  for (const variant of [ownerConsent, delegatedConsent]) {
    assert.equal(variant.properties.contentPreviewConfirmed.const, true);
    assert.equal(variant.properties.expressConsentGiven.const, true);
    assert.equal(variant.additionalProperties, false);
    assert.ok(variant.required.includes('evidenceSha256'));
  }
  assert.equal(ownerConsent.properties.consentSource.const, 'owner_explicit');
  assert.equal(delegatedConsent.properties.consentSource.const, 'owner_standing_authority');
  assert.equal(delegatedConsent.properties.previewMethod.const, 'visual_playback');
  assert.ok(delegatedConsent.required.includes('previewActorId'));
  assert.ok(delegatedConsent.required.includes('authorityEvidenceSha256'));
  assert.match(delegatedConsent.properties.previewActorId.pattern, /codex:/);
  assert.ok(consent.required.includes('expectedReviewHash'));
  assert.deepEqual(consent.properties.interactionSettings.required.sort(), ['allow_comment', 'allow_duet', 'allow_stitch']);
  const refusedRender = await client.callTool({ name: 'ytfun_episode_render', arguments: { episodeId: '717f7a19-2e5f-4c55-b1d6-35c0d7899a23' } });
  assert.equal(refusedRender.isError, true); assert.match(refusedRender.content[0].text, /remote assembly only/);
  const planningSchema = tools.tools.find(tool => tool.name === 'ytfun_episode_plan').inputSchema;
  assert.deepEqual(planningSchema.properties.format.enum, ['short', 'long']);
  assert.equal(planningSchema.properties.format.default, 'short');
  assert.deepEqual(planningSchema.properties.renderCanvas.enum, ['portrait', 'landscape']);
  assert.ok(!planningSchema.required.includes('renderCanvas'));
  assert.deepEqual(planningSchema.properties.audioMode.enum, ['narrated', 'silent', 'nonverbal']);
  assert.equal(planningSchema.properties.scenes.maxItems, 120);
  const derivationSchema = tools.tools.find(tool => tool.name === 'ytfun_episode_derive_short').inputSchema;
  assert.equal(derivationSchema.properties.parentEpisodeId.format, 'uuid');
  assert.equal(derivationSchema.properties.sceneIds.maxItems, 12);
  const compose = tools.tools.find(tool => tool.name === 'ytfun_episode_compose').inputSchema;
  assert.deepEqual(compose.properties.format.enum, ['short', 'long']);
  assert.ok(compose.required.includes('sources'));
  assert.ok(!compose.required.includes('parentEpisodeId'));
  assert.equal(compose.properties.sources.items.additionalProperties, false);
  const presentation = tools.tools.find(tool => tool.name === 'ytfun_publication_metadata_prepare');
  assert.equal(presentation.annotations.readOnlyHint, true);
  assert.equal(presentation.inputSchema.properties.publicationMetadata.additionalProperties, false);
  for (const name of ['ytfun_publish_plan', 'ytfun_facebook_publish', 'ytfun_tiktok_publish', 'ytfun_youtube_publish', 'ytfun_delivery_enqueue']) {
    const input = tools.tools.find(tool => tool.name === name).inputSchema;
    assert.ok(input.properties.publicationMetadata);
    assert.ok(input.properties.publicationMetadataSha256);
  }
  assert.ok(tools.tools.find(tool => tool.name === 'ytfun_episode_render_manifest').annotations.readOnlyHint);
  const registrationSchema = tools.tools.find(tool => tool.name === 'ytfun_episode_render_register').inputSchema;
  assert.equal(registrationSchema.properties.manifest.type, 'object');
  assert.ok(registrationSchema.required.includes('provenance'));
  const videoSchema = tools.tools.find(tool => tool.name === 'ytfun_asset_generate').inputSchema.properties.videoParameters;
  assert.equal(videoSchema.additionalProperties, false);
  assert.deepEqual(videoSchema.properties.resolution.enum, ['480p', '580p', '720p']);
  assert.equal(videoSchema.properties.num_frames.minimum, 81);
  assert.equal(videoSchema.properties.num_frames.maximum, 121);
  assert.deepEqual(videoSchema.properties.frames_per_second.anyOf, [
    { type: 'number', const: 16 },
    { type: 'number', const: 24 },
  ]);
  assert.deepEqual(videoSchema.properties.interpolator_model.enum, ['none', 'film']);
  assert.deepEqual(videoSchema.properties.num_interpolated_frames.anyOf, [
    { type: 'number', const: 0 },
    { type: 'number', const: 1 },
  ]);
  assert.equal(videoSchema.properties.adjust_fps_for_interpolation.type, 'boolean');
  const jobSchema = tools.tools.find(tool => tool.name === 'ytfun_production_job_start').inputSchema;
  assert.match(JSON.stringify(jobSchema), /"videoParameters"/);
  const generationSchema = tools.tools.find(tool => tool.name === 'ytfun_asset_generate').inputSchema;
  const imageSchema = generationSchema.properties.imageParameters;
  assert.equal(imageSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(imageSchema.properties).sort(), ['height', 'num_inference_steps', 'seed', 'width']);
  for (const dimension of ['width', 'height']) {
    assert.equal(imageSchema.properties[dimension].type, 'integer');
    assert.equal(imageSchema.properties[dimension].minimum, 256);
    assert.equal(imageSchema.properties[dimension].maximum, 2048);
  }
  assert.equal(imageSchema.properties.num_inference_steps.minimum, 1);
  assert.equal(imageSchema.properties.num_inference_steps.maximum, 50);
  assert.equal(generationSchema.properties.referenceImageAssetId.type, 'string');
  assert.equal(generationSchema.properties.referenceImageAssetId.format, 'uuid');
  assert.equal(generationSchema.properties.endReferenceImageAssetId.type, 'string');
  assert.equal(generationSchema.properties.endReferenceImageAssetId.format, 'uuid');
  assert.match(JSON.stringify(jobSchema), /"imageParameters"/);
  assert.match(JSON.stringify(jobSchema), /"referenceImageAssetId"/);
  assert.match(JSON.stringify(jobSchema), /"endReferenceImageAssetId"/);
  assert.match(JSON.stringify(jobSchema), /"adjust_fps_for_interpolation"/);
  const created = await client.callTool({ name: 'ytfun_project_create', arguments: { title: 'Arquivo das cidades impossíveis', premise: 'Uma cidade imaginária diferente por episódio.', audience: 'Pessoas interessadas em ficção especulativa.', language: 'pt-BR' } });
  assert.ok(!created.isError, JSON.stringify(created));
  const project = JSON.parse(created.content[0].text);
  assert.equal(project.budgetMonthlyUsd, null);
  const cadenceArguments = { projectId: project.id, expectedCadence: project.cadence, cadence: { minHoursBetweenPosts: 18, maxPostsPerRollingDay: 2 }, reason: 'Authorized launch experiment' };
  const cadenceResult = await client.callTool({ name: 'ytfun_project_cadence_update', arguments: cadenceArguments });
  assert.ok(!cadenceResult.isError, JSON.stringify(cadenceResult));
  assert.deepEqual(JSON.parse(cadenceResult.content[0].text).cadence, cadenceArguments.cadence);
  const staleCadence = await client.callTool({ name: 'ytfun_project_cadence_update', arguments: cadenceArguments });
  assert.equal(staleCadence.isError, true);
  assert.match(staleCadence.content[0].text, /cadence changed/);
  const uncappedArguments = { projectId: project.id, expectedCadence: cadenceArguments.cadence, cadence: { minHoursBetweenPosts: 0, maxPostsPerRollingDay: null }, reason: 'Owner permits multiple distinct beneficial works per dispatch.' };
  const uncapped = await client.callTool({ name: 'ytfun_project_cadence_update', arguments: uncappedArguments });
  assert.ok(!uncapped.isError, JSON.stringify(uncapped));
  const updatedProject = JSON.parse(uncapped.content[0].text);
  assert.deepEqual(updatedProject.cadence, uncappedArguments.cadence);
  assert.equal(updatedProject.cadenceHistory.length, 2);
  for (const cadence of [{ minHoursBetweenPosts: -1, maxPostsPerRollingDay: null }, { minHoursBetweenPosts: 0, maxPostsPerRollingDay: 0 }]) {
    const invalidCadence = await client.callTool({ name: 'ytfun_project_cadence_update', arguments: { ...uncappedArguments, expectedCadence: uncappedArguments.cadence, cadence } });
    assert.equal(invalidCadence.isError, true);
  }
  const silent = await client.callTool({ name: 'ytfun_episode_plan', arguments: { projectId: project.id, audioMode: 'silent', title: 'The kitten and the obsidian portal', hook: 'A violet light travels beneath a black stone.', synopsis: 'A cybernetic kitten discovers an impossible interior.', continuityNote: 'First original visual reveal.', originalAngle: 'A complete comic portal reveal without speech or text.', scenes: [{ durationSeconds: 5, visualPrompt: 'An original silver cartoon kitten beside an obsidian sphere on a violet sofa.' }], metadata: { description: 'Original AI fiction.', hashtags: ['#AIMeow'] } } });
  assert.ok(!silent.isError, JSON.stringify(silent));
  assert.equal(JSON.parse(silent.content[0].text).audioMode, 'silent');
  assert.equal(JSON.parse(silent.content[0].text).format, 'short');
  assert.equal(JSON.parse(silent.content[0].text).scenes[0].narration, '');
  const longInput = { projectId: project.id, format: 'long', audioMode: 'nonverbal', title: 'An anthology of miniature living landscapes', hook: 'Every sphere reveals an unexpected landscape.', synopsis: 'Thirteen complete original material reveals with original nonverbal sound.', continuityNote: 'One coherent anthology, each unit has its own ending.', originalAngle: 'Tactile materials become self-contained kinetic landscapes.', scenes: Array.from({ length: 13 }, (_, index) => ({ durationSeconds: 15, visualPrompt: `Original sphere ${index} reveals a tiny luminous landscape and settles with a complete ending.` })), metadata: { description: 'Original synthetic visual anthology with original sound effects.', hashtags: ['#AIMeow'] } };
  const shortOverflow = await client.callTool({ name: 'ytfun_episode_plan', arguments: { ...longInput, format: 'short' } });
  assert.equal(shortOverflow.isError, true);
  assert.match(shortOverflow.content[0].text, /12 scenes/);
  const masterResult = await client.callTool({ name: 'ytfun_episode_plan', arguments: longInput });
  assert.ok(!masterResult.isError, JSON.stringify(masterResult));
  const master = JSON.parse(masterResult.content[0].text);
  assert.equal(master.format, 'long');
  assert.equal(master.audioMode, 'nonverbal');
  assert.equal(master.scenes.length, 13);
  const unrenderedDerivation = await client.callTool({ name: 'ytfun_episode_derive_short', arguments: { parentEpisodeId: master.id, sceneIds: [master.scenes[0].id], title: 'One miniature landscape revealed', hook: 'A new landscape unfolds.', synopsis: 'A complete standalone reveal.', originalAngle: 'A resolved transformation with tactile original sound.', metadata: longInput.metadata } });
  assert.equal(unrenderedDerivation.isError, true);
  assert.match(unrenderedDerivation.content[0].text, /rendered long episode/);

  const invalid = await client.callTool({ name: 'ytfun_episode_get', arguments: { episodeId: '../../outside' } });
  assert.equal(invalid.isError, true);
  const resources = await client.listResources();
  assert.ok(resources.resources.some(resource => resource.uri === 'ytfun://studio/state'));
  await client.close();
  const restarted = await connect();
  t.after(() => restarted.close());
  const listed = await restarted.callTool({ name: 'ytfun_project_list', arguments: {} });
  assert.equal(JSON.parse(listed.content[0].text)[0].id, project.id);
});
