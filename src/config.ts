import type { ScopeConfig } from "./types.js";
import { readJsonFile } from "./io.js";

export async function loadScopeConfig(path: string): Promise<ScopeConfig> {
  const config = await readJsonFile<ScopeConfig>(path);
  validateScopeConfig(config);
  return config;
}

function validateScopeConfig(config: ScopeConfig): void {
  const errors: string[] = [];

  if (!config.projectName) errors.push("projectName is required");
  if (!Array.isArray(config.topics) || config.topics.length === 0) {
    errors.push("at least one topic is required");
  }

  for (const [index, topic] of (config.topics ?? []).entries()) {
    if (!topic.id) errors.push(`topics[${index}].id is required`);
    if (!topic.name) errors.push(`topics[${index}].name is required`);
    if (!Array.isArray(topic.queries) || topic.queries.length === 0) {
      errors.push(`topics[${index}].queries must contain at least one query`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid scope config:\n- ${errors.join("\n- ")}`);
  }
}
