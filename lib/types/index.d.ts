/**
 * 全局提示词注入(设置面板可配):对每条用户输入生效,覆盖所有 agent 与
 * 所有 provider——主对话、codebuddy 桥子代理、agy 驱动子代理都带上。
 *
 * 双通道(按路径分流,避免重复):
 * - **systemPrompt.section**(默认通道):所有走 dsh 组装 system 的路径——
 *   主对话各 provider、codebuddy 子代理(桥把 dsh system 透传给 CLI)。
 *   system 每步 assemble 一次、只有一份,天然不重复;CLI 内部子代理也能
 *   看到(system 在它们的提示里)。
 * - **agent/pre-step message 注入**(agy 通道):provider === 'agy' 的 agent
 *   ——AGY 是完整 harness,不看 dsh 组装的 system;注入的 message 会进
 *   messages,被 llm-agy 适配器序列化补发(含 agy 会话的增量续跑)。
 *   按"用户消息代际"注入:最后一个真实用户消息之后已注入过就跳过,
 *   多步工具循环不会重复累积。
 *
 * 设置(namespace `prompt-inject`,面板实时生效):
 * - enabled:总开关(默认开);
 * - text:注入文本(默认空——空等于不注入,填上即生效)。
 * @module dsh-prompt-inject
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const PROMPT_INJECT_NAMESPACE = "prompt-inject";
/** 设置表单 schema(namespace `prompt-inject`)。 */
export declare const PromptInjectConfig: z<Schemastery.ObjectS<{
    enabled: z<boolean, boolean>;
    text: z<string, string>;
}>, Schemastery.ObjectT<{
    enabled: z<boolean, boolean>;
    text: z<string, string>;
}>>;
export interface Config {
    /** 兼容字段:插件行内配置(面板设置优先)。 */
    text?: string;
}
export declare function apply(ctx: Context, config?: Config): void;
