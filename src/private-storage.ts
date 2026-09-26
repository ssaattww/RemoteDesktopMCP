import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

type PrivateKind = "file" | "directory";

const allowedChildEnvironment = () => {
  const environment = { ...process.env };
  delete environment.GOOGLE_CLIENT_SECRET;
  delete environment.TOKEN_SECRET;
  delete environment.PSModulePath;
  return environment;
};

const windowsAclScript = String.raw`
$ErrorActionPreference = 'Stop'
$stage = 'input'
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($null -eq $request -or [string]::IsNullOrWhiteSpace($request.path)) { throw 'invalid request' }
  $item = Get-Item -LiteralPath $request.path -Force
  $current = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $allowed = @($current.Value, 'S-1-5-18', 'S-1-5-32-544')
  if ($request.operation -eq 'protect') {
    $stage = 'protect'
    $acl = Get-Acl -LiteralPath $request.path
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleAll($rule) }
    $inheritance = [Security.AccessControl.InheritanceFlags]::None
    if ($item.PSIsContainer) { $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit }
    foreach ($sid in $allowed) {
      $principal = [Security.Principal.SecurityIdentifier]::new($sid)
      $rule = New-Object Security.AccessControl.FileSystemAccessRule($principal, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
      [void]$acl.AddAccessRule($rule)
    }
    $acl.SetOwner($current)
    Set-Acl -LiteralPath $request.path -AclObject $acl
    $item = Get-Item -LiteralPath $request.path -Force
  }
  function Assert-PrivateAcl($candidate) {
    $acl = Get-Acl -LiteralPath $candidate.FullName
    if (-not $acl.AreAccessRulesProtected) { throw 'inherited access rules' }
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $current.Value) { throw 'unexpected owner' }
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if ($rules.Count -ne 3) { throw 'unexpected access rule count' }
    $seen = @{}
    foreach ($rule in $rules) {
      $sid = $rule.IdentityReference.Value
      if ($allowed -notcontains $sid -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { throw 'unexpected access principal' }
      if (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl) { throw 'insufficient private access rule' }
      if ($seen.ContainsKey($sid)) { throw 'duplicate access rule' }
      $seen[$sid] = $true
    }
    foreach ($sid in $allowed) { if (-not $seen.ContainsKey($sid)) { throw 'missing private access rule' } }
  }
  if ($request.operation -eq 'assert-parent') {
    $stage = 'verify'
    $unsafe = [Security.AccessControl.FileSystemRights]::WriteData -bor [Security.AccessControl.FileSystemRights]::AppendData -bor [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor [Security.AccessControl.FileSystemRights]::WriteAttributes -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
    $acl = Get-Acl -LiteralPath $request.path
    if ($allowed -notcontains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value) { throw 'untrusted parent owner' }
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    foreach ($rule in $rules) {
      if ($allowed -notcontains $rule.IdentityReference.Value -and $rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and ($rule.FileSystemRights -band $unsafe) -ne 0) { throw 'untrusted parent write access' }
    }
    [Console]::Out.Write('{"ok":true}')
    exit 0
  }
  if ($request.operation -eq 'assert-audit') {
    $stage = 'verify'
    if ([string]::IsNullOrWhiteSpace($request.file)) { throw 'invalid audit file' }
    $auditFile = Get-Item -LiteralPath $request.file -Force
    if (-not $item.PSIsContainer -or $auditFile.PSIsContainer) { throw 'invalid audit path type' }
    Assert-PrivateAcl $item
    Assert-PrivateAcl $auditFile
    [Console]::Out.Write('{"ok":true}')
    exit 0
  }
  $stage = 'verify'
  Assert-PrivateAcl $item
  [Console]::Out.Write('{"ok":true}')
} catch {
  [Console]::Error.WriteLine("Private storage ACL operation failed at ${"${stage}"}.")
  exit 1
}
`;

async function windowsAcl(target: string, operation: "protect" | "assert" | "assert-parent" | "assert-audit", file?: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", windowsAclScript], {
      env: allowedChildEnvironment(),
      stdio: ["pipe", "ignore", "pipe"],
      windowsHide: true,
    });
    let diagnostic = "";
    child.stderr.on("data", (chunk: Buffer) => { diagnostic = `${diagnostic}${chunk.toString("utf8")}`.slice(0, 128); });
    child.once("error", () => reject(new Error("Private storage ACL verification failed.")));
    child.once("close", (code) => {
      const stage = /at (input|protect|verify)\./.exec(diagnostic)?.[1];
      if (code === 0) resolve();
      else reject(new Error(stage ? `Private storage ACL verification failed during ${stage}.` : "Private storage ACL verification failed."));
    });
    child.stdin.end(JSON.stringify({ path: target, operation, ...(file ? { file } : {}) }));
  });
}

async function kind(target: string): Promise<PrivateKind> {
  const info = await lstat(target);
  if (info.isSymbolicLink()) throw new Error("Private storage paths must not be symbolic links.");
  if (info.isDirectory()) return "directory";
  if (info.isFile()) return "file";
  throw new Error("Private storage paths must be regular files or directories.");
}

async function assertPrivate(target: string, expected: PrivateKind): Promise<void> {
  if (await kind(target) !== expected) throw new Error("Private storage path type is invalid.");
  if (process.platform === "win32") {
    await windowsAcl(target, "assert");
    return;
  }
  const info = await lstat(target);
  if ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) throw new Error("Private storage permissions are unsafe.");
}

async function protectPrivate(target: string, expected: PrivateKind): Promise<void> {
  if (await kind(target) !== expected) throw new Error("Private storage path type is invalid.");
  if (process.platform === "win32") await windowsAcl(target, "protect");
  else await chmod(target, expected === "directory" ? 0o700 : 0o600);
  await assertPrivate(target, expected);
}

export async function assertPrivateDirectory(directory: string): Promise<void> {
  await assertPrivate(directory, "directory");
}

export async function assertPrivateFile(file: string): Promise<void> {
  await assertPrivate(file, "file");
}

export async function assertPrivateAuditStorage(directory: string, file: string): Promise<void> {
  if (path.dirname(path.resolve(file)) !== path.resolve(directory)) throw new Error("Private audit file must be directly inside its directory.");
  if (await kind(directory) !== "directory" || await kind(file) !== "file") throw new Error("Private storage path type is invalid.");
  if (process.platform === "win32") {
    await windowsAcl(directory, "assert-audit", file);
    return;
  }
  await assertPrivateDirectory(directory);
  await assertPrivateFile(file);
}

/** The parent may be readable by ordinary users, but they must not be able to
 * replace, delete, create, or re-permission a private child before it is read. */
export async function assertSafePrivateParent(directory: string): Promise<void> {
  if (await kind(directory) !== "directory") throw new Error("Private storage path type is invalid.");
  if (process.platform === "win32") {
    await windowsAcl(directory, "assert-parent");
    return;
  }
  const info = await lstat(directory);
  if ((info.mode & 0o022) !== 0 || info.uid !== process.getuid?.()) throw new Error("Private storage parent permissions are unsafe.");
}

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  try {
    await assertPrivateDirectory(directory);
    return;
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT")) throw error;
  }
  await assertSafePrivateParent(path.dirname(directory));
  await mkdir(directory, { mode: 0o700 });
  await protectPrivate(directory, "directory");
}

export async function protectPrivateFile(file: string): Promise<void> {
  await protectPrivate(file, "file");
}

export async function protectPrivateDirectory(directory: string): Promise<void> {
  await protectPrivate(directory, "directory");
}

export async function createPrivateFile(file: string, contents: string | Uint8Array): Promise<void> {
  await assertSafePrivateParent(path.dirname(file));
  const handle = await open(file, "wx", 0o600);
  await handle.close();
  try {
    await protectPrivateFile(file);
    await writeFile(file, contents);
    await assertPrivateFile(file);
  } catch (error) {
    await unlink(file).catch(() => undefined);
    throw error;
  }
}

export async function createPrivateTemporaryFile(directory: string, label = "state"): Promise<string> {
  await assertPrivateDirectory(directory);
  const safeLabel = label.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40) || "state";
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const file = path.join(directory, `.${safeLabel}-${randomBytes(18).toString("hex")}.tmp`);
    try {
      const handle = await open(file, "wx", 0o600);
      await handle.close();
      await protectPrivateFile(file);
      return file;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error("Private temporary file creation failed.");
}
