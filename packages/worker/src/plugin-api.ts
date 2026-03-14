import { getLogger } from "@logtape/logtape";
import type {
  WorkerPluginApi,
  WorkerHookEvents,
  HookHandlerFn,
  HookRegistry,
  WorkerSkillInfo,
  WorkerAgentInfo,
} from "@molf-ai/protocol";
import type { ToolExecutor, WorkerTool } from "./tool-executor.js";

export type SyncStateFn = () => void;

/**
 * Concrete implementation of WorkerPluginApi passed to plugin worker() functions.
 * Each plugin instance gets its own api object scoped to the plugin name.
 */
export class WorkerPluginApiImpl implements WorkerPluginApi {
  readonly config: unknown;
  readonly workdir: string;
  private readonly log;
  private syncStateFn: SyncStateFn | null = null;

  constructor(
    private readonly pluginName: string,
    private readonly hookRegistry: HookRegistry,
    private readonly toolExecutor: ToolExecutor,
    private readonly skills: WorkerSkillInfo[],
    private readonly agents: WorkerAgentInfo[],
    workdir: string,
    config: unknown,
  ) {
    this.workdir = workdir;
    this.config = config;
    this.log = getLogger(["molf", "plugin", pluginName]);
  }

  /** Set the syncState function. Called after connection is established. */
  setSyncStateFn(fn: SyncStateFn): void {
    this.syncStateFn = fn;
  }

  on<K extends keyof WorkerHookEvents>(
    event: K,
    handler: HookHandlerFn<WorkerHookEvents[K]>,
    opts?: { priority?: number },
  ): void {
    this.hookRegistry.on(event, this.pluginName, handler, opts);
  }

  addTool(name: string, def: Omit<WorkerTool, "name">): void {
    if (this.toolExecutor.hasTool(name)) {
      this.log.warn("Overwriting existing tool", { tool: name, plugin: this.pluginName });
    }
    this.toolExecutor.registerTool({ ...def, name });
  }

  removeTool(name: string): void {
    this.toolExecutor.deregisterTools([name]);
  }

  syncState(): Promise<void> {
    if (!this.syncStateFn) {
      this.log.warn("syncState called before connection established");
      return Promise.resolve();
    }
    this.syncStateFn();
    return Promise.resolve();
  }

  addSkill(skill: WorkerSkillInfo): void {
    this.skills.push(skill);
  }

  addAgent(agent: WorkerAgentInfo): void {
    this.agents.push(agent);
  }
}
