# Environment verification

## Dispatch

Requested: gpt-6-luna / high; user override. Mechanical environment verification, fresh context, no role override; applied unknown. Scope: version and package compatibility inventory only.

## Evidence

- Repository: `C:\Users\donabe\Project\RemoteDesktopMCP`; branch `feat/tailscale-funnel-design-lint`; HEAD `83a3de32314edfbcd314f18936b083ac5b1dca9a`. PowerShell on Windows. At discovery, the worktree had untracked `reports/` and `skills/`; no tracked modifications were reported. This inventory changes only this pre-created report.
- Toolchain: Node `v24.20.0`, npm `11.19.0`, Git `2.46.0.windows.1`. Tailscale CLI is installed at `C:\Program Files\Tailscale\tailscale.exe`, version `1.102.4` (commit `3caf7d9e7dcaba589cfc58beda596929733e4fea`). Availability only; no Tailscale status or network/process action was taken.
- Registry metadata (`npm view @wonderwhy-er/desktop-commander`): current `latest` is `0.2.51`; `engines.node` is `>=18.0.0`. Recommended exact dependency/runner pin: `@wonderwhy-er/desktop-commander@0.2.51`. Verified tarball URL `https://registry.npmjs.org/@wonderwhy-er/desktop-commander/-/desktop-commander-0.2.51.tgz`, integrity `sha512-BF/ZV06c7mh+tzfJEkQpjcOg6UaQtzp2vRadIpA9hI+WpPDwkQ2ekdY0fbN7I4xOrCQX6NajyEPouEDXFJc1kA==`. Read-only package extraction is under `%TEMP%\dc-inspect-a04c3cc7e0ff48e9b2b745c3edef791c`, outside the repository.
- Package entry: `package.json` declares binary `desktop-commander` at `dist/index.js` (ES module, shebang Node entry). The same entry starts the stdio MCP server by default. Runtime flag `--no-onboarding` disables onboarding. Other advertised CLI paths are setup and remove commands, not needed for MCP startup. `--debug` is documented for the setup command.
- Desktop Commander’s own settings file is fixed by shipped `dist/config.js`: `path.join(os.homedir(), '.claude-server-commander', 'config.json')` (Windows: `%USERPROFILE%\.claude-server-commander\config.json`). No config-path override was found in the shipped code. This differs from a client’s MCP registration file; the README documents Claude Desktop’s as `%APPDATA%\Claude\claude_desktop_config.json` and Codex’s as `~/.codex/config.toml`. No user config was read or modified.
- Shipped MCP tool contracts are declared in `dist/server.js`; Zod argument schemas are in `dist/tools/schemas.js`, and helpers/implementations are in `dist/tools/{process,improved-process-tools,filesystem,config}.js` and `dist/handlers/`. Useful process tools: `start_process` requires `{command:string, timeout_ms:number}` and accepts optional `{shell, verbose_timing}`; returns an MCP result with a session PID and output. `read_process_output` takes `{pid, timeout_ms?, offset?, length?}`; `interact_with_process` takes `{pid, input, timeout_ms?, wait_for_prompt?, verbose_timing?}`; `force_terminate`/`kill_process` take `{pid}`; `list_sessions` and `list_processes` take `{}`. Results use `ServerResult` in `dist/types.d.ts`: `{content: ServerResponseContent[], structuredContent?, isError?, _meta?}`.
- Other useful tool inputs: `get_config {}`; `set_config_value {key:string, value:string|number|boolean|string[]|null}`; `read_file {path, isUrl?, offset?, length?, sheet?, range?, options?}`; `write_file {path, content, mode?:'rewrite'|'append'}`; `list_directory {path, depth?}`; `start_search {path, pattern, searchType?:'files'|'content', filePattern?, ignoreCase?, maxResults?, includeHidden?, contextLines?, timeout_ms?, earlyTermination?, literalSearch?}`; `get_file_info {path}`. See `dist/tools/schemas.js` for complete schemas and `dist/server.js` for descriptions, handlers, and response construction. MCP responses follow the declared `ServerResult` shape.
- Config supports `blockedCommands`, `defaultShell`, `allowedDirectories`, `fileReadLineLimit`, `fileWriteLineLimit`, and `telemetryEnabled`. `dist/tools/filesystem.js:getAllowedDirs()` persists `[os.homedir()]` if `allowedDirectories` is missing; an explicit empty array is treated as unrestricted, while a nonempty list is path-checked. The README notes that this restriction applies to filesystem tools; terminal commands may access paths outside those directories. A first filesystem-tool call can therefore write the DC config when the key is missing. No DC tool was called here.
- No Desktop Commander process was launched. No package was installed into this repo, and no app config was inspected or changed.

## Limitations

- Registry `latest` and package metadata are point-in-time observations on 2026-09-25. Exact pin recommendation is validated against the resolved npm tarball’s package metadata and shipped source; this is compatibility evidence, not a guarantee about future upstream behavior.
- Tool argument and result contracts above are summarized from shipped compiled package files, not exercised through a live MCP handshake or tool invocation.

## Current source Markdown validation

Run on 2026-09-25 in PowerShell at `C:\Users\donabe\Project\RemoteDesktopMCP`, branch `feat/tailscale-funnel-design-lint`, baseline HEAD `83a3de32314edfbcd314f18936b083ac5b1dca9a`. The source tree was dirty and contained staged design/task/report/whitelist changes plus an untracked implementation report; these results apply to the observed working tree at command time.

- `npm.cmd run lint:md` — exit 0; `markdownlint: 36 file(s), 0 issue(s)`.
- `npm.cmd run lint:md:terms:design` — exit 0; checked `doc/design/functional-requirements.md`, `doc/design/tailscale-funnel-architecture.md`, and `doc/design/multi-pc-architecture.md` against the Markdown term whitelist.
- `git diff --check` — exit 0; no output.
- `git diff --cached --check` — exit 0; no output. Added because the design changes were staged, so this checks the staged patch as well.

No source files were edited for this validation task. No build or code test was run.

## CI workflow wiring

Workflow work was performed on 2026-09-25 in PowerShell at `C:\Users\donabe\Project\RemoteDesktopMCP`, branch `feat/tailscale-funnel-design-lint`, base HEAD `320ddb6d5b3a1c54fb4d760612bf4cec4464c5bd`. The tree was concurrently dirty, including `package.json`, `package-lock.json`, task/report files, and a temporary source deletion; those files were not edited here. Only `.github/workflows/lint.yml` and this report were in scope.

- Updated `.github/workflows/lint.yml` to trigger on `push` to `main` and on `pull_request`. Retained the Ubuntu Node 22 lint job and extended it with `npm run check`, `npm run build`, and `npm test`. Added a Windows Node 22 job that runs `npm.cmd ci`, `npm.cmd run check`, `npm.cmd run build`, and `npm.cmd test` under PowerShell. Both jobs have a 15-minute timeout.
- Each command records separate stdout, stderr, and result files in `ci-artifacts/`; both jobs also record environment details and upload diagnostics even after a failing command. The existing Ubuntu job continues to run `npm ci` and `npm run lint` before type check, build, and tests.
- `node` YAML parser — exit 0; parsed workflow with `lint` and `windows` jobs, `push` restricted to `main`, `pull_request` enabled, and 15-minute timeouts on both jobs.
- `git diff --check -- .github/workflows/lint.yml` — exit 0; no whitespace errors (Git printed only its line-ending conversion notice).
- `npm.cmd run lint:md` — exit 0 after the final report edit; `markdownlint: 38 file(s), 0 issue(s)`.
- No live workflow, build, type check, or test run was started, as requested pending implementation readiness.
- Author wording self-check (`document-wording-review`, `author_self_check`) covered the new workflow-wiring paragraph in this report. Meaning, identifier preservation, and readability: checked with no finding; approved-usage review: not applicable because no terminology definition, approval, or ordinary product prose changed. The note preserves the exact job names, commands, paths, source identity, and verification boundary. It is a self-check, not an independent review.

## Dependency audit

Read-only dependency check on 2026-09-25 in PowerShell at `C:\Users\donabe\Project\RemoteDesktopMCP`, branch `feat/tailscale-funnel-design-lint`, HEAD `320ddb6d5b3a1c54fb4d760612bf4cec4464c5bd`. No package or lockfile edits were made.

- `package-lock.json` pins `@wonderwhy-er/desktop-commander` exactly at `0.2.51`, resolved from `https://registry.npmjs.org/@wonderwhy-er/desktop-commander/-/desktop-commander-0.2.51.tgz`.
- `npm.cmd audit --json` — exit 1; npm reported 4 vulnerabilities: 2 moderate, 2 high, 0 info/low/critical. JSON stdout was retained outside the repo at `%TEMP%\npm-audit-4c41b28d097148a38de4207968d07194.json`; stderr was empty. No `npm audit fix` or other package change was applied.
- Reported package paths from `npm.cmd explain`: direct `@wonderwhy-er/desktop-commander@0.2.51`; `exceljs@4.4.0` and `sharp@0.34.5` are dependencies of Desktop Commander; `uuid@8.3.2` is a dependency of `exceljs@4.4.0`, which is pulled by Desktop Commander.
- The audit names the affected packages as `@wonderwhy-er/desktop-commander` (high, direct, range `>=0.2.24`, via `exceljs` and `sharp`), `exceljs` (moderate, indirect, range `>=3.5.0`, via `uuid`), `sharp` (high, indirect, range `<=0.35.4-rc.0`; two libvips/libheif advisory entries), and `uuid` (moderate, indirect, range `<11.1.1`). npm’s JSON reports `@wonderwhy-er/desktop-commander@0.2.23` as the available fix for these advisories, marked `isSemVerMajor: true`.
- `npm.cmd explain` completed for all four named packages and returned the paths above. No build or test was run while implementation work was active. Advisory disposition is left to the parent.

## Built-module route smoke

Bounded smoke on 2026-09-25 at clean HEAD `23bd1363d2b027c7d1233f41e8c8ee9ae0120423` in PowerShell/Windows, using Node `v22.23.3`. The smoke artifacts are ignored workspace-local files under `reference/validation/`.

- Build prerequisite: Node 22 ran `node_modules/typescript/bin/tsc -p tsconfig.json` — exit 0, stdout/stderr empty.
- `reference/validation/built-module-smoke.mjs` imported the compiled `dist/index.js` exports, created an isolated root/data fixture under ignored `reference/validation/`, bound `createApp` to loopback port 0, and checked `GET /health` = 200 and unauthenticated `POST /mcp` = 401 (`Authentication required.`). Smoke script exit 0, stdout contains the response evidence, stderr empty. Result JSON: `reference/validation/built-module-smoke.json`; command logs: `reference/validation/built-module-smoke.stdout.log` and `.stderr.log`.
- The fixture used a unique workspace-local path and dummy test credentials. `RemoteDesktopService.close()` and the HTTP server close callback completed normally. The service was deliberately not initialized, so Desktop Commander did not start; this verifies the compiled module’s HTTP route behavior without a child process. It does not replace the full suite or CLI-process startup test. The full suite was not rerun after reviewer findings.
