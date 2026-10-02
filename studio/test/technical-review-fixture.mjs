export const technicalReviewEnv = { YTFUN_OWNER_ACCEPTED_TECHNICAL_REVIEW_ENABLED: 'true' };

export function ownerAcceptedTechnicalReview(episode) {
  return {
    originalityChecked: true, factsChecked: true, renderWatched: false,
    reviewedBy: 'CI fixture operator', notes: 'Verified fixture files and evidence; no playback or audio audition is claimed.',
    mode: 'owner_accepted_technical',
    technicalAcceptance: {
      renderSha256: episode.render.sha256,
      renderFileChecked: true, sourceFilesChecked: true, commercialRightsChecked: true,
      ownerAcceptedImperfections: true, acceptedBy: 'CI fixture owner',
      acceptanceReference: 'ci-fixture://owner-instruction/accept-generated-imperfections',
      reason: 'The fixture owner explicitly accepts generated imperfections without an aesthetic or human review gate.',
    },
  };
}
