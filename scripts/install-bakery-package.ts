#!/usr/bin/env bun
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const protocolSource = join(repoRoot, "packages", "protocol");
const protocolLink = join(repoRoot, "node_modules", "@pi-web-agent", "protocol");

if (!existsSync(protocolSource)) process.exit(0);

mkdirSync(dirname(protocolLink), { recursive: true });
if (existsSync(protocolLink)) {
  const stats = lstatSync(protocolLink);
  if (stats.isSymbolicLink() || !stats.isDirectory()) rmSync(protocolLink, { recursive: true, force: true });
  else process.exit(0);
}

const relativeTarget = relative(dirname(protocolLink), protocolSource) || ".";
symlinkSync(relativeTarget, protocolLink, process.platform === "win32" ? "junction" : "dir");
