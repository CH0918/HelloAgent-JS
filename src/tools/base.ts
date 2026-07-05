export type ToolParameterType = "string" | "number" | "integer" | "boolean" | "array" | "object";

export interface ToolParameter {
  name: string;
  type: ToolParameterType;
  description: string;
  required?: boolean;
  default?: unknown;
}

export type ToolParameters = Record<string, unknown>;
export type ToolResult = string | Promise<string>;

export interface ToolDict {
  name: string;
  description: string;
  parameters: ToolParameter[];
}

export interface OpenAIToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, { type: ToolParameterType; description: string; items?: { type: string } }>;
      required: string[];
    };
  };
}

export abstract class Tool {
  readonly name: string;
  readonly description: string;
  readonly expandable: boolean;

  constructor(name: string, description: string, expandable = false) {
    this.name = name;
    this.description = description;
    this.expandable = expandable;
  }

  abstract run(parameters: ToolParameters): ToolResult;

  abstract getParameters(): ToolParameter[];

  getExpandedTools(): Tool[] | undefined {
    return undefined;
  }

  validateParameters(parameters: ToolParameters): boolean {
    return this.getParameters()
      .filter((parameter) => parameter.required ?? true)
      .every((parameter) => Object.hasOwn(parameters, parameter.name));
  }

  toDict(): ToolDict {
    return {
      name: this.name,
      description: this.description,
      parameters: this.getParameters(),
    };
  }

  toOpenAISchema(): OpenAIToolSchema {
    const properties: OpenAIToolSchema["function"]["parameters"]["properties"] = {};
    const required: string[] = [];

    for (const parameter of this.getParameters()) {
      const description =
        parameter.default === undefined
          ? parameter.description
          : `${parameter.description} (默认: ${String(parameter.default)})`;
      properties[parameter.name] = {
        type: parameter.type,
        description,
      };

      if (parameter.type === "array") {
        properties[parameter.name].items = { type: "string" };
      }

      if (parameter.required ?? true) {
        required.push(parameter.name);
      }
    }

    return {
      type: "function",
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: "object",
          properties,
          required,
        },
      },
    };
  }

  toString(): string {
    return `Tool(name=${this.name})`;
  }
}
