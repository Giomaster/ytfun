import { z } from 'zod';

const text = maximum => z.string().trim().min(1).max(maximum);
const checked = {
  originalityChecked: z.literal(true), factsChecked: z.literal(true),
  reviewedBy: text(300), notes: text(10_000),
};

const watchedReview = z.object({
  ...checked, mode: z.literal('watched').optional(), renderWatched: z.literal(true),
});

const technicalReview = z.object({
  ...checked, mode: z.literal('owner_accepted_technical'), renderWatched: z.literal(false),
  technicalAcceptance: z.object({
    renderSha256: z.string().regex(/^[a-f0-9]{64}$/),
    renderFileChecked: z.literal(true), sourceFilesChecked: z.literal(true),
    commercialRightsChecked: z.literal(true), ownerAcceptedImperfections: z.literal(true),
    acceptedBy: text(300), acceptanceReference: text(2000), reason: text(10_000),
  }).strict(),
}).strict();

export const approvalReviewSchema = z.union([watchedReview, technicalReview]);

/** Revalidate approval evidence without turning a technical acceptance into a watched render. */
export function approvalReviewIsValid(review, { env = {}, render } = {}) {
  if (review?.originalityChecked !== true || review?.factsChecked !== true ||
      typeof review?.reviewedBy !== 'string' || !review.reviewedBy.trim()) return false;
  if (review.mode === 'owner_accepted_technical') {
    if (env.YTFUN_OWNER_ACCEPTED_TECHNICAL_REVIEW_ENABLED !== 'true') return false;
    const parsed = technicalReview.safeParse(review);
    return parsed.success && parsed.data.technicalAcceptance.renderSha256 === render?.sha256;
  }
  // Preserve the validation of existing watched approvals, including records predating notes.
  return (review.mode === undefined || review.mode === 'watched') && review.renderWatched === true;
}

export function normalizeApprovalReview(review, { env = {}, render } = {}) {
  if (review?.mode === 'owner_accepted_technical' && env.YTFUN_OWNER_ACCEPTED_TECHNICAL_REVIEW_ENABLED !== 'true') {
    throw new Error('Owner-accepted technical review is disabled; explicit runtime opt-in is required.');
  }
  const parsed = approvalReviewSchema.safeParse(review);
  if (!parsed.success) throw new Error('Approval requires originalityChecked, factsChecked and truthful render review attestations, including the complete structured technical acceptance when selected.');
  if (!approvalReviewIsValid(parsed.data, { env, render })) throw new Error('Technical acceptance must bind the exact current render SHA256.');
  return parsed.data;
}
