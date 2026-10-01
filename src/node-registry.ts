import { parseClusterConfig, type ClusterConfig } from "./node-cluster.js";

export type NodeRoot = {
  root_id: string;
  absolute_path: string;
};

export type NodeCapabilities = {
  operations: string[];
  roots: NodeRoot[];
  path_base: string;
};

export type NodeReadyState = NodeCapabilities & {
  connection_id: string;
  executor_generation: string;
  desktop_commander_generation: string;
};

export type NodeListEntry = {
  node_id: string;
  label: string;
  connected: boolean;
  coordinator: boolean;
  operations: string[];
  root_ids: string[];
  roots: NodeRoot[];
  path_base: string;
  last_seen_at: string | null;
};

type ConnectionState = NodeReadyState & {
  seenAt: number;
};

type RemoteNodeState = {
  node_id: string;
  label: string;
  psk: string;
  active?: ConnectionState;
  synchronizing?: ConnectionState;
  lastSeenAt?: number;
};

type LocalNodeState = NodeCapabilities & {
  seenAt: number;
};

function cloneCapabilities(value: NodeCapabilities): NodeCapabilities {
  return {
    operations: [...value.operations],
    roots: value.roots.map((root) => ({ ...root })),
    path_base: value.path_base,
  };
}

function connectionState(value: NodeReadyState, seenAt: number): ConnectionState {
  return {
    ...cloneCapabilities(value),
    connection_id: value.connection_id,
    executor_generation: value.executor_generation,
    desktop_commander_generation: value.desktop_commander_generation,
    seenAt,
  };
}

function uniqueConnectionIds(state: RemoteNodeState): string[] {
  return [...new Set([
    state.active?.connection_id,
    state.synchronizing?.connection_id,
  ].filter((value): value is string => value !== undefined))];
}

export class NodeRegistry {
  private config: ClusterConfig;
  private readonly remotes = new Map<string, RemoteNodeState>();
  private local?: LocalNodeState;

  constructor(config: ClusterConfig) {
    this.config = parseClusterConfig(config);
    this.rebuildRemoteRegistrations(this.config);
  }

  private rebuildRemoteRegistrations(config: ClusterConfig): void {
    const retained = new Map<string, RemoteNodeState>();
    for (const executor of config.executors) {
      const previous = this.remotes.get(executor.node_id);
      retained.set(executor.node_id, {
        node_id: executor.node_id,
        label: executor.label,
        psk: executor.psk,
        ...(previous?.psk === executor.psk ? {
          active: previous.active,
          synchronizing: previous.synchronizing,
          lastSeenAt: previous.lastSeenAt,
        } : {}),
      });
    }
    this.remotes.clear();
    for (const [nodeId, state] of retained) this.remotes.set(nodeId, state);
  }

  setLocalCapabilities(capabilities: NodeCapabilities, seenAt = Date.now()): void {
    if (!this.config.roles.includes("executor")) {
      throw new Error("Local node is not configured as an executor.");
    }
    this.local = { ...cloneCapabilities(capabilities), seenAt };
  }

  registration(nodeId: string): { node_id: string; label: string; psk: string } | undefined {
    const state = this.remotes.get(nodeId);
    return state ? { node_id: state.node_id, label: state.label, psk: state.psk } : undefined;
  }

  beginSynchronizing(
    nodeId: string,
    ready: NodeReadyState,
    seenAt = Date.now(),
  ): { replaced_synchronizing_connection_id?: string } {
    const state = this.remotes.get(nodeId);
    if (!state) throw new Error("Executor is not registered.");
    if (state.active?.connection_id === ready.connection_id) {
      throw new Error("Active connection cannot become a synchronizing candidate.");
    }
    const previous = state.synchronizing?.connection_id;
    state.synchronizing = connectionState(ready, seenAt);
    return previous && previous !== ready.connection_id
      ? { replaced_synchronizing_connection_id: previous }
      : {};
  }

  activate(
    nodeId: string,
    connectionId: string,
    seenAt = Date.now(),
  ): { replaced_active_connection_id?: string; executor_generation_changed: boolean } {
    const state = this.remotes.get(nodeId);
    if (!state) throw new Error("Executor is not registered.");
    const candidate = state.synchronizing;
    if (!candidate || candidate.connection_id !== connectionId) {
      throw new Error("Synchronizing connection is not current.");
    }
    const prior = state.active;
    const executorGenerationChanged = prior !== undefined
      && prior.executor_generation !== candidate.executor_generation;
    state.active = { ...candidate, seenAt };
    state.synchronizing = undefined;
    state.lastSeenAt = seenAt;
    return {
      ...(prior && prior.connection_id !== connectionId
        ? { replaced_active_connection_id: prior.connection_id }
        : {}),
      executor_generation_changed: executorGenerationChanged,
    };
  }

  touch(nodeId: string, connectionId: string, seenAt = Date.now()): void {
    const state = this.remotes.get(nodeId);
    if (!state) throw new Error("Executor is not registered.");
    if (state.active?.connection_id === connectionId) {
      state.active.seenAt = seenAt;
      state.lastSeenAt = seenAt;
      return;
    }
    if (state.synchronizing?.connection_id === connectionId) {
      state.synchronizing.seenAt = seenAt;
      return;
    }
    throw new Error("Connection is not current for this executor.");
  }

  disconnect(nodeId: string, connectionId: string): void {
    const state = this.remotes.get(nodeId);
    if (!state) return;
    if (state.synchronizing?.connection_id === connectionId) {
      state.synchronizing = undefined;
    }
    if (state.active?.connection_id === connectionId) {
      state.lastSeenAt = state.active.seenAt;
      state.active = undefined;
    }
  }

  reconfigure(config: ClusterConfig): { invalidated_connection_ids: string[] } {
    const next = parseClusterConfig(config);
    const invalidated: string[] = [];
    for (const [nodeId, state] of this.remotes) {
      const replacement = next.executors.find((executor) => executor.node_id === nodeId);
      if (!replacement || replacement.psk !== state.psk) {
        invalidated.push(...uniqueConnectionIds(state));
      }
    }

    const hadLocalExecutor = this.config.roles.includes("executor");
    this.config = next;
    if (hadLocalExecutor && !next.roles.includes("executor")) this.local = undefined;
    this.rebuildRemoteRegistrations(next);
    return { invalidated_connection_ids: [...new Set(invalidated)] };
  }

  activeConnection(nodeId: string): NodeReadyState | undefined {
    const active = this.remotes.get(nodeId)?.active;
    if (!active) return undefined;
    return {
      connection_id: active.connection_id,
      executor_generation: active.executor_generation,
      desktop_commander_generation: active.desktop_commander_generation,
      ...cloneCapabilities(active),
    };
  }

  list(): NodeListEntry[] {
    const nodes: NodeListEntry[] = [];
    if (this.config.roles.includes("executor")) {
      nodes.push({
        node_id: this.config.local.node_id,
        label: this.config.local.label,
        connected: this.local !== undefined,
        coordinator: this.config.roles.includes("coordinator"),
        operations: this.local ? [...this.local.operations] : [],
        root_ids: this.local ? this.local.roots.map((root) => root.root_id) : [],
        roots: this.local ? this.local.roots.map((root) => ({ ...root })) : [],
        path_base: this.local?.path_base ?? "root",
        last_seen_at: this.local ? new Date(this.local.seenAt).toISOString() : null,
      });
    }

    for (const executor of this.config.executors) {
      const state = this.remotes.get(executor.node_id);
      if (!state) continue;
      const active = state.active;
      nodes.push({
        node_id: executor.node_id,
        label: executor.label,
        connected: active !== undefined,
        coordinator: false,
        operations: active ? [...active.operations] : [],
        root_ids: active ? active.roots.map((root) => root.root_id) : [],
        roots: active ? active.roots.map((root) => ({ ...root })) : [],
        path_base: active?.path_base ?? "root",
        last_seen_at: state.lastSeenAt === undefined ? null : new Date(state.lastSeenAt).toISOString(),
      });
    }
    return nodes;
  }
}
