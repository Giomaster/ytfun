import { createHash } from 'node:crypto';

const FIELDS = ['title', 'description', 'hashtags', 'tags'];
const NETWORKS = ['youtube', 'facebook', 'tiktok'];

/** Complete presentation for one network; editorial media evidence remains shared. */
export function normalizePublicationMetadata(metadata, platform) {
  if (!NETWORKS.includes(platform) || !metadata || typeof metadata !== 'object' || Array.isArray(metadata) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(metadata)) || FIELDS.some(key => !Object.hasOwn(metadata, key)) ||
      Reflect.ownKeys(metadata).some(key => !FIELDS.includes(key)) || typeof metadata.title !== 'string' ||
      typeof metadata.description !== 'string' || !Array.isArray(metadata.hashtags) || !Array.isArray(metadata.tags) ||
      Array.from(metadata.hashtags).some(value => typeof value !== 'string') || Array.from(metadata.tags).some(value => typeof value !== 'string')) {
    throw new Error('Publication metadata requires exactly title, description, hashtags and tags for YouTube, Facebook or TikTok.');
  }
  const result = { title: metadata.title.trim(), description: metadata.description.trim(),
    hashtags: metadata.hashtags.map(value => value.trim()), tags: metadata.tags.map(value => value.trim()) };
  if (!result.title || result.title.length > 100 || /[<>\r\n]/.test(result.title)) throw new Error('Publication title requires 1 to 100 characters on one line without angle brackets.');
  if (result.hashtags.length > 8 || result.hashtags.some(value => value.length > 60 || !/^#[\p{L}\p{N}_]+$/u.test(value))) throw new Error('Publication hashtags require at most eight valid hashtags of at most 60 characters.');
  const tagCost = result.tags.reduce((total, tag) => total + tag.length + (/\s/.test(tag) ? 2 : 0), Math.max(0, result.tags.length - 1));
  if (result.tags.some(value => !value || value.length > 100) || tagCost > 500) throw new Error('Publication tags exceed the supported 500-character aggregate limit.');
  const description = [result.description, result.hashtags.join(' ')].filter(Boolean).join('\n\n');
  const caption = [result.title, description].filter(Boolean).join('\n\n');
  if (platform === 'youtube' && (description.length > 5000 || Buffer.byteLength(description, 'utf8') > 5000 || /[<>]/.test(description))) throw new Error('YouTube description including hashtags permits at most 5000 characters/UTF-8 bytes without angle brackets.');
  if (platform === 'facebook' && (caption.length > 5000 || Buffer.byteLength(caption, 'utf8') > 20_000)) throw new Error('Facebook caption including hashtags exceeds its supported limit.');
  if (platform === 'tiktok' && caption.length > 2200) throw new Error('TikTok caption including hashtags exceeds 2200 UTF-16 code units.');
  return result;
}

export function publicationMetadataHash(metadata, platform) {
  const normalized = normalizePublicationMetadata(metadata, platform);
  return createHash('sha256').update(JSON.stringify({ platform, ...normalized })).digest('hex');
}

/** Compatibility with existing YouTube delivery snapshots; never rewrite their records. */
export function normalizeYouTubeMetadata(metadata) {
  const fields = ['title', 'description', 'tags'];
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(metadata)) || fields.some(key => !Object.hasOwn(metadata, key)) ||
      Reflect.ownKeys(metadata).some(key => !fields.includes(key))) throw new Error('YouTube metadata requires exactly title, description and tags.');
  const { hashtags, ...normalized } = normalizePublicationMetadata({ ...metadata, hashtags: [] }, 'youtube');
  return normalized;
}

export function youtubeMetadataHash(metadata) {
  const { title, description, tags } = normalizeYouTubeMetadata(metadata);
  return createHash('sha256').update(JSON.stringify({ description, tags, title })).digest('hex');
}

export function youtubeMetadataSnapshot({ youtubeMetadata, youtubeMetadataSha256 } = {}, { requireCanonical = false } = {}) {
  if (youtubeMetadata === undefined && youtubeMetadataSha256 === undefined) return {};
  if (youtubeMetadata === undefined || !/^[a-f0-9]{64}$/.test(youtubeMetadataSha256 ?? '')) throw new Error('YouTube metadata snapshot requires its exact SHA256 binding.');
  const normalized = normalizeYouTubeMetadata(youtubeMetadata);
  if (youtubeMetadataHash(normalized) !== youtubeMetadataSha256) throw new Error('YouTube metadata snapshot SHA256 does not match.');
  if (requireCanonical && (normalized.title !== youtubeMetadata.title || normalized.description !== youtubeMetadata.description ||
      normalized.tags.some((tag, index) => tag !== youtubeMetadata.tags[index]))) throw new Error('Persisted YouTube metadata snapshot is not normalized.');
  return { youtubeMetadata: normalized, youtubeMetadataSha256 };
}

export function youtubeMetadataBindingsMatch(left, right) {
  return youtubeMetadataSnapshot(left, { requireCanonical: true }).youtubeMetadataSha256 ===
    youtubeMetadataSnapshot(right, { requireCanonical: true }).youtubeMetadataSha256;
}

/** Explicit snapshots must have an exact binding; absence preserves legacy claims. */
export function publicationMetadataSnapshot(binding = {}, platform, { requireCanonical = false } = {}) {
  const { publicationMetadata, publicationMetadataSha256 } = binding;
  if (binding.youtubeMetadata !== undefined || binding.youtubeMetadataSha256 !== undefined) {
    if (platform !== 'youtube') throw new Error('Legacy YouTube metadata cannot be used for another network.');
    if (publicationMetadata !== undefined || publicationMetadataSha256 !== undefined) throw new Error('Choose one publication metadata snapshot schema; legacy and network snapshots cannot be mixed.');
    const legacy = youtubeMetadataSnapshot(binding, { requireCanonical });
    const metadata = { ...legacy.youtubeMetadata, hashtags: [] };
    return { publicationMetadata: metadata, publicationMetadataSha256: publicationMetadataHash(metadata, platform) };
  }
  if (publicationMetadata === undefined && publicationMetadataSha256 === undefined) return {};
  if (publicationMetadata === undefined || !/^[a-f0-9]{64}$/.test(publicationMetadataSha256 ?? '')) throw new Error('Publication metadata requires its exact SHA256 binding.');
  const normalized = normalizePublicationMetadata(publicationMetadata, platform);
  if (publicationMetadataHash(normalized, platform) !== publicationMetadataSha256) throw new Error('Publication metadata SHA256 does not match this network snapshot.');
  if (requireCanonical && FIELDS.some(key => Array.isArray(normalized[key]) ?
    normalized[key].some((value, index) => value !== publicationMetadata[key][index]) : normalized[key] !== publicationMetadata[key])) throw new Error('Persisted publication metadata must be normalized.');
  return { publicationMetadata: normalized, publicationMetadataSha256 };
}

export function publicationMetadataBindingsMatch(left, right, platform) {
  return publicationMetadataSnapshot(left, platform, { requireCanonical: true }).publicationMetadataSha256 ===
    publicationMetadataSnapshot(right, platform, { requireCanonical: true }).publicationMetadataSha256;
}

export function requirePublicMetadataRoute(binding, { platform, privacy }) {
  if (binding.publicationMetadata !== undefined && (!NETWORKS.includes(platform) || privacy !== 'public')) throw new Error('Publication metadata snapshots are supported only for PUBLIC YouTube, Facebook or TikTok delivery.');
}

export function presentationFor(snapshot) {
  return { ...snapshot, description: [snapshot.description, snapshot.hashtags.join(' ')].filter(Boolean).join('\n\n') };
}
