import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ClusterConfig, ClusterRoleInput } from "./node-cluster.js";
import { ClusterConfigStore } from "./node-config.js";

export type NodeConfigIo = {
  readStdin: () => Promise<string>;
  write: (value: string) => void;
};

function requiredValue(args: string[], name: string): string {
  const index = args.indexOf(name);
  if (index < 0) throw new Error(`${name} is required.`);
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function optionalValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function portValue(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port)) throw new Error("Port must be an integer.");
  return port;
}

function roleValue(value: string): ClusterRoleInput {
  if (value === "coordinator" || value === "executor" || value === "both") return value;
  throw new Error("Role must be coordinator, executor, or both.");
}

function rejectSecretArgument(args: string[]): void {
  if (args.some((arg) => arg === "--psk" || arg.startsWith("--psk="))) {
    throw new Error("Use --psk-stdin and provide the PSK through standard input.");
  }
}

function assertKnownOptions(args: string[], values: string[], flags: string[] = []): void {
  const valueSet = new Set(values);
  const flagSet = new Set(flags);
  for (let index = 0; index < args.length;) {
    const item = args[index]!;
    if (valueSet.has(item)) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${item} requires a value.`);
      index += 2;
      continue;
    }
    if (flagSet.has(item)) {
      index += 1;
      continue;
    }
    throw new Error(`Unknown node-config argument: ${item}`);
  }
}

function publicConfig(config: ClusterConfig): Record<string, unknown> {
  return {
    version: config.version,
    roles: config.roles,
    local: config.local,
    ...(config.transport ? { transport: config.transport } : {}),
    coordinator_configured: config.coordinator !== undefined,
    ...(config.coordinator ? {
      coordinator: {
        host: config.coordinator.host,
        port: config.coordinator.port,
      },
    } : {}),
    executors: config.executors.map(({ node_id, label }) => ({ node_id, label })),
  };
}

async function processStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

const processIo: NodeConfigIo = {
  readStdin: processStdin,
  write: (value) => {
    process.stdout.write(`${value}\n`);
  },
};

export async function runNodeConfig(
  args: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  io: NodeConfigIo = processIo,
): Promise<void> {
  const [command, ...options] = args;
  if (!command) throw new Error("node-config command is required.");
  rejectSecretArgument(options);

  const store = new ClusterConfigStore(env.DATA_DIR ?? "data");
  let config: ClusterConfig | undefined;

  switch (command) {
    case "init": {
      assertKnownOptions(options, ["--role", "--label", "--port"]);
      const role = roleValue(requiredValue(options, "--role"));
      const label = requiredValue(options, "--label");
      config = await store.initialize(role, label, portValue(optionalValue(options, "--port")));
      io.write(JSON.stringify(publicConfig(config)));
      return;
    }
    case "show": {
      assertKnownOptions(options, []);
      config = await store.load();
      if (!config) throw new Error("Cluster config is not initialized.");
      io.write(JSON.stringify(publicConfig(config)));
      return;
    }
    case "add-executor": {
      assertKnownOptions(options, ["--node-id", "--label"]);
      const nodeId = requiredValue(options, "--node-id");
      const result = await store.addExecutor(nodeId, requiredValue(options, "--label"));
      io.write(JSON.stringify({ node_id: nodeId, psk: result.psk }));
      return;
    }
    case "rotate-executor-key": {
      assertKnownOptions(options, ["--node-id"]);
      const nodeId = requiredValue(options, "--node-id");
      const result = await store.rotateExecutorKey(nodeId);
      io.write(JSON.stringify({ node_id: nodeId, psk: result.psk }));
      return;
    }
    case "remove-executor": {
      assertKnownOptions(options, ["--node-id"]);
      config = await store.removeExecutor(requiredValue(options, "--node-id"));
      io.write(JSON.stringify(publicConfig(config)));
      return;
    }
    case "set-coordinator": {
      assertKnownOptions(options, ["--host", "--port"], ["--psk-stdin"]);
      if (!options.includes("--psk-stdin")) {
        throw new Error("set-coordinator requires --psk-stdin and the PSK on standard input.");
      }
      const psk = (await io.readStdin()).trim();
      if (!psk) throw new Error("PSK standard input is empty.");
      config = await store.setCoordinator(
        requiredValue(options, "--host"),
        portValue(requiredValue(options, "--port"))!,
        psk,
      );
      io.write(JSON.stringify(publicConfig(config)));
      return;
    }
    case "clear-coordinator": {
      assertKnownOptions(options, []);
      config = await store.clearCoordinator();
      io.write(JSON.stringify(publicConfig(config)));
      return;
    }
    default:
      throw new Error(`Unknown node-config command: ${command}`);
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(path.resolve(entry)).href) {
  runNodeConfig().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "node-config failed."}\n`);
    process.exitCode = 1;
  });
}
