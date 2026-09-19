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
import z from '@deepseek-ai/schemastery';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
export const PROMPT_INJECT_NAMESPACE = 'prompt-inject';
/** 设置表单 schema(namespace `prompt-inject`)。显式 z<T> 注解:z.dict 的推断类型不可移植(TS2742)。 */
export const PromptInjectConfig = z.object({
    enabled: z.boolean().default(true).description('启用全局提示词注入'),
    text: z.string().default('').description('全局注入文本:对所有会话生效(留空不注入)'),
    workspaces: z.dict(z.string()).default({})
        .description('工作区附加注入:键为 workspaceId,值为该工作区附加指令(留空=无附加)'),
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
/**
 * 当前会话 cwd 所属工作区的附加文本——全链路防御,任何一步失败都回退空串:
 * 服务缺失 / cwd 缺失 / 目录不存在 / 相对路径(realpath 抛错)/ 该工作区未配置。
 * resolveByPath 内部已做 realpath 归一,插件不做二次处理(避免 Windows
 * 大小写/symlink 分歧)。**本函数绝不抛错**(抛错会 reject pre-step 打断整轮)。
 */
async function workspaceTextFor(ctx, workspaces, cwd) {
    if (cwd === undefined || cwd === '')
        return '';
    try {
        const registry = ctx.get('workspaceRegistry');
        const resolved = await registry?.resolveByPath?.(cwd);
        if (resolved === undefined)
            return '';
        const value = workspaces[resolved.id];
        return typeof value === 'string' ? value.trim() : '';
    }
    catch {
        return '';
    }
}
/**
 * 全局 + 工作区两段文本合并为**一条**注入(空段丢弃;各带一行小标题区分,
 * 让模型知道后者更具体);两段皆空时返回空串(调用方据此跳过注入)。
 */
function joinSections(globalText, workspaceText) {
    const global = globalText.trim();
    const workspace = workspaceText.trim();
    const parts = [];
    if (global.length > 0)
        parts.push(`【全局指令】\n${global}`);
    if (workspace.length > 0)
        parts.push(`【工作区指令】\n${workspace}`);
    return parts.join('\n\n');
}
export function apply(ctx, config = {}) {
    /**
     * 当前生效配置。契约(重要,防"面板清空后旧值阴魂不散"):
     * - settings 服务在场 → **只信 settings** 的解析结果(空串/缺省/异常类型一律
     *   当作空,不回退行内 config;字符串才采用);
     * - settings 服务整体缺失(如最小部署/测试) → 才回退行内 config。
     */
    const read = () => {
        const settings = ctx.get('settings');
        const value = settings?.get?.(PROMPT_INJECT_NAMESPACE);
        const text = (settings === undefined
            ? typeof config.text === 'string' ? config.text : ''
            : typeof value?.text === 'string' ? value.text : '').trim();
        const workspaces = {};
        if (value?.workspaces !== null && typeof value?.workspaces === 'object') {
            for (const [id, item] of Object.entries(value.workspaces)) {
                if (typeof item === 'string')
                    workspaces[id] = item;
            }
        }
        return { enabled: value?.enabled !== false, text, workspaces };
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
    // 文本 = 全局 + 本会话 cwd 所属工作区的附加,合并为一条。
    ctx.on('agent/pre-step', async (payload, next) => {
        const downstream = await next();
        const { enabled, text, workspaces } = read();
        if (!enabled)
            return downstream;
        if (downstream.kind !== 'enter')
            return downstream;
        if (!hasNewInput(downstream.messages))
            return downstream;
        const cwd = payload
            .agent?.session?.header?.cwd;
        const workspaceText = await workspaceTextFor(ctx, workspaces, cwd);
        const merged = joinSections(text, workspaceText);
        // 两段皆空(含纯空白)→ 跳过注入,绝不写入空消息。
        if (merged.trim().length === 0)
            return downstream;
        const ours = createUserMessage({
            content: [{ type: 'text', text: merged }],
            source: PLUGIN_SOURCE,
        });
        return { ...downstream, messages: [...downstream.messages, ours] };
    });
}
