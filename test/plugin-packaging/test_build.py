"""Contract tests for the standalone ChatGPT plugin artifact builder."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("plugin_build", ROOT / "scripts/build_chatgpt_plugin.py")
assert SPEC and SPEC.loader
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)
APP_ID = "plugin_asdk_app_0123456789abcdef0123456789abcdef"  # Test fixture only.
REVISION = "a" * 40


class BuildTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "source"
        self.root.mkdir()
        for relative in builder.SOURCE_FILES:
            target = self.root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / relative, target)
        (self.root / "package.json").write_text('{"version":"1.2.3-rc.1"}', encoding="utf-8")
        self.output = Path(self.temp.name) / "output"

    def build(self, app_id="", output=None):
        return builder.build(self.root, output or self.output, app_id, REVISION)

    def test_template_has_no_connection_or_extra_parent(self):
        self.build()
        archives = list(self.output.glob("*.zip"))
        self.assertEqual([p.name for p in archives], ["remotedesktopmcp-chatgpt-plugin-template-v1.2.3-rc.1.zip"])
        with zipfile.ZipFile(archives[0]) as archive:
            self.assertIsNone(archive.testzip())
            self.assertEqual(set(archive.namelist()), {
                ".codex-plugin/plugin.json", "skills/remotedesktopmcp/SKILL.md",
                "CHATGPT-SETUP.md", "build-info.json"})
            manifest = json.loads(archive.read(".codex-plugin/plugin.json"))
            self.assertEqual(manifest["version"], "1.2.3-rc.1")
            self.assertNotIn("apps", manifest)
            self.assertFalse(json.loads(archive.read("build-info.json"))["mcp_binding_configured"])

    def test_bound_archive_uses_exact_id_without_modifying_template(self):
        self.build(APP_ID)
        self.assertEqual(len(list(self.output.glob("*.zip"))), 2)
        path = self.output / "remotedesktopmcp-chatgpt-plugin-v1.2.3-rc.1.zip"
        with zipfile.ZipFile(path) as archive:
            self.assertEqual(json.loads(archive.read(".app.json")), {"apps": {"remotedesktopmcp": {"id": APP_ID}}})
            manifest = json.loads(archive.read(".codex-plugin/plugin.json"))
            self.assertEqual(manifest["apps"], "./.app.json")
            metadata = json.loads(archive.read("build-info.json"))
            self.assertTrue(metadata["mcp_binding_configured"])
            self.assertFalse(metadata["connection_verified"])
        with zipfile.ZipFile(next(self.output.glob("*template*.zip"))) as template:
            self.assertNotIn(".app.json", template.namelist())
            self.assertNotIn(APP_ID.encode(), template.read("build-info.json"))

    def test_checksums_cover_every_other_asset(self):
        self.build(APP_ID)
        names = set()
        for line in (self.output / "SHA256SUMS").read_text().splitlines():
            digest, name = line.split("  ", 1)
            self.assertEqual(digest, hashlib.sha256((self.output / name).read_bytes()).hexdigest())
            names.add(name)
        self.assertEqual(names, {p.name for p in self.output.iterdir()} - {"SHA256SUMS"})

    def test_same_input_produces_identical_bytes(self):
        self.build(APP_ID)
        other = self.output.with_name("other")
        self.build(APP_ID, other)
        self.assertEqual({p.name: p.read_bytes() for p in self.output.iterdir()},
                         {p.name: p.read_bytes() for p in other.iterdir()})

    def test_unlisted_sensitive_files_are_not_packaged(self):
        secret = b"NEVER_INCLUDE_THIS_SENTINEL"
        (self.root / ".env").write_bytes(secret)
        (self.root / "plugins/remotedesktopmcp/.env").write_bytes(secret)
        self.build(APP_ID)
        for path in self.output.glob("*.zip"):
            with zipfile.ZipFile(path) as archive:
                self.assertTrue(all(secret not in archive.read(name) for name in archive.namelist()))

    def test_rejects_invalid_ids_before_creating_output(self):
        for value in ["wrong", "https://example.invalid/mcp", "plugin_asdk_app_...", "plugin_asdk_app_<ID>", "plugin_asdk_app_REPLACE_ME", "\n" + APP_ID, "sk-secret"]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.build(value)
            self.assertFalse(self.output.exists())

    def test_rejects_invalid_versions(self):
        for value in ["../secret", "1.2", "01.2.3", "1.2.3/other", "1.2.3-01", "1.2.3-"]:
            (self.root / "package.json").write_text(json.dumps({"version": value}))
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.build()
            self.assertFalse(self.output.exists())

    def test_missing_source_does_not_leave_partial_output(self):
        (self.root / "plugins/remotedesktopmcp/skills/remotedesktopmcp/SKILL.md").unlink()
        with self.assertRaises(FileNotFoundError):
            self.build()
        self.assertFalse(self.output.exists())

    def test_existing_output_is_not_overwritten(self):
        self.output.mkdir()
        sentinel = self.output / "keep.txt"
        sentinel.write_text("keep")
        with self.assertRaises(FileExistsError):
            self.build()
        self.assertEqual(sentinel.read_text(), "keep")
        self.assertEqual(list(self.output.iterdir()), [sentinel])

    def test_symlink_payload_is_rejected(self):
        target = self.root / "plugins/remotedesktopmcp/skills/remotedesktopmcp/SKILL.md"
        source = self.root / "outside.md"
        source.write_text("private content")
        target.unlink()
        try:
            os.symlink(source, target)
        except OSError as error:
            self.skipTest(f"host cannot create symlinks: {error}")
        with self.assertRaises(ValueError):
            self.build()
        self.assertFalse(self.output.exists())

    def test_manifest_external_paths_are_rejected(self):
        path = self.root / "plugins/remotedesktopmcp/.codex-plugin/plugin.json"
        manifest = json.loads(path.read_text())
        manifest["skills"] = "../../private"
        path.write_text(json.dumps(manifest))
        with self.assertRaises(ValueError):
            self.build()

    def test_crlf_checkout_produces_identical_artifacts(self):
        self.build(APP_ID)
        for relative in builder.SOURCE_FILES:
            path = self.root / relative
            path.write_bytes(path.read_bytes().replace(b"\n", b"\r\n"))
        other = self.output.with_name("crlf")
        self.build(APP_ID, other)
        self.assertEqual({p.name: p.read_bytes() for p in self.output.iterdir()},
                         {p.name: p.read_bytes() for p in other.iterdir()})

    def test_metadata_never_claims_live_readiness(self):
        self.build(APP_ID)
        metadata = json.loads((self.output / "build-info.json").read_text())
        self.assertEqual(metadata["revision"], REVISION)
        self.assertFalse(metadata["connection_verified"])
        self.assertFalse(metadata["server_runtime_tested"])


if __name__ == "__main__":
    unittest.main()
