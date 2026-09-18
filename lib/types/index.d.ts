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
 * - **时机**(读 dsh 源码后修正,2026-09-18):pre-step 的 messages 是**本步
 *   从 inbox 认领的新消息**,不是完整历史——判定=**认领到真实输入就注入**
 *   (kind=user 用户消息 / kind=agent-message 父代理派发)。inbox 认领是
 *   消费式:每条输入恰好一个 step 认领,天然"每条输入一份";同一条输入的
 *   多步工具循环(tool 结果 kind=tool)不再注入(此前按"扫历史找注入标记"
 *   判定恒真,导致每次工具调用后都重复注入——实测回归)。
 *
 * 设置(namespace `prompt-inject`,面板实时生效):
 * - enabled:总开关(默认开);
 * - text:全局注入文本(留空不注入);
 * - workspaces:每工作区附加文本(键=workspaceId;host 按本会话 cwd 经
 *   workspaceRegistry.resolveByPath 匹配——子代理继承父 cwd,故同工作区的
 *   子代理同样带上)。注入时全局与工作区两段合并为**一条**消息
 *   (【全局指令】/【工作区指令】小标题区分),两段皆空则不注入。
 * @module dsh-prompt-inject
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const PROMPT_INJECT_NAMESPACE = "prompt-inject";
/** 设置值的结构化面(namespace `prompt-inject`)。 */
export interface PromptInjectSettings {
    enabled: boolean;
    text: string;
    workspaces: Record<string, string>;
}
/** 设置表单 schema(namespace `prompt-inject`)。显式 z<T> 注解:z.dict 的推断类型不可移植(TS2742)。 */
export declare const PromptInjectConfig: z<PromptInjectSettings>;
export interface Config {
    /** 兼容字段:插件行内配置(面板设置优先)。 */
    text?: string;
}
export declare function apply(ctx: Context, config?: Config): void;
