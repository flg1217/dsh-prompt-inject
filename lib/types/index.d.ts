/**
 * 全局提示词注入(设置面板可配):对每条用户输入生效,覆盖所有 agent 与
 * 所有 provider——主对话、codebuddy 桥子代理、agy 驱动子代理。
 *
 * **单一通道**:`agent/pre-step` 注入一条 message(agent 级事件,全部 agent
 * 统一走这里):
 * - AGY 看不到 dsh 的 system(完整 harness 自带系统提示词),消息注入是
 *   唯一可行的载体;
 * - codebuddy 桥的原生同类工具已并入 dsh 通道(Bash/Edit/… 白名单硬移除、
 *   子代理强引导走 dsh_subagent),codebuddy/deepseek 也不再走 system
 *   section——保持单一机制,少一条平行实现;
 * - 注入消息 source={kind:'plugin',plugin:'prompt-inject'},在会话界面以
 *   "上下文注入"卡片呈现,不进普通对话流;
 * - **代际**:每条输入之后注入一条——输入边界 = 真实用户消息(kind=user)
 *   或父代理派发(kind=agent-message,子代理的每条续派都会重新注入);
 *   同一条输入的多步工具循环不重复累积;压缩把注入挤掉后自动重注。
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
