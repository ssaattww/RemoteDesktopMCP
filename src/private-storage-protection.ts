export type PrivateStorageKind = "file" | "directory";

/** Apply an ACL protection operation, then independently confirm the path kind. */
export async function protectAndVerifyKind(
  target: string,
  expected: PrivateStorageKind,
  protect: (target: string) => Promise<void>,
  readKind: (target: string) => Promise<PrivateStorageKind>,
): Promise<void> {
  await protect(target);
  if (await readKind(target) !== expected) throw new Error("Private storage path type is invalid.");
}
