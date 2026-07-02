# AGENTS.md instructions

@/Users/chdj/.codex/RTK.md

## 项目约定
- 不用TDD开发，写完之后写一个examples里面写一些能跑的测试case即可
- 本项目主要是将`/Users/chdj/my-project/agent-projects/HelloAgents/hello_agents`这里python版本转成TS版本，不要一下子全实现了，要一步一步实现
- 同时需要把实现的思路像这里配套的教程`/Users/chdj/my-project/agent-projects/hello-agents/docs`一样，教学文字风格要参考教程那样的，分章节记录下来放到`teach-doc目录下面`
- `teach-doc`里的教程不要写成“从 Python 某个版本迁移/改写”的说明，而要写成独立的从零构建教程。默认读者没有底层框架经验，每一章都要非常详细地解释为什么这样设计、每个文件负责什么、每一步代码怎么手写、如何运行验证，目标是让读者能跟着文档一步步做出一个可用的 TypeScript SDK。
- 写 `teach-doc` 教学文档时，详细程度要参考现有第一篇 `teach-doc/01-core-llm-layer.md`：不能只写摘要或 API 清单，要把实现过程拆开讲清楚。
- 每篇教程都要覆盖本章新增能力的完整实现链路：为什么需要这个模块、目录结构如何变化、每个新文件负责什么、核心类型/类/方法如何一步步写出来、这些模块之间如何串起来、如何通过 examples 运行验证。
- 如果本章涉及 Agent 或工具系统，教程必须明确讲清楚工具定义规范、工具注册流程、Agent 如何拿到工具说明、Agent 如何组装 prompt、如何解析工具调用、如何执行工具、如何把工具结果交回 LLM、历史消息如何保存。
- 教程里的示例要尽量贴近真实使用场景，优先使用 `HelloAgentsLLM` 和 `examples/.env` 的真实配置方式；只有在明确说明是离线单元验证时才使用 mock。
- 教程中的代码片段、方法名、文件路径必须和当前 TypeScript 实现保持一致，避免出现 Python 风格命名或尚未实现的 API。
