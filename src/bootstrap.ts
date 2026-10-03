import path from "node:path";
import { assertPrivateFile, assertSafePrivateParent } from "./private-storage.js";

const envPath = path.resolve(process.cwd(), ".env");
await assertSafePrivateParent(path.dirname(envPath));
await assertPrivateFile(envPath);
process.loadEnvFile(envPath);
const { startCuiFromEnvironment, startFromEnvironment } = await import("./index.js");
if (process.argv.includes("--cui")) await startCuiFromEnvironment();
else await startFromEnvironment();
