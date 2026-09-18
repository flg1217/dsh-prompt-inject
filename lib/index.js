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
 * 上次注入在这条输入之后?——找最后一条"输入边界"与最后一条注入的位置。
 * 输入边界 = 真实用户消息(kind=user)与父代理派发(kind=agent-message):
 * 子代理的每条续派都会重新注入,而不是只在首条任务后注一次;
 * 压缩把注入挤掉(lastInjectAt 消失)后同样自愈重注。
 */
function needsInject(messages) {
    let lastInputAt = -1;
    let lastInjectAt = -1;
    for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        const kind = message.source.kind;
        if (message.role === 'user' && (kind === 'user' || kind === 'agent-message'))
            lastInputAt = index;
        if (message.source.plugin === PLUGIN_SOURCE.plugin)
            lastInjectAt = index;
    }
    return lastInjectAt <= lastInputAt;
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
    // 唯一注入通道:所有 agent 的 pre-step——每条输入后追加一条注入消息。
    ctx.on('agent/pre-step', async (_payload, next) => {
        const downstream = await next();
        const { enabled, text } = read();
        if (!enabled || text.length === 0)
            return downstream;
        if (downstream.kind !== 'enter')
            return downstream;
        if (!needsInject(downstream.messages))
            return downstream;
        const ours = createUserMessage({
            content: [{ type: 'text', text }],
            source: PLUGIN_SOURCE,
        });
        return { ...downstream, messages: [...downstream.messages, ours] };
    });
}
