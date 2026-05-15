import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export async function readJsonFile<T>(path: string): Promise<T> {
  const body = await readFile(path, "utf8");
  return JSON.parse(body) as T;
}

export async function writeJsonFile(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export async function writeTextFile(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data, "utf8");
}

export function resolveFromCwd(path: string): string {
  return resolve(process.cwd(), path);
}
