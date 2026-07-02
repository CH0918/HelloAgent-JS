import type { Tool } from "./base.js";
import type { ToolParameter } from "./base.js";

export type RegisteredFunction = (inputText: string) => string | Promise<string>;

interface FunctionToolInfo {
  description: string;
  func: RegisteredFunction;
}

export class ToolRegistry {
  private readonly tools: Map<string, Tool>;
  private readonly functions: Map<string, FunctionToolInfo>;

  constructor() {
    this.tools = new Map();
    this.functions = new Map();
  }

  registerTool(tool: Tool, autoExpand = true): void {
    if (autoExpand && tool.expandable) {
      const expandedTools = tool.getExpandedTools();
      if (expandedTools && expandedTools.length > 0) {
        for (const expandedTool of expandedTools) {
          this.tools.set(expandedTool.name, expandedTool);
        }
        return;
      }
    }

    this.tools.set(tool.name, tool);
  }

  registerFunction(name: string, description: string, func: RegisteredFunction): void {
    this.functions.set(name, { description, func });
  }

  unregisterTool(name: string): boolean {
    const removedTool = this.tools.delete(name);
    const removedFunction = this.functions.delete(name);
    return removedTool || removedFunction;
  }

  getTool(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getFunction(name: string): RegisteredFunction | undefined {
    return this.functions.get(name)?.func;
  }

  async executeTool(name: string, inputText: string): Promise<string> {
    const tool = this.tools.get(name);
    if (tool) {
      try {
        return await tool.run({ input: inputText });
      } catch (error) {
        return `错误：执行工具 '${name}' 时发生异常: ${error instanceof Error ? error.message : String(error)}`;
      }
    }

    const func = this.functions.get(name)?.func;
    if (func) {
      try {
        return await func(inputText);
      } catch (error) {
        return `错误：执行工具 '${name}' 时发生异常: ${error instanceof Error ? error.message : String(error)}`;
      }
    }

    return `错误：未找到名为 '${name}' 的工具。`;
  }

  getToolsDescription(): string {
    const descriptions: string[] = [];

    for (const tool of this.tools.values()) {
      const parameters = this.formatParameters(tool.getParameters());
      descriptions.push(parameters ? `- ${tool.name}: ${tool.description} 参数: ${parameters}` : `- ${tool.name}: ${tool.description}`);
    }

    for (const [name, info] of this.functions.entries()) {
      descriptions.push(`- ${name}: ${info.description}`);
    }

    return descriptions.length > 0 ? descriptions.join("\n") : "暂无可用工具";
  }

  listTools(): string[] {
    return [...this.tools.keys(), ...this.functions.keys()];
  }

  getAllTools(): Tool[] {
    return [...this.tools.values()];
  }

  clear(): void {
    this.tools.clear();
    this.functions.clear();
  }

  private formatParameters(parameters: ToolParameter[]): string {
    return parameters
      .map((parameter) => {
        const required = parameter.required === false ? "可选" : "必需";
        return `${parameter.name}(${parameter.type}, ${required})`;
      })
      .join(", ");
  }
}

export const globalRegistry = new ToolRegistry();
