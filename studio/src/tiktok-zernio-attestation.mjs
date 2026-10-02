const SHA = /^[a-f0-9]{64}$/;
export const TIKTOK_PREVIEW_ACTOR_PATTERN = /^codex:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const COMMON_FIELDS = ['renderSha256', 'contentPreviewConfirmed', 'expressConsentGiven', 'previewWitness', 'consentSource', 'evidenceSha256', 'recordedAt'];
const AGENT_FIELDS = ['previewActorId', 'previewMethod', 'authorityEvidenceSha256'];
const isSha = value => typeof value === 'string' && SHA.test(value);

function validTimestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)) && Date.parse(value) > 0;
}

/** Historical records remain structurally readable after standing authority is disabled. */
export function validateTikTokZernioAttestationShape(attestation, renderSha256) {
  if (!attestation || typeof attestation !== 'object' || Array.isArray(attestation) || !isSha(renderSha256) ||
      attestation.renderSha256 !== renderSha256 || attestation.contentPreviewConfirmed !== true || attestation.expressConsentGiven !== true ||
      !isSha(attestation.evidenceSha256) || !validTimestamp(attestation.recordedAt)) return false;
  const owner = attestation.previewWitness === 'owner' && attestation.consentSource === 'owner_explicit';
  const delegated = attestation.previewWitness === 'authorized_agent' && attestation.consentSource === 'owner_standing_authority' &&
    typeof attestation.previewActorId === 'string' && TIKTOK_PREVIEW_ACTOR_PATTERN.test(attestation.previewActorId) &&
    attestation.previewMethod === 'visual_playback' && isSha(attestation.authorityEvidenceSha256);
  const fields = owner ? COMMON_FIELDS : [...COMMON_FIELDS, ...AGENT_FIELDS];
  return (owner || delegated) && Object.keys(attestation).every(key => fields.includes(key)) && fields.every(key => Object.hasOwn(attestation, key));
}

/** A real delegated preview requires an explicitly enabled exact standing-authority hash. */
export function validateTikTokZernioAttestation(attestation, renderSha256, { env = {}, now = Date.now() } = {}) {
  if (!validateTikTokZernioAttestationShape(attestation, renderSha256) || !Number.isFinite(now) || Date.parse(attestation.recordedAt) > now + 60_000) return false;
  return attestation.previewWitness === 'owner' || (isSha(env?.YTFUN_TIKTOK_STANDING_AUTHORITY_SHA256) &&
    env.YTFUN_TIKTOK_STANDING_AUTHORITY_SHA256 === attestation.authorityEvidenceSha256);
}

/** Persist bounded provenance fields only; never credentials or the observation's raw contents. */
export function sanitizeTikTokZernioAttestation(attestation) {
  if (!validateTikTokZernioAttestationShape(attestation, attestation?.renderSha256)) throw new Error('Exact TikTok preview/consent evidence is invalid.');
  const fields = attestation.previewWitness === 'owner' ? COMMON_FIELDS : [...COMMON_FIELDS, ...AGENT_FIELDS];
  return Object.fromEntries(fields.map(key => [key, attestation[key]]));
}
