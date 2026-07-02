import type { Tool, ToolParameters, ToolParameterType } from "./base.js";
import type { ToolRegistry } from "./registry.js";

export function parseToolParameters(tool: Tool, parameters: string): ToolParameters {
  const trimmed = parameters.trim();

  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as ToolParameters;
      return convertParameterTypes(tool, parsed);
    } catch {
      // Falls through to the lightweight key=value parser below.
    }
  }

  if (trimmed.includes("=")) {
    const parsed: ToolParameters = {};
    const pairs = trimmed.split(",");
    for (const pair of pairs) {
      const [key, ...valueParts] = pair.split("=");
      const parameterName = key?.trim();
      if (!parameterName) {
        continue;
      }
      parsed[parameterName] = valueParts.join("=").trim();
    }
    return inferAction(tool.name, convertParameterTypes(tool, parsed));
  }

  return inferSimpleParameters(tool.name, trimmed);
}

export async function executeRegisteredTool(
  registry: ToolRegistry,
  toolName: string,
  parameters: string,
): Promise<string> {
  const tool = registry.getTool(toolName);
  if (tool) {
    try {
      const parsedParameters = parseToolParameters(tool, parameters);
      const result = await tool.run(parsedParameters);
      return String(result);
    } catch (error) {
      return `工具调用失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  const func = registry.getFunction(toolName);
  if (func) {
    try {
      return await func(parameters);
    } catch (error) {
      return `工具调用失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  return `错误：未找到工具 '${toolName}'`;
}

function convertParameterTypes(tool: Tool, parameters: ToolParameters): ToolParameters {
  const parameterTypes = new Map<string, ToolParameterType>();
  for (const parameter of tool.getParameters()) {
    parameterTypes.set(parameter.name, parameter.type);
  }

  const converted: ToolParameters = {};
  for (const [key, value] of Object.entries(parameters)) {
    const parameterType = parameterTypes.get(key);
    converted[key] = convertValue(value, parameterType);
  }

  return converted;
}

function convertValue(value: unknown, parameterType: ToolParameterType | undefined): unknown {
  if (typeof value !== "string" || parameterType === undefined) {
    return value;
  }

  switch (parameterType) {
    case "number": {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : value;
    }
    case "integer": {
      const parsed = Number(value);
      return Number.isInteger(parsed) ? parsed : value;
    }
    case "boolean":
      return ["true", "1", "yes"].includes(value.toLowerCase());
    case "array":
      return value.split("|").map((item) => item.trim());
    case "object":
    case "string":
      return value;
  }
}

function inferAction(toolName: string, parameters: ToolParameters): ToolParameters {
  if (toolName === "memory") {
    return inferMemoryAction(parameters);
  }

  if (toolName === "rag") {
    return inferRagAction(parameters);
  }

  return parameters;
}

function inferMemoryAction(parameters: ToolParameters): ToolParameters {
  if ("action" in parameters) {
    return parameters;
  }

  if ("recall" in parameters) {
    return { ...parameters, action: "search", query: parameters.recall };
  }
  if ("store" in parameters) {
    return { ...parameters, action: "add", content: parameters.store };
  }
  if ("query" in parameters) {
    return { ...parameters, action: "search" };
  }
  if ("content" in parameters) {
    return { ...parameters, action: "add" };
  }

  return parameters;
}

function inferRagAction(parameters: ToolParameters): ToolParameters {
  if ("action" in parameters) {
    return parameters;
  }

  if ("search" in parameters) {
    return { ...parameters, action: "search", query: parameters.search };
  }
  if ("query" in parameters) {
    return { ...parameters, action: "search" };
  }
  if ("text" in parameters) {
    return { ...parameters, action: "add_text" };
  }

  return parameters;
}

function inferSimpleParameters(toolName: string, parameters: string): ToolParameters {
  if (toolName === "rag" || toolName === "memory") {
    return { action: "search", query: parameters };
  }

  return { input: parameters };
}
