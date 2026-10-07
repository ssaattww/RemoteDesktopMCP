import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  addExecutor,
  clearCoordinator,
  createInitialClusterConfig,
  parseClusterConfig,
  removeExecutor,
  rotateExecutorKey,
  setCoordinator,
  type ClusterConfig,
  type ClusterRoleInput,
} from "./node-cluster.js";
import {
  assertPrivateFile,
  createPrivateFile,
  createPrivateTemporaryFile,
  ensurePrivateDirectory,
} from "./private-storage.js";

function isMissing(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: string }).code === "ENOENT";
}

function isExisting(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: string }).code === "EEXIST";
}

function serialized(config: ClusterConfig): string {
  return `${JSON.stringify(parseClusterConfig(config), null, 2)}\n`;
}

export class ClusterConfigStore {
  readonly directory: string;
  readonly file: string;

  constructor(dataDir: string) {
    this.directory = path.join(path.resolve(dataDir), "node");
    this.file = path.join(this.directory, "cluster.json");
  }

  async load(): Promise<ClusterConfig | undefined> {
    try {
      await assertPrivateFile(this.file);
      const text = await readFile(this.file, "utf8");
      return parseClusterConfig(JSON.parse(text.replace(/^\uFEFF/, "")) as unknown);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  async initialize(role: ClusterRoleInput, label: string, port?: number): Promise<ClusterConfig> {
    const config = createInitialClusterConfig(role, label, port);
    await ensurePrivateDirectory(this.directory);
    try {
      await createPrivateFile(this.file, serialized(config));
    } catch (error) {
      if (isExisting(error)) throw new Error("Cluster config is already initialized.", { cause: error });
      throw error;
    }
    return config;
  }

  private async current(): Promise<ClusterConfig> {
    const config = await this.load();
    if (!config) throw new Error("Cluster config is not initialized.");
    return config;
  }

  private async persist(config: ClusterConfig): Promise<ClusterConfig> {
    const validated = parseClusterConfig(config);
    await ensurePrivateDirectory(this.directory);
    const temporary = await createPrivateTemporaryFile(this.directory, "cluster");
    try {
      await writeFile(temporary, serialized(validated), { encoding: "utf8" });
      await assertPrivateFile(temporary);
      await rename(temporary, this.file);
      await assertPrivateFile(this.file);
      return validated;
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async addExecutor(nodeId: string, label: string): Promise<{ config: ClusterConfig; psk: string }> {
    const result = addExecutor(await this.current(), nodeId, label);
    return { config: await this.persist(result.config), psk: result.psk };
  }

  async rotateExecutorKey(nodeId: string): Promise<{ config: ClusterConfig; psk: string }> {
    const result = rotateExecutorKey(await this.current(), nodeId);
    return { config: await this.persist(result.config), psk: result.psk };
  }

  async removeExecutor(nodeId: string): Promise<ClusterConfig> {
    return this.persist(removeExecutor(await this.current(), nodeId));
  }

  async setCoordinator(host: string, port: number, psk: string): Promise<ClusterConfig> {
    return this.persist(setCoordinator(await this.current(), host, port, psk));
  }

  async clearCoordinator(): Promise<ClusterConfig> {
    return this.persist(clearCoordinator(await this.current()));
  }
}
