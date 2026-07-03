import type { ToolParameters } from "./base.js";
import {
  executeRegisteredTool,
  executeRegisteredToolWithParameters,
} from "./executor.js";
import type { ToolRegistry } from "./registry.js";

export interface AsyncToolTask {
  toolName: string;
  input?: string;
  parameters?: ToolParameters;
}

export type AsyncToolTaskStatus = "success" | "error";

export interface AsyncToolTaskResult {
  taskId: number;
  toolName: string;
  input?: string;
  parameters?: ToolParameters;
  result: string;
  status: AsyncToolTaskStatus;
  error?: string;
  durationMs: number;
}

export interface AsyncToolExecutorOptions {
  concurrency?: number;
}

export class AsyncToolExecutor {
  readonly registry: ToolRegistry;
  readonly concurrency: number;

  constructor(registry: ToolRegistry, options: AsyncToolExecutorOptions = {}) {
    this.registry = registry;
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? 4));
  }

  async executeToolAsync(toolName: string, input: string): Promise<string> {
    return executeRegisteredTool(this.registry, toolName, input);
  }

  async executeToolWithParametersAsync(toolName: string, parameters: ToolParameters): Promise<string> {
    return executeRegisteredToolWithParameters(this.registry, toolName, parameters);
  }

  async executeToolsParallel(
    tasks: AsyncToolTask[],
    options: AsyncToolExecutorOptions = {},
  ): Promise<AsyncToolTaskResult[]> {
    const concurrency = Math.max(1, Math.floor(options.concurrency ?? this.concurrency));
    const results: AsyncToolTaskResult[] = new Array(tasks.length);
    let nextIndex = 0;

    const workerCount = Math.min(concurrency, tasks.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (nextIndex < tasks.length) {
        const taskId = nextIndex;
        nextIndex += 1;
        results[taskId] = await this.executeTask(taskId, tasks[taskId]);
      }
    });

    await Promise.all(workers);
    return results;
  }

  async executeBatchTool(
    toolName: string,
    inputs: string[],
    options: AsyncToolExecutorOptions = {},
  ): Promise<AsyncToolTaskResult[]> {
    return this.executeToolsParallel(
      inputs.map((input) => ({
        toolName,
        input,
      })),
      options,
    );
  }

  private async executeTask(taskId: number, task: AsyncToolTask | undefined): Promise<AsyncToolTaskResult> {
    const startedAt = Date.now();

    if (!task || !task.toolName) {
      return {
        taskId,
        toolName: "",
        result: "",
        status: "error",
        error: "任务缺少 toolName",
        durationMs: Date.now() - startedAt,
      };
    }

    try {
      const result =
        task.parameters === undefined
          ? await executeRegisteredTool(this.registry, task.toolName, task.input ?? "")
          : await executeRegisteredToolWithParameters(this.registry, task.toolName, task.parameters);

      return {
        taskId,
        toolName: task.toolName,
        input: task.input,
        parameters: task.parameters,
        result,
        status: isToolError(result) ? "error" : "success",
        error: isToolError(result) ? result : undefined,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        taskId,
        toolName: task.toolName,
        input: task.input,
        parameters: task.parameters,
        result: "",
        status: "error",
        error: message,
        durationMs: Date.now() - startedAt,
      };
    }
  }
}

export async function runParallelTools(
  registry: ToolRegistry,
  tasks: AsyncToolTask[],
  options: AsyncToolExecutorOptions = {},
): Promise<AsyncToolTaskResult[]> {
  return new AsyncToolExecutor(registry, options).executeToolsParallel(tasks, options);
}

export async function runBatchTool(
  registry: ToolRegistry,
  toolName: string,
  inputs: string[],
  options: AsyncToolExecutorOptions = {},
): Promise<AsyncToolTaskResult[]> {
  return new AsyncToolExecutor(registry, options).executeBatchTool(toolName, inputs, options);
}

function isToolError(result: string): boolean {
  return result.startsWith("错误：") || result.startsWith("工具调用失败：");
}
