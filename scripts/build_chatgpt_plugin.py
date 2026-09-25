#!/usr/bin/env python3
"""Build allowlisted ChatGPT plugin ZIPs without network access or dependencies."""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import sys
import zipfile

PLUGIN = Path("plugins/remotedesktopmcp")
MANIFEST = PLUGIN / ".codex-plugin/plugin.json"
SKILL = PLUGIN / "skills/remotedesktopmcp/SKILL.md"
GUIDE = Path("doc/chatgpt-setup.md")
SOURCE_FILES = (MANIFEST, SKILL, GUIDE)
CORE = r"(?:0|[1-9][0-9]*)"
PRE = r"(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)"
VERSION = re.compile(rf"{CORE}\.{CORE}\.{CORE}(?:-{PRE}(?:\.{PRE})*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?")
APP_ID = re.compile(r"(?:plugin_asdk_app|connector)_[A-Za-z0-9_-]{8,160}")


def json_bytes(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def read_source(root: Path, relative: Path) -> bytes:
    """Reject symlinks in each allowlisted path; never recursively collect files."""
    current = root
    for part in relative.parts:
        current /= part
        if current.is_symlink():
            raise ValueError(f"source symlink is not allowed: {relative}")
    return current.read_bytes().replace(b"\r\n", b"\n")


def zip_bytes(entries: dict[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in sorted(entries.items()):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, data, compresslevel=9)
    return buffer.getvalue()


def build(root: Path, output: Path, app_id: str = "", revision: str = "uncommitted") -> list[Path]:
    """Create a fresh artifact directory. An ID is syntax-checked, not authenticated."""
    root = root.resolve(strict=True)
    if app_id and (not APP_ID.fullmatch(app_id) or any(
        word in app_id.lower() for word in ("replace", "placeholder", "example", "your_id")
    )):
        raise ValueError("provide an actual ChatGPT app ID, not a URL, token, or placeholder")
    package = json.loads(read_source(root, Path("package.json")))
    version = package.get("version")
    if not isinstance(version, str) or not VERSION.fullmatch(version) or len(version) > 100:
        raise ValueError("package.json version must be a filename-safe semantic version")
    manifest = json.loads(read_source(root, MANIFEST))
    if (set(manifest) != {"name", "version", "description", "skills"}
            or manifest["name"] != "remotedesktopmcp" or manifest["skills"] != "./skills/"):
        raise ValueError("unexpected template manifest fields or component paths")
    manifest["version"] = version
    skill = read_source(root, SKILL)
    if not skill.startswith(b"---\nname: remotedesktopmcp\n"):
        raise ValueError("invalid skill front matter")
    guide = read_source(root, GUIDE)
    metadata = {
        "version": version, "revision": revision,
        "mcp_binding_configured": False,
        "connection_verified": False, "server_runtime_tested": False,
    }
    entries = {
        ".codex-plugin/plugin.json": json_bytes(manifest),
        "skills/remotedesktopmcp/SKILL.md": skill,
        "CHATGPT-SETUP.md": guide,
        "build-info.json": json_bytes(metadata),
    }
    stem = "remotedesktopmcp-chatgpt-plugin"
    assets = {f"{stem}-template-v{version}.zip": zip_bytes(entries), "CHATGPT-SETUP.md": guide}
    if app_id:
        manifest = dict(manifest, apps="./.app.json", description="RemoteDesktopMCP workflows for a separately authorized MCP connection.")
        metadata = dict(metadata, mcp_binding_configured=True)
        entries = dict(entries)
        entries[".codex-plugin/plugin.json"] = json_bytes(manifest)
        entries[".app.json"] = json_bytes({"apps": {"remotedesktopmcp": {"id": app_id}}})
        entries["build-info.json"] = json_bytes(metadata)
        assets[f"{stem}-v{version}.zip"] = zip_bytes(entries)
    assets["build-info.json"] = json_bytes(metadata)
    assets["SHA256SUMS"] = "".join(
        f"{hashlib.sha256(data).hexdigest()}  {name}\n" for name, data in sorted(assets.items())
    ).encode("utf-8")
    # Validate and build everything in memory before creating any output.
    # A new directory prevents stale configured ZIPs from leaking into a later release.
    output.mkdir(parents=True, exist_ok=False)
    for name, data in sorted(assets.items()):
        (output / name).write_bytes(data)
    return [output / name for name in sorted(assets)]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--output", type=Path, required=True, help="new artifact directory")
    parser.add_argument("--app-id", default=os.environ.get("CHATGPT_MCP_APP_ID", ""))
    parser.add_argument("--revision", default="uncommitted")
    args = parser.parse_args()
    try:
        paths = build(args.root, args.output, args.app_id, args.revision)
    except (OSError, ValueError, TypeError, KeyError) as error:
        print(f"plugin build failed: {error}", file=sys.stderr)
        return 1
    for path in paths:
        print(path)
    print("MCP connection and runtime readiness were NOT verified by this build.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
