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
/** 注入文本的包装(让模型可辨识来源;空文本由调用方过滤)。 */
function injectedText(text) {
    return `用户自定义指令(随每条输入下发,必须遵守):\n${text}`;
}
/** 上次注入在这条消息之后?——从尾部找两种位置。
 * 代际边界 = 真实用户输入(kind=user)**与父代理派发(kind=agent-message)**:
 * 子代理的每条输入(含父代理续派的新任务)都要在其后确认一次注入,
 * 而不是只在首条任务后注一次——压缩把注入挤掉后同样自愈重注。 */
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
    // 1) 设置面板卡片(namespace prompt-inject)。
    ctx.inject(['settings'], (settingsCtx) => {
        const settings = settingsCtx.get('settings');
        settings?.installSection?.(ctx, PROMPT_INJECT_NAMESPACE, PromptInjectConfig, {}, {
            setSource: () => { },
            onChange: () => { },
        });
    });
    // 2) system 通道:所有走 dsh system 的 agent(含 codebuddy 子代理)。
    ctx.inject(['systemPrompt'], (systemCtx) => {
        const systemPrompt = systemCtx.get('systemPrompt');
        if (systemPrompt?.section === undefined)
            return;
        systemPrompt.section({
            name: 'inject:global-prompt',
            order: 5,
            text: () => {
                const { enabled, text } = read();
                return enabled && text.length > 0 ? injectedText(text) : '';
            },
        });
    });
    // 3) agy 通道:AGY 不看 dsh system,注入一条 message(适配器会序列化补发)。
    ctx.on('agent/pre-step', async (payload, next) => {
        const downstream = await next();
        const { enabled, text } = read();
        if (!enabled || text.length === 0)
            return downstream;
        if (downstream.kind !== 'enter')
            return downstream;
        if (payload.agent.options.provider !== 'agy')
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
