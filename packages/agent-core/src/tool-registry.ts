import type { ToolSet } from "ai";

export class ToolRegistry {
  private tools: ToolSet = {};

  register(name: string, toolDef: ToolSet[string]): void {
    if (name in this.tools) {
      throw new Error(`Tool "${name}" is already registered`);
    }
    this.tools[name] = toolDef;
  }

  unregister(name: string): boolean {
    if (name in this.tools) {
      delete this.tools[name];
      return true;
    }
    return false;
  }

  get(name: string): ToolSet[string] | undefined {
    return this.tools[name];
  }

  getAll(): ToolSet {
    return { ...this.tools };
  }

  has(name: string): boolean {
    return name in this.tools;
  }

  clear(): void {
    this.tools = {};
  }

  get size(): number {
    return Object.keys(this.tools).length;
  }
}
