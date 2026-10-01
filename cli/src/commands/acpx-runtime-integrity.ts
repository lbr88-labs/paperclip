import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

export const CODEX_ACP_VERSION = "1.6.2";
export const CODEX_RUNTIME_VERSION = "0.159.1";
export const CODEX_ACP_PATCH_RELATIVE_PATH =
  "patches/@agentclientprotocol__codex-acp@1.6.2.patch";
export const CODEX_ACP_PATCH_SHA256 =
  "a1c929e609274a87ee03020d2cdb31e12e29cec39b0a38dca486c989e55bbf84";
export const CODEX_ACP_RUNTIME_SHA256 =
  "c4538599d1ab767db5dff50934f13bb5ba313a59d9c4a83e993fac4617ea63d3";

type PackageManifest = {
  name?: string;
  version?: string;
  dependencies?: Record<string, unknown>;
};

type LockPackage = { version?: string };

function fail(message: string): never {
  throw new Error("ACP runtime integrity check failed: " + message);
}

function readJson(filePath: string, context: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
  } catch (cause) {
    throw new Error("ACP runtime integrity check failed: could not read " + context, {
      cause,
    });
  }
}

function packageNameFromNodeModulesPath(packagePath: string): string | null {
  const normalized = packagePath.split(path.sep).join("/");
  const marker = "/node_modules/";
  const index = normalized.lastIndexOf(marker);
  if (index < 0) return null;
  return normalized.slice(index + marker.length);
}

function walkInstalledPackages(nodeModulesPath: string): string[] {
  const packages: string[] = [];
  const visitedNodeModules = new Set<string>();

  const visitNodeModules = (directory: string): void => {
    let realDirectory: string;
    try {
      realDirectory = fs.realpathSync(directory);
    } catch {
      return;
    }
    if (visitedNodeModules.has(realDirectory)) return;
    visitedNodeModules.add(realDirectory);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.name.startsWith("@")) {
        const scopePath = path.join(directory, entry.name);
        let scopedEntries: fs.Dirent[];
        try {
          scopedEntries = fs.readdirSync(scopePath, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const scopedEntry of scopedEntries) {
          if (scopedEntry.name.startsWith(".")) continue;
          inspectPackage(path.join(scopePath, scopedEntry.name));
        }
      } else {
        inspectPackage(path.join(directory, entry.name));
      }
    }
  };

  const inspectPackage = (packagePath: string): void => {
    let isDirectory = false;
    try {
      isDirectory = fs.statSync(packagePath).isDirectory();
    } catch {
      return;
    }
    if (!isDirectory) return;
    if (fs.existsSync(path.join(packagePath, "package.json"))) packages.push(packagePath);
    visitNodeModules(path.join(packagePath, "node_modules"));
  };

  visitNodeModules(nodeModulesPath);
  return packages;
}

function installedPackages(payloadPath: string, packageName: string): string[] {
  const nodeModulesPath = path.join(payloadPath, "node_modules");
  return walkInstalledPackages(nodeModulesPath).filter(
    (packagePath) => packageNameFromNodeModulesPath(packagePath) === packageName,
  );
}

function lockPackages(payloadPath: string, packageName: string): Array<[string, LockPackage]> {
  const lockPath = path.join(payloadPath, "package-lock.json");
  const lock = readJson(lockPath, "npm package-lock.json");
  if (lock.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== "object") {
    fail("npm package-lock.json must be a version 3 package lock");
  }
  return Object.entries(lock.packages as Record<string, LockPackage>).filter(([entryPath]) => {
    const normalized = entryPath.replace(/\\/g, "/");
    return normalized.endsWith("node_modules/" + packageName);
  });
}

function assertLockVersion(payloadPath: string, packageName: string, expectedVersion: string): void {
  const matches = lockPackages(payloadPath, packageName);
  if (matches.length !== 1 || matches[0]?.[1]?.version !== expectedVersion) {
    const actual = matches.map(([entryPath, entry]) => entryPath + "@" + (entry.version ?? "unknown"));
    fail(
      "npm lock must contain exactly " +
        packageName +
        "@" +
        expectedVersion +
        "; found " +
        (actual.join(", ") || "no entry"),
    );
  }
}

function readPackageManifest(packagePath: string, expectedName: string): PackageManifest {
  const manifest = readJson(path.join(packagePath, "package.json"), expectedName + " package.json");
  if (manifest.name !== expectedName || typeof manifest.version !== "string") {
    fail(expectedName + " has invalid package metadata");
  }
  return manifest as PackageManifest;
}

function readCodexAcpRuntimeSha256(packagePath: string): string {
  const manifest = readPackageManifest(packagePath, "@agentclientprotocol/codex-acp");
  if (manifest.version !== CODEX_ACP_VERSION) {
    fail(
      "expected @agentclientprotocol/codex-acp@" +
        CODEX_ACP_VERSION +
        ", found " +
        (manifest.version ?? "unknown"),
    );
  }
  const runtimePath = path.join(packagePath, "dist", "index.js");
  let runtime: string;
  try {
    runtime = fs.readFileSync(runtimePath, "utf8");
  } catch (cause) {
    throw new Error(
      "ACP runtime integrity check failed: could not read codex-acp runtime",
      { cause },
    );
  }
  return createHash("sha256").update(runtime).digest("hex");
}

function assertPatchedPackage(packagePath: string): void {
  const manifest = readPackageManifest(packagePath, "@agentclientprotocol/codex-acp");
  if (manifest.dependencies?.["@openai/codex"] !== CODEX_RUNTIME_VERSION) {
    fail(
      "codex-acp package manifest must pin @openai/codex@" +
        CODEX_RUNTIME_VERSION,
    );
  }
  const actualRuntimeSha256 = readCodexAcpRuntimeSha256(packagePath);
  if (actualRuntimeSha256 !== CODEX_ACP_RUNTIME_SHA256) {
    fail(
      "codex-acp@" +
        CODEX_ACP_VERSION +
        " executable runtime digest mismatch: expected sha256:" +
        CODEX_ACP_RUNTIME_SHA256 +
        ", found sha256:" +
        actualRuntimeSha256,
    );
  }
}

function assertPatchAsset(patchPath: string): string {
  let patchText: string;
  try {
    patchText = fs.readFileSync(patchPath, "utf8");
  } catch (cause) {
    throw new Error(
      "ACP runtime integrity check failed: bundled codex-acp patch is missing",
      { cause },
    );
  }
  const actualHash = createHash("sha256").update(patchText).digest("hex");
  if (actualHash !== CODEX_ACP_PATCH_SHA256) {
    fail(
      "bundled codex-acp patch hash mismatch: expected " +
        CODEX_ACP_PATCH_SHA256 +
        ", received " +
        actualHash,
    );
  }
  return patchText;
}

type ParsedHunk = {
  oldStart: number;
  oldLines: string[];
  newLines: string[];
};

type ParsedFilePatch = {
  filePath: string;
  hunks: ParsedHunk[];
};

function parseUnifiedPatch(patchText: string): ParsedFilePatch[] {
  const lines = patchText.replace(/\r\n/g, "\n").split("\n");
  const patches: ParsedFilePatch[] = [];
  let current: ParsedFilePatch | null = null;
  let index = 0;

  while (index < lines.length) {
    const diffHeader = lines[index]?.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (diffHeader) {
      current = { filePath: diffHeader[2]!, hunks: [] };
      patches.push(current);
      index += 1;
      continue;
    }
    const hunkHeader = lines[index]?.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!hunkHeader || !current) {
      index += 1;
      continue;
    }

    const oldCount = Number(hunkHeader[2] ?? 1);
    const newCount = Number(hunkHeader[4] ?? 1);
    const hunk: ParsedHunk = {
      oldStart: Number(hunkHeader[1]),
      oldLines: [],
      newLines: [],
    };
    index += 1;
    while (
      index < lines.length &&
      (hunk.oldLines.length < oldCount || hunk.newLines.length < newCount)
    ) {
      const line = lines[index]!;
      if (line === "\\ No newline at end of file") {
        index += 1;
        continue;
      }
      if (line.startsWith(" ")) {
        hunk.oldLines.push(line.slice(1));
        hunk.newLines.push(line.slice(1));
      } else if (line.startsWith("-")) {
        hunk.oldLines.push(line.slice(1));
      } else if (line.startsWith("+")) {
        hunk.newLines.push(line.slice(1));
      } else {
        fail("invalid unified patch hunk line at " + current.filePath);
      }
      index += 1;
    }
    if (hunk.oldLines.length !== oldCount || hunk.newLines.length !== newCount) {
      fail("incomplete unified patch hunk for " + current.filePath);
    }
    current.hunks.push(hunk);
  }

  if (patches.length === 0 || patches.some(({ hunks }) => hunks.length === 0)) {
    fail("the bundled codex-acp patch contains no applicable hunks");
  }
  return patches;
}

function findHunk(lines: string[], oldLines: string[], preferredIndex: number): number {
  const matches: number[] = [];
  for (let index = 0; index <= lines.length - oldLines.length; index += 1) {
    if (oldLines.every((line, offset) => lines[index + offset] === line)) {
      matches.push(index);
    }
  }
  if (matches.includes(preferredIndex)) return preferredIndex;
  if (matches.length === 1) return matches[0]!;
  return -1;
}

function applyFilePatch(packagePath: string, filePatch: ParsedFilePatch): void {
  const filePath = path.join(packagePath, filePatch.filePath);
  let source: string;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch (cause) {
    throw new Error(
      "ACP runtime integrity check failed: patch target is missing: " + filePatch.filePath,
      { cause },
    );
  }
  const hasTrailingNewline = source.endsWith("\n");
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  if (hasTrailingNewline) lines.pop();
  let offset = 0;
  for (const hunk of filePatch.hunks) {
    const preferredIndex = Math.max(0, hunk.oldStart - 1 + offset);
    const at = findHunk(lines, hunk.oldLines, preferredIndex);
    if (at < 0) {
      fail(
        "codex-acp patch does not match " +
          filePatch.filePath +
          " near line " +
          hunk.oldStart,
      );
    }
    lines.splice(at, hunk.oldLines.length, ...hunk.newLines);
    offset += hunk.newLines.length - hunk.oldLines.length;
  }
  fs.writeFileSync(filePath, lines.join("\n") + (hasTrailingNewline ? "\n" : ""));
}

export function applyCodexAcpPatch(packagePath: string, patchPath: string): void {
  const patchText = assertPatchAsset(patchPath);
  const actualRuntimeSha256 = readCodexAcpRuntimeSha256(packagePath);
  if (actualRuntimeSha256 === CODEX_ACP_RUNTIME_SHA256) {
    assertPatchedPackage(packagePath);
    return;
  }
  for (const filePatch of parseUnifiedPatch(patchText)) {
    if (filePatch.filePath !== "package.json" && filePatch.filePath !== "dist/index.js") {
      fail("unexpected codex-acp patch target: " + filePatch.filePath);
    }
    applyFilePatch(packagePath, filePatch);
  }
  assertPatchedPackage(packagePath);
}

function resolveRuntimeFromAcp(acpPackagePath: string): string | null {
  let current = acpPackagePath;
  while (true) {
    const candidate = path.join(current, "node_modules", "@openai", "codex");
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function verifyCodexAcpPayload(payloadPath: string): void {
  assertCodexAcpLock(payloadPath);
  assertPatchAsset(
    path.join(
      payloadPath,
      "node_modules",
      "paperclipai",
      CODEX_ACP_PATCH_RELATIVE_PATH,
    ),
  );

  const acpPackages = installedPackages(
    payloadPath,
    "@agentclientprotocol/codex-acp",
  );
  const runtimePackages = installedPackages(payloadPath, "@openai/codex");
  const acpRealpaths = new Set(acpPackages.map((packagePath) => fs.realpathSync(packagePath)));
  const runtimeRealpaths = new Set(
    runtimePackages.map((packagePath) => fs.realpathSync(packagePath)),
  );
  if (acpRealpaths.size !== 1) {
    fail(
      "expected one installed codex-acp package path, found " +
        String(acpRealpaths.size),
    );
  }
  if (runtimeRealpaths.size !== 1) {
    fail(
      "expected one installed @openai/codex package path, found " +
        String(runtimeRealpaths.size),
    );
  }
  if (acpPackages.length === 0 || runtimePackages.length === 0) {
    fail("the installed ACP/Codex runtime package graph is incomplete");
  }

  const runtimePackagePath = runtimePackages[0]!;
  const runtimeManifest = readPackageManifest(runtimePackagePath, "@openai/codex");
  if (runtimeManifest.version !== CODEX_RUNTIME_VERSION) {
    fail(
      "expected @openai/codex@" +
        CODEX_RUNTIME_VERSION +
        ", found " +
        (runtimeManifest.version ?? "unknown"),
    );
  }
  const runtimeRealpath = fs.realpathSync(runtimePackagePath);
  for (const acpPackagePath of acpPackages) {
    assertPatchedPackage(acpPackagePath);
    const resolvedRuntimePath = resolveRuntimeFromAcp(acpPackagePath);
    if (!resolvedRuntimePath || fs.realpathSync(resolvedRuntimePath) !== runtimeRealpath) {
      fail(
        "codex-acp nested runtime does not resolve to the single installed @openai/codex@" +
          CODEX_RUNTIME_VERSION +
          " path",
      );
    }
  }
}

export function assertCodexAcpLock(payloadPath: string): void {
  assertLockVersion(
    payloadPath,
    "@agentclientprotocol/codex-acp",
    CODEX_ACP_VERSION,
  );
  assertLockVersion(payloadPath, "@openai/codex", CODEX_RUNTIME_VERSION);
}

export function patchCodexAcpPackages(payloadPath: string, patchPath: string): void {
  assertPatchAsset(patchPath);
  const acpPackages = installedPackages(
    payloadPath,
    "@agentclientprotocol/codex-acp",
  );
  if (acpPackages.length === 0) {
    fail("the installed payload does not contain codex-acp");
  }
  for (const packagePath of acpPackages) {
    applyCodexAcpPatch(packagePath, patchPath);
  }
}

export function writeCodexNpmOverrides(
  packageRoot: string,
  dependencies: Record<string, string> = {},
): void {
  fs.mkdirSync(packageRoot, { recursive: true, mode: 0o700 });
  const manifest = {
    name: "paperclip-managed-runtime-stage",
    version: "0.0.0",
    private: true,
    dependencies,
    overrides: {
      "@agentclientprotocol/codex-acp": CODEX_ACP_VERSION,
      "@openai/codex": CODEX_RUNTIME_VERSION,
    },
  };
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    { mode: 0o600 },
  );
}
