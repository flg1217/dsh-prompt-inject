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
 * - text:注入文本(默认空——空等于不注入,填上即生效)。
 * @module dsh-prompt-inject
 */
import z from '@deepseek-ai/schemastery';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
export const PROMPT_INJECT_NAMESPACE = 'prompt-inject';
/** 设置表单 schema(namespace `prompt-inject`)。 */
export const PromptInjectConfig = z.object({
    enabled: z.boolean().default(true).description('启用全局提示词注入'),
    text: z.string().default('').description('每次输入随行注入的提示词(留空不注入)'),
});
/** 注入消息的插件标记(代际检测与调试识别)。 */
const PLUGIN_SOURCE = { kind: 'plugin', plugin: 'prompt-inject' };
/**
 * 本步认领的新消息里是否含"新输入"?——pre-step 的 messages 是**本步从
 * inbox 认领的新消息**(agent-loop 的 inbox.claim),**不是完整历史**:
 * 上一轮注入的消息不会出现在下一步的列表里(实测:按"扫历史找注入标记"
 * 判定会恒真——每次工具调用后都重复注入)。
 *
 * 输入边界 = 真实用户消息(kind=user)与父代理派发(kind=agent-message)。
 * 每条输入只被一个 step 认领一次,因此"含输入即注入"恰好保证:
 * 每条输入一份——同一条输入的多步工具循环(tool 结果 kind=tool)不再注入。
 */
function hasNewInput(messages) {
    return messages.some(message => {
        const kind = message.source.kind;
        return message.role === 'user' && (kind === 'user' || kind === 'agent-message');
    });
}
export function apply(ctx, config = {}) {
    /** 当前生效配置:面板设置优先,回退插件行内 config。 */
    const read = () => {
        const settings = ctx.get('settings');
        const value = settings?.get?.(PROMPT_INJECT_NAMESPACE);
        const text = (value?.text ?? config.text ?? '').trim();
        return { enabled: value?.enabled !== false, text };
    };
    // 设置面板卡片(namespace prompt-inject)。
    ctx.inject(['settings'], (settingsCtx) => {
        const settings = settingsCtx.get('settings');
        settings?.installSection?.(ctx, PROMPT_INJECT_NAMESPACE, PromptInjectConfig, {}, {
            setSource: () => { },
            onChange: () => { },
        });
    });
    // 唯一注入通道:所有 agent 的 pre-step——本步认领到"新输入"时追加一条
    // (inbox 认领是消费式:每条输入恰好被一个 step 认领,天然不重复)。
    ctx.on('agent/pre-step', async (_payload, next) => {
        const downstream = await next();
        const { enabled, text } = read();
        if (!enabled || text.length === 0)
            return downstream;
        if (downstream.kind !== 'enter')
            return downstream;
        if (!hasNewInput(downstream.messages))
            return downstream;
        const ours = createUserMessage({
            content: [{ type: 'text', text }],
            source: PLUGIN_SOURCE,
        });
        return { ...downstream, messages: [...downstream.messages, ours] };
    });
}
