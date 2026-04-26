import { lstat, readdir, readFile } from "node:fs/promises";
import { join, sep } from "node:path";

type IgnoreRule = {
  baseRel: string;
  pattern: string;
  negated: boolean;
  dirOnly: boolean;
  anchored: boolean;
  hasSlash: boolean;
  regex?: RegExp;
};

export type FileMatch = {
  path: string;
  type: "file" | "directory";
};

const DEFAULT_IGNORED_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".turbo",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".vite",
  "dist",
  "build",
  "coverage",
  ".cache",
]);

const DEFAULT_IGNORED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".tar", ".gz", ".mp4", ".mov"]);

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function normalizeRelative(path: string): string {
  return toPosix(path).replace(/^\.\//, "").replace(/^\/+/, "");
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegex(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern.charAt(i);
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        const followedBySlash = pattern[i + 2] === "/";
        out += followedBySlash ? "(?:.*\/)?" : ".*";
        i += followedBySlash ? 2 : 1;
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else {
      out += escapeRegex(char);
    }
  }
  return new RegExp(`^${out}$`);
}

function parseIgnoreFile(baseRel: string, text: string): IgnoreRule[] {
  return text
    .split(/\r?\n/)
    .map((line): IgnoreRule | null => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return null;
      let pattern = trimmed;
      let negated = false;
      if (pattern.startsWith("!")) {
        negated = true;
        pattern = pattern.slice(1);
      }
      if (!pattern) return null;
      const dirOnly = pattern.endsWith("/");
      if (dirOnly) pattern = pattern.slice(0, -1);
      const anchored = pattern.startsWith("/");
      if (anchored) pattern = pattern.slice(1);
      pattern = normalizeRelative(pattern);
      if (!pattern) return null;
      const hasSlash = pattern.includes("/");
      const rule: IgnoreRule = { baseRel, pattern, negated, dirOnly, anchored, hasSlash };
      if (hasSlash) rule.regex = globToRegex(pattern);
      return rule;
    })
    .filter((rule): rule is IgnoreRule => rule !== null);
}

async function readIgnoreRules(root: string, dirRel: string): Promise<IgnoreRule[]> {
  try {
    const text = await readFile(join(root, dirRel, ".gitignore"), "utf8");
    return parseIgnoreFile(dirRel, text);
  } catch {
    return [];
  }
}

function pathFromBase(baseRel: string, relPath: string): string | null {
  if (!baseRel) return relPath;
  if (relPath === baseRel) return "";
  const prefix = `${baseRel}/`;
  return relPath.startsWith(prefix) ? relPath.slice(prefix.length) : null;
}

function ruleMatches(rule: IgnoreRule, relPath: string, isDirectory: boolean): boolean {
  if (rule.dirOnly && !isDirectory) return false;
  const fromBase = pathFromBase(rule.baseRel, relPath);
  if (fromBase === null || fromBase === "") return false;

  if (!rule.hasSlash && !rule.anchored) {
    return fromBase.split("/").some((segment) => globToRegex(rule.pattern).test(segment));
  }

  return (rule.regex ?? globToRegex(rule.pattern)).test(fromBase);
}

function isIgnoredByRules(rules: IgnoreRule[], relPath: string, isDirectory: boolean): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (ruleMatches(rule, relPath, isDirectory)) ignored = !rule.negated;
  }
  return ignored;
}

function isDefaultIgnored(relPath: string, isDirectory: boolean): boolean {
  const name = relPath.split("/").at(-1) ?? relPath;
  if (DEFAULT_IGNORED_NAMES.has(name)) return true;
  if (!isDirectory) {
    const lower = name.toLowerCase();
    for (const extension of DEFAULT_IGNORED_EXTENSIONS) if (lower.endsWith(extension)) return true;
  }
  return false;
}

async function collectPaths(root: string, options: { includeDirectories?: boolean; maxVisited?: number; limit?: number } = {}): Promise<FileMatch[]> {
  const includeDirectories = options.includeDirectories ?? false;
  const maxVisited = options.maxVisited ?? 25_000;
  const limit = options.limit ?? 500;
  const results: FileMatch[] = [];
  const rules: IgnoreRule[] = [];
  let visited = 0;

  async function walk(dirRel: string): Promise<void> {
    if (visited >= maxVisited || results.length >= limit) return;
    const ruleDepth = rules.length;
    rules.push(...await readIgnoreRules(root, dirRel));

    let entries: string[];
    try {
      entries = await readdir(join(root, dirRel));
    } catch {
      rules.length = ruleDepth;
      return;
    }

    try {
      for (const entryName of entries) {
        if (visited++ >= maxVisited || results.length >= limit) return;
        const relPath = normalizeRelative(dirRel ? `${dirRel}/${entryName}` : entryName);
        let stat;
        try {
          stat = await lstat(join(root, relPath));
        } catch {
          continue;
        }
        const isDirectory = stat.isDirectory();
        if (stat.isSymbolicLink()) continue;
        if (isDefaultIgnored(relPath, isDirectory) || isIgnoredByRules(rules, relPath, isDirectory)) continue;
        if (isDirectory) {
          if (includeDirectories) results.push({ path: `${relPath}/`, type: "directory" });
          await walk(relPath);
        } else if (stat.isFile()) {
          results.push({ path: relPath, type: "file" });
        }
      }
    } finally {
      rules.length = ruleDepth;
    }
  }

  await walk("");
  return results;
}

function rankSearch(path: string, query: string): number {
  const lower = path.toLowerCase();
  const base = lower.split("/").at(-1) ?? lower;
  if (base === query) return 0;
  if (base.startsWith(query)) return 1;
  if (lower.startsWith(query)) return 2;
  if (base.includes(query)) return 3;
  if (lower.includes(query)) return 4;
  return 99;
}

export async function searchFiles(root: string, query: string, limit = 50): Promise<FileMatch[]> {
  const q = query.trim().replace(/^@/, "").toLowerCase();
  if (!q) return [];
  const paths = await collectPaths(root, { limit: Math.max(500, limit * 20) });
  return paths
    .map((match) => ({ match, rank: rankSearch(match.path, q) }))
    .filter((entry) => entry.rank < 99)
    .sort((a, b) => a.rank - b.rank || a.match.path.length - b.match.path.length || a.match.path.localeCompare(b.match.path))
    .slice(0, limit)
    .map((entry) => entry.match);
}

export async function completeFiles(root: string, prefix: string, limit = 50): Promise<FileMatch[]> {
  const cleanPrefix = normalizeRelative(prefix.trim().replace(/^@/, ""));
  const paths = await collectPaths(root, { includeDirectories: true, limit: Math.max(500, limit * 20) });
  return paths
    .filter((match) => match.path.toLowerCase().startsWith(cleanPrefix.toLowerCase()))
    .sort((a, b) => Number(b.type === "directory") - Number(a.type === "directory") || a.path.localeCompare(b.path))
    .slice(0, limit);
}
