import fs from "node:fs/promises";
import path from "node:path";
import { resolvePaperclipInstanceRoot } from "../config/home.js";

export function reportedVersionForPid(report: unknown, pid: number | null): string | null {
  if (!report || typeof report !== "object" || !pid) return null;
  const value = report as { newServerPid?: unknown; newServerVersion?: unknown };
  return value.newServerPid === pid && typeof value.newServerVersion === "string" && value.newServerVersion.length > 0
    ? value.newServerVersion
    : null;
}

export async function readReportedVersionForPid(instanceId: string, pid: number | null): Promise<string | null> {
  if (!pid) return null;
  try {
    const file = path.join(resolvePaperclipInstanceRoot(instanceId), "hot-restart-report.json");
    return reportedVersionForPid(JSON.parse(await fs.readFile(file, "utf8")) as unknown, pid);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
