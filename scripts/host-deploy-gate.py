#!/usr/bin/env python3
"""Fail-closed host-side Paperclip deployment command gate.

This program never starts or stops task drain. See doc/HOST-DEPLOY-GATE.md.
"""

import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


class GateError(Exception):
    pass


def utc_now():
    return dt.datetime.now(dt.timezone.utc)


def parse_time(value):
    if not isinstance(value, str) or not value.endswith("Z"):
        raise GateError("timestamp must be UTC with Z suffix")
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise GateError("invalid UTC timestamp") from exc


def digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def checked_file(entry, label):
    if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
        raise GateError(f"{label}: missing path")
    expected = entry.get("sha256")
    if not isinstance(expected, str) or len(expected) != 64 or any(c not in "0123456789abcdef" for c in expected):
        raise GateError(f"{label}: invalid SHA-256")
    path = Path(entry["path"])
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        raise GateError(f"{label}: missing or unsafe file")
    if digest(path) != expected:
        raise GateError(f"{label}: checksum mismatch")


def check_receipts(manifest):
    for label in ("artifact", "backup", "restoreReceipt", "rollback"):
        checked_file(manifest.get(label), label)
    backup = manifest["backup"]
    if parse_time(backup["createdAt"]) < parse_time(manifest["notBefore"]):
        raise GateError("backup predates authorized window")
    if parse_time(backup["createdAt"]) >= utc_now():
        raise GateError("backup timestamp is not in the past")
    if (utc_now() - parse_time(backup["createdAt"])).total_seconds() > 900:
        raise GateError("backup is older than 15 minutes")
    receipt = json.loads(Path(manifest["restoreReceipt"]["path"]).read_text())
    if (receipt.get("result") != "passed" or
            receipt.get("backupSha256") != backup["sha256"] or
            receipt.get("decisionRevision") != manifest["decision"]["revisionId"]):
        raise GateError("isolated restore receipt does not match decision and backup")
    if parse_time(receipt["verifiedAt"]) < parse_time(backup["createdAt"]):
        raise GateError("restore verification predates backup")


def api(base, token, route):
    request = urllib.request.Request(base + route, headers={"Authorization": "Bearer " + token})
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            if response.status != 200:
                raise GateError(f"API {route}: HTTP {response.status}")
            return json.load(response)
    except (urllib.error.URLError, ValueError, TimeoutError) as exc:
        raise GateError(f"API {route}: unavailable or invalid response ({type(exc).__name__})") from exc


def check_deadline(manifest):
    if utc_now() >= parse_time(manifest["expiresAt"]):
        raise GateError("decision window expired")


def check_hold(manifest, base, token):
    hold = api(base, token, "/api/instance/task-drain")
    receipt = manifest["hold"]
    if hold.get("draining") is not True or hold.get("startedAt") != receipt["startedAt"]:
        raise GateError("supported task-drain hold absent or changed")
    if hold.get("expiresAt") != receipt["expiresAt"]:
        raise GateError("task-drain expiry changed")
    if parse_time(receipt["expiresAt"]) <= utc_now():
        raise GateError("task-drain hold expired")
    if type(hold.get("activeRuns")) is not int or type(hold.get("pendingWakes")) is not int:
        raise GateError("task-drain process counts missing")
    if hold["activeRuns"] or hold["pendingWakes"] or hold.get("quiescent") is not True:
        raise GateError("task-drain process is not quiescent")
    return hold


def inventory(manifest, base, token):
    expected = manifest["companyIds"]
    companies = api(base, token, "/api/companies")
    if not isinstance(companies, list) or not companies:
        raise GateError("company inventory unavailable")
    ids = [company.get("id") for company in companies if isinstance(company, dict)]
    if len(ids) != len(companies) or set(ids) != set(expected) or len(ids) != len(set(ids)):
        raise GateError("company inventory differs from decision")
    rows = []
    for company_id in sorted(ids):
        route = "/api/companies/" + urllib.parse.quote(company_id, safe="") + "/live-runs?minCount=0&limit=50"
        current = api(base, token, route)
        if not isinstance(current, list) or len(current) >= 50:
            raise GateError(f"live-run inventory unavailable or saturated for {company_id}")
        for row in current:
            if not isinstance(row, dict) or not isinstance(row.get("id"), str) or row.get("companyId") != company_id:
                raise GateError("live-run inventory row invalid")
            if row.get("status") not in ("queued", "running"):
                raise GateError("live-run inventory status invalid")
            rows.append((company_id, row["id"], row["status"], row.get("livenessState")))
    if len(rows) != len(set((row[0], row[1]) for row in rows)):
        raise GateError("duplicate live-run rows")
    running = sum(row[2] == "running" or row[3] == "reconnecting" for row in rows)
    snapshot = {"running": running, "queued": sum(row[2] == "queued" for row in rows),
                "rowsSha256": hashlib.sha256(json.dumps(sorted(rows), separators=(",", ":")).encode()).hexdigest()}
    if running:
        raise GateError(f"database-backed inventory has {running} running/reconnecting rows")
    return snapshot


def report(path, event):
    event = {"at": utc_now().isoformat().replace("+00:00", "Z"), **event}
    flags = os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags, 0o600)
    try:
        with os.fdopen(fd, "a") as stream:
            stream.write(json.dumps(event, sort_keys=True) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
    except Exception:
        os.close(fd)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--phase", choices=("replace", "restart"), required=True)
    parser.add_argument("--settle-seconds", type=float, default=3)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command or not 0 < args.settle_seconds <= 30:
        parser.error("a command after -- and a settle interval of 0-30 seconds are required")
    manifest_path = Path(args.manifest)
    report_path = manifest_path.with_suffix(".report.jsonl")
    state_path = manifest_path.with_suffix(".state.json")
    lock_path = manifest_path.with_suffix(".lock")
    try:
        manifest = json.loads(manifest_path.read_text())
        if not isinstance(manifest, dict):
            raise ValueError("manifest must be an object")
    except (OSError, ValueError) as exc:
        report(report_path, {"phase": args.phase, "gate": "abort", "reason": f"manifest unavailable or invalid ({type(exc).__name__})"})
        print(f"ABORT: manifest unavailable or invalid ({type(exc).__name__})", file=sys.stderr)
        return 1
    # Paths and URL are operator-owned host configuration. All manifest fields
    # are checked again in each phase; neither invocation trusts prior success.
    manifest_sha = digest(manifest_path)
    with open(lock_path, "a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            if manifest.get("version") != 1 or manifest.get("service") != "paperclipai.service":
                raise GateError("unsupported manifest or service")
            decision = manifest["decision"]
            if not all(isinstance(decision.get(key), str) and decision[key] for key in ("issueId", "documentKey", "revisionId")):
                raise GateError("decision binding incomplete")
            if not isinstance(manifest.get("companyIds"), list) or not manifest["companyIds"]:
                raise GateError("company coverage absent")
            if not all(isinstance(value, str) and value for value in manifest["companyIds"]):
                raise GateError("invalid company ID")
            approved_command = manifest.get("commands", {}).get(args.phase)
            if approved_command != command:
                raise GateError("command differs from decision manifest")
            base = manifest["apiBaseUrl"].rstrip("/")
            if base != "http://127.0.0.1:3100":
                raise GateError("API target must be the local Paperclip instance")
            token = os.environ.get("PAPERCLIP_DEPLOY_API_TOKEN")
            if not token:
                raise GateError("authorized board API token unavailable")
            check_deadline(manifest)
            route = "/api/issues/" + urllib.parse.quote(decision["issueId"], safe="") + "/documents/" + urllib.parse.quote(decision["documentKey"], safe="")
            document = api(base, token, route)
            if document.get("latestRevisionId") != decision["revisionId"]:
                raise GateError("deployment decision revision changed")
            report(report_path, {"phase": args.phase, "gate": "decision-current", "decisionRevision": decision["revisionId"]})
            check_receipts(manifest)
            report(report_path, {"phase": args.phase, "gate": "receipts-valid", "decisionRevision": decision["revisionId"],
                                 "artifactSha256": manifest["artifact"]["sha256"], "backupSha256": manifest["backup"]["sha256"],
                                 "rollbackSha256": manifest["rollback"]["sha256"]})
            state = json.loads(state_path.read_text()) if state_path.exists() else None
            if args.phase == "replace" and state is not None:
                raise GateError("single-use decision already entered")
            if args.phase == "restart" and (not isinstance(state, dict) or state.get("manifestSha256") != manifest_sha or state.get("phase") != "replaced"):
                raise GateError("matching successful replacement absent")
            first_hold = check_hold(manifest, base, token)
            report(report_path, {"phase": args.phase, "gate": "hold-1", "decisionRevision": decision["revisionId"],
                                 "startedAt": first_hold["startedAt"], "activeRuns": first_hold["activeRuns"],
                                 "pendingWakes": first_hold["pendingWakes"]})
            first = inventory(manifest, base, token)
            report(report_path, {"phase": args.phase, "gate": "inventory-1", **first, "decisionRevision": decision["revisionId"]})
            time.sleep(args.settle_seconds)
            check_deadline(manifest)
            second_hold = check_hold(manifest, base, token)
            report(report_path, {"phase": args.phase, "gate": "hold-2", "decisionRevision": decision["revisionId"],
                                 "startedAt": second_hold["startedAt"], "activeRuns": second_hold["activeRuns"],
                                 "pendingWakes": second_hold["pendingWakes"]})
            if second_hold["startedAt"] != first_hold["startedAt"]:
                raise GateError("task-drain process changed")
            second = inventory(manifest, base, token)
            report(report_path, {"phase": args.phase, "gate": "inventory-2", **second, "decisionRevision": decision["revisionId"]})
            if first != second:
                raise GateError("live-run inventory was not stable")
            # Hash potentially large artifacts before rechecking mutable authority
            # and deadlines, so hashing cannot consume the last valid window.
            check_receipts(manifest)
            document = api(base, token, route)
            if document.get("latestRevisionId") != decision["revisionId"]:
                raise GateError("deployment decision revision changed before command")
            final_hold = check_hold(manifest, base, token)
            if final_hold["startedAt"] != first_hold["startedAt"]:
                raise GateError("task-drain process changed before command")
            report(report_path, {"phase": args.phase, "gate": "hold-final", "decisionRevision": decision["revisionId"],
                                 "startedAt": final_hold["startedAt"], "activeRuns": final_hold["activeRuns"],
                                 "pendingWakes": final_hold["pendingWakes"]})
            check_deadline(manifest)
            report(report_path, {"phase": args.phase, "gate": "deadline-and-receipts-final", "decisionRevision": decision["revisionId"]})
            # Consume before launching: crashes and failures cannot silently replay.
            state_path.write_text(json.dumps({"manifestSha256": manifest_sha, "phase": "replacing" if args.phase == "replace" else "restarting"}))
            os.chmod(state_path, 0o600)
            report(report_path, {"phase": args.phase, "gate": "passed", "decisionRevision": decision["revisionId"]})
            result = subprocess.run(command, check=False)
            if result.returncode:
                raise GateError(f"guarded command failed with exit {result.returncode}")
            state_path.write_text(json.dumps({"manifestSha256": manifest_sha, "phase": "replaced" if args.phase == "replace" else "complete"}))
            report(report_path, {"phase": args.phase, "gate": "command-complete", "decisionRevision": decision["revisionId"]})
        except Exception as exc:
            reason = str(exc) if isinstance(exc, GateError) else f"invalid or unavailable gate evidence ({type(exc).__name__})"
            try:
                report(report_path, {"phase": args.phase, "gate": "abort", "reason": reason, "decisionRevision": manifest.get("decision", {}).get("revisionId") if isinstance(manifest.get("decision"), dict) else None})
            except OSError:
                print(f"ABORT at {utc_now().isoformat()}: report unavailable", file=sys.stderr)
            print(f"ABORT: {reason}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
