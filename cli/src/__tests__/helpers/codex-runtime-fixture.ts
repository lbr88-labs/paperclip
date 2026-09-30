import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  CODEX_ACP_PATCH_RELATIVE_PATH,
  CODEX_ACP_VERSION,
  CODEX_RUNTIME_VERSION,
} from "../../commands/acpx-runtime-integrity.js";

const adapterRequire = createRequire(
  new URL("../../../../packages/adapters/codex-local/package.json", import.meta.url),
);
const patchedAcpRuntimePath = adapterRequire.resolve("@agentclientprotocol/codex-acp");
const patchedAcpRuntimeSource = fs.readFileSync(patchedAcpRuntimePath, "utf8");

function copyCodexAcpPatch(destination: string): void {
  const patchPath = path.join(destination, CODEX_ACP_PATCH_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(patchPath), { recursive: true });
  fs.copyFileSync(
    new URL("../../../../patches/@agentclientprotocol__codex-acp@1.6.2.patch", import.meta.url),
    patchPath,
  );
}

export function writeCodexRuntimePayload(
  payloadPath: string,
  {
    version = "0.3.1",
    acpVersion = CODEX_ACP_VERSION,
    codexVersion = CODEX_RUNTIME_VERSION,
    runtimeSource = patchedAcpRuntimeSource,
  }: {
    version?: string;
    acpVersion?: string;
    codexVersion?: string;
    runtimeSource?: string;
  } = {},
): void {
  const nodeModules = path.join(payloadPath, "node_modules");
  const cliPackage = path.join(nodeModules, "paperclipai");
  fs.mkdirSync(path.join(cliPackage, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(cliPackage, "package.json"),
    JSON.stringify({ name: "paperclipai", version }),
  );
  fs.writeFileSync(path.join(cliPackage, "dist", "index.js"), "#!/usr/bin/env node\n");
  copyCodexAcpPatch(cliPackage);

  const acpPackage = path.join(nodeModules, "@agentclientprotocol", "codex-acp");
  fs.mkdirSync(path.join(acpPackage, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(acpPackage, "package.json"),
    JSON.stringify({
      name: "@agentclientprotocol/codex-acp",
      version: acpVersion,
      dependencies: { "@openai/codex": CODEX_RUNTIME_VERSION },
    }),
  );
  fs.writeFileSync(path.join(acpPackage, "dist", "index.js"), runtimeSource);

  const codexPackage = path.join(nodeModules, "@openai", "codex");
  fs.mkdirSync(codexPackage, { recursive: true });
  fs.writeFileSync(
    path.join(codexPackage, "package.json"),
    JSON.stringify({ name: "@openai/codex", version: codexVersion }),
  );
  fs.writeFileSync(
    path.join(payloadPath, "package-lock.json"),
    JSON.stringify({
      name: "paperclip-managed-runtime-stage",
      lockfileVersion: 3,
      packages: {
        "": { version: "0.0.0" },
        "node_modules/@agentclientprotocol/codex-acp": { version: acpVersion },
        "node_modules/@openai/codex": { version: codexVersion },
        "node_modules/paperclipai": { version },
      },
    }),
  );
}
