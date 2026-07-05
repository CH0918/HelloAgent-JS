import { Tool } from "./base.js";
import type { ToolParameter, ToolParameters } from "./base.js";
import { executeRegisteredTool } from "./executor.js";
import type { ToolRegistry } from "./registry.js";

export type ToolChainContext = Record<string, unknown>;

export interface ToolChainStep {
  toolName: string;
  inputTemplate: string;
  outputKey?: string;
}

export interface ToolChainStepResult {
  index: number;
  toolName: string;
  input: string;
  outputKey: string;
  result: string;
}

export interface ToolChainRunResult {
  chainName: string;
  input: string;
  result: string;
  context: ToolChainContext;
  steps: ToolChainStepResult[];
}

export interface ToolChainInfo {
  name: string;
  description: string;
  steps: Array<Required<ToolChainStep>>;
}

export interface ToolChainToolOptions {
  inputParameterName?: string;
  inputParameterDescription?: string;
}

export class ToolChain {
  readonly name: string;
  readonly description: string;

  private readonly steps: Required<ToolChainStep>[];

  constructor(name: string, description: string, steps: ToolChainStep[] = []) {
    this.name = name;
    this.description = description;
    this.steps = [];

    for (const step of steps) {
      this.addStep(step.toolName, step.inputTemplate, step.outputKey);
    }
  }

  addStep(toolName: string, inputTemplate: string, outputKey?: string): this {
    if (!toolName.trim()) {
      throw new Error("toolName 不能为空");
    }
    if (!inputTemplate.trim()) {
      throw new Error("inputTemplate 不能为空");
    }

    this.steps.push({
      toolName: toolName.trim(),
      inputTemplate,
      outputKey: outputKey?.trim() || `step_${this.steps.length + 1}_result`,
    });
    return this;
  }

  getSteps(): Array<Required<ToolChainStep>> {
    return this.steps.map((step) => ({ ...step }));
  }

  getInfo(): ToolChainInfo {
    return {
      name: this.name,
      description: this.description,
      steps: this.getSteps(),
    };
  }

  async execute(
    registry: ToolRegistry,
    input: string,
    context: ToolChainContext = {},
  ): Promise<ToolChainRunResult> {
    if (this.steps.length === 0) {
      throw new Error(`工具链 '${this.name}' 没有任何执行步骤`);
    }

    const workingContext: ToolChainContext = {
      ...context,
      input,
    };
    const stepResults: ToolChainStepResult[] = [];
    let finalResult = input;

    for (const [index, step] of this.steps.entries()) {
      const renderedInput = renderTemplate(step.inputTemplate, workingContext);
      const result = await executeRegisteredTool(registry, step.toolName, renderedInput);

      workingContext[step.outputKey] = result;
      workingContext[`step_${index + 1}_result`] = result;
      finalResult = result;
      stepResults.push({
        index: index + 1,
        toolName: step.toolName,
        input: renderedInput,
        outputKey: step.outputKey,
        result,
      });
    }

    return {
      chainName: this.name,
      input,
      result: finalResult,
      context: workingContext,
      steps: stepResults,
    };
  }

  toTool(registry: ToolRegistry, options: ToolChainToolOptions = {}): Tool {
    return new ToolChainTool(this, registry, options);
  }
}

export class ToolChainManager {
  readonly registry: ToolRegistry;

  private readonly chains: Map<string, ToolChain>;

  constructor(registry: ToolRegistry) {
    this.registry = registry;
    this.chains = new Map();
  }

  registerChain(chain: ToolChain): void {
    this.chains.set(chain.name, chain);
  }

  unregisterChain(name: string): boolean {
    return this.chains.delete(name);
  }

  getChain(name: string): ToolChain | undefined {
    return this.chains.get(name);
  }

  listChains(): string[] {
    return [...this.chains.keys()];
  }

  getChainInfo(name: string): ToolChainInfo | undefined {
    return this.chains.get(name)?.getInfo();
  }

  async executeChain(
    name: string,
    input: string,
    context: ToolChainContext = {},
  ): Promise<ToolChainRunResult> {
    const chain = this.chains.get(name);
    if (!chain) {
      throw new Error(`工具链 '${name}' 不存在`);
    }

    return chain.execute(this.registry, input, context);
  }

  registerChainAsTool(name: string, options: ToolChainToolOptions = {}): void {
    const chain = this.chains.get(name);
    if (!chain) {
      throw new Error(`工具链 '${name}' 不存在`);
    }

    this.registry.registerTool(chain.toTool(this.registry, options));
  }
}

class ToolChainTool extends Tool {
  private readonly chain: ToolChain;
  private readonly registry: ToolRegistry;
  private readonly inputParameterName: string;
  private readonly inputParameterDescription: string;

  constructor(chain: ToolChain, registry: ToolRegistry, options: ToolChainToolOptions) {
    super(chain.name, chain.description);
    this.chain = chain;
    this.registry = registry;
    this.inputParameterName = options.inputParameterName ?? "input";
    this.inputParameterDescription = options.inputParameterDescription ?? "传入工具链的原始输入";
  }

  async run(parameters: ToolParameters): Promise<string> {
    const rawInput = parameters[this.inputParameterName] ?? parameters.input ?? "";
    const result = await this.chain.execute(this.registry, String(rawInput));
    return JSON.stringify(
      {
        chainName: result.chainName,
        result: result.result,
        steps: result.steps,
      },
      null,
      2,
    );
  }

  getParameters(): ToolParameter[] {
    return [
      {
        name: this.inputParameterName,
        type: "string",
        description: this.inputParameterDescription,
        required: true,
      },
    ];
  }
}

function renderTemplate(template: string, context: ToolChainContext): string {
  return template.replace(/\{([A-Za-z_][\w.-]*)\}/g, (_match, key: string) => {
    if (!Object.hasOwn(context, key)) {
      throw new Error(`模板变量 '${key}' 不存在`);
    }

    return stringifyTemplateValue(context[key]);
  });
}

function stringifyTemplateValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value === undefined || value === null) {
    return "";
  }

  return JSON.stringify(value);
}
