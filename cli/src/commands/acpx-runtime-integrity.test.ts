import fs from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODEX_ACP_PATCH_RELATIVE_PATH,
  CODEX_ACP_RUNTIME_SHA256,
  CODEX_ACP_VERSION,
  CODEX_RUNTIME_VERSION,
  applyCodexAcpPatch,
  verifyCodexAcpPayload,
  writeCodexNpmOverrides,
} from "./acpx-runtime-integrity.js";

const PATCH_MARKERS = [
  "if (!context.isToolApproval && this.shouldUseAcpElicitation(params))",
  "rawInput: { serverName: params.serverName }",
  "function paperclipBaseInstructions(request)",
  "function paperclipSandboxPolicy(sandboxPolicy)",
  "baseInstructions: paperclipBaseInstructions(request)",
  '"include_apps_instructions": false',
  'process.env.PAPERCLIP_ACPX_ISOLATED_CONTEXT !== "1"',
  'const isolated = process.env.PAPERCLIP_ACPX_ISOLATED_CONTEXT === "1"',
  "paperclipSandboxPolicy(agentMode.sandboxPolicy)",
];
const adapterRequire = createRequire(
  new URL("../../../packages/adapters/codex-local/package.json", import.meta.url),
);
const patchedAcpRuntimePath = adapterRequire.resolve("@agentclientprotocol/codex-acp");
const patchedAcpPackagePath = path.dirname(path.dirname(patchedAcpRuntimePath));
const patchedAcpRuntimeSource = fs.readFileSync(patchedAcpRuntimePath, "utf8");

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function createRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-acpx-integrity-"));
  roots.push(root);
  return root;
}

function writePackage(packagePath: string, manifest: unknown): void {
  fs.mkdirSync(packagePath, { recursive: true });
  fs.writeFileSync(path.join(packagePath, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
}

function writePayload(
  root: string,
  {
    acpVersion = CODEX_ACP_VERSION,
    codexVersion = CODEX_RUNTIME_VERSION,
    runtimeSource = patchedAcpRuntimeSource,
  }: { acpVersion?: string; codexVersion?: string; runtimeSource?: string } = {},
): void {
  const nodeModules = path.join(root, "node_modules");
  writePackage(path.join(nodeModules, "paperclipai"), {
    name: "paperclipai",
    version: "0.3.1",
  });
  const patchAsset = path.join(
    nodeModules,
    "paperclipai",
    CODEX_ACP_PATCH_RELATIVE_PATH,
  );
  fs.mkdirSync(path.dirname(patchAsset), { recursive: true });
  fs.copyFileSync(
    new URL("../../../patches/@agentclientprotocol__codex-acp@1.6.2.patch", import.meta.url),
    patchAsset,
  );
  const acpPath = path.join(nodeModules, "@agentclientprotocol", "codex-acp");
  writePackage(acpPath, {
    name: "@agentclientprotocol/codex-acp",
    version: acpVersion,
    dependencies: { "@openai/codex": CODEX_RUNTIME_VERSION },
  });
  fs.mkdirSync(path.join(acpPath, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(acpPath, "dist", "index.js"),
    runtimeSource,
  );
  writePackage(path.join(nodeModules, "@openai", "codex"), {
    name: "@openai/codex",
    version: codexVersion,
  });
  fs.writeFileSync(
    path.join(root, "package-lock.json"),
    JSON.stringify({
      name: "paperclip-managed-runtime-stage",
      lockfileVersion: 3,
      packages: {
        "": { version: "0.0.0" },
        "node_modules/@agentclientprotocol/codex-acp": { version: acpVersion },
        "node_modules/@openai/codex": { version: codexVersion },
        "node_modules/paperclipai": { version: "0.3.1" },
      },
    }),
  );
}

describe("Codex ACP runtime integrity", () => {
  it("writes exact npm overrides before dependency resolution", () => {
    const root = createRoot();
    writeCodexNpmOverrides(root, { paperclipai: "2026.9.30" });
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

    expect(manifest.dependencies).toEqual({ paperclipai: "2026.9.30" });
    expect(manifest.overrides).toEqual({
      "@agentclientprotocol/codex-acp": CODEX_ACP_VERSION,
      "@openai/codex": CODEX_RUNTIME_VERSION,
    });
  });

  it("applies the packaged unified patch and accepts an idempotent second pass", () => {
    const root = createRoot();
    const packagePath = path.join(root, "node_modules", "@agentclientprotocol", "codex-acp");
    writePackage(packagePath, {
      name: "@agentclientprotocol/codex-acp",
      version: CODEX_ACP_VERSION,
      dependencies: { "@openai/codex": CODEX_RUNTIME_VERSION },
    });
    fs.mkdirSync(path.join(packagePath, "dist"), { recursive: true });
    fs.copyFileSync(
      patchedAcpRuntimePath,
      path.join(packagePath, "dist", "index.js"),
    );
    const patchPath = path.join(root, CODEX_ACP_PATCH_RELATIVE_PATH);
    fs.mkdirSync(path.dirname(patchPath), { recursive: true });
    fs.copyFileSync(
      new URL("../../../patches/@agentclientprotocol__codex-acp@1.6.2.patch", import.meta.url),
      patchPath,
    );

    applyCodexAcpPatch(packagePath, patchPath);
    applyCodexAcpPatch(packagePath, patchPath);

    expect(JSON.parse(fs.readFileSync(path.join(packagePath, "package.json"), "utf8")).dependencies[
      "@openai/codex"
    ]).toBe(CODEX_RUNTIME_VERSION);
    expect(
      fs.readFileSync(path.join(packagePath, "dist", "index.js"), "utf8"),
    ).toBe(patchedAcpRuntimeSource);
    expect(
      createHash("sha256")
        .update(fs.readFileSync(path.join(packagePath, "dist", "index.js")))
        .digest("hex"),
    ).toBe(CODEX_ACP_RUNTIME_SHA256);
  });

  it("checks the lock, installed versions, shared realpath, and exact patched runtime", () => {
    const root = createRoot();
    writePayload(root);
    expect(() => verifyCodexAcpPayload(root)).not.toThrow();
  });

  it("rejects an ACP lock mismatch", () => {
    const root = createRoot();
    writePayload(root, { acpVersion: "1.13.1" });
    expect(() => verifyCodexAcpPayload(root)).toThrow(
      "lock must contain exactly @agentclientprotocol/codex-acp@1.6.2",
    );
  });

  it("rejects a Codex lock mismatch", () => {
    const root = createRoot();
    writePayload(root, { codexVersion: "0.156.0" });
    expect(() => verifyCodexAcpPayload(root)).toThrow(
      "lock must contain exactly @openai/codex@0.159.1",
    );
  });

  it("rejects patch markers that exist only as comments", () => {
    const root = createRoot();
    writePayload(root, {
      runtimeSource:
        '"use strict";\n' + PATCH_MARKERS.map((marker) => "// " + marker).join("\n") + "\n",
    });
    expect(() => verifyCodexAcpPayload(root)).toThrow(
      "executable runtime digest mismatch",
    );
  });
});
