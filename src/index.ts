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
 * - 注入消息 source={kind:'prompt-inject',form:'notice',summary:'上下文注入'},
 *   在会话界面以折叠行呈现,不进普通对话流;
 * - **时机**(读 dsh 源码后修正,2026-09-18):pre-step 的 messages 是**本步
 *   从 inbox 认领的新消息**,不是完整历史——判定=**认领到真实输入就注入**
 *   (kind=user 用户消息 / kind=agent-message 父代理派发)。inbox 认领是
 *   消费式:每条输入恰好一个 step 认领,天然"每条输入一份";同一条输入的
 *   多步工具循环(tool 结果 kind=tool)不再注入(此前按"扫历史找注入标记"
 *   判定恒真,导致每次工具调用后都重复注入——实测回归)。
 *
 * 设置(profile 条目 id `prompt-inject`,面板实时生效;0.2.1 起字段即
 * 设置表单——全部标 `.volatile()`,插件直接持有活引用读取):
 * - enabled:总开关(默认开);
 * - text:全局注入文本(留空不注入);
 * - workspaces:每工作区附加文本(键=workspaceId;host 按本会话 cwd 经
 *   workspaceRegistry.resolveByPath 匹配——子代理继承父 cwd,故同工作区的
 *   子代理同样带上)。注入时全局与工作区两段合并为**一条**消息
 *   (【全局指令】/【工作区指令】小标题区分),两段皆空则不注入。
 * @module dsh-prompt-inject
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, Message } from '@deepseek-ai/dsh-llm'
// 触发 agent/* 事件的 cordis 类型声明合并(类型专用导入)。
import type {} from '@deepseek-ai/dsh-agent'
// settings 服务类型声明合并(configure({ auto: false }) 用;类型专用导入)。
import type {} from '@deepseek-ai/dsh-settings'

export const PROMPT_INJECT_NAMESPACE = 'prompt-inject'

/** 设置输入面(profile patch 条目 config / 表单写入的原始值;缺省走 schema 默认)。 */
export interface PromptInjectInput {
  enabled?: boolean
  text?: string
  workspaces?: Record<string, string>
}

/** 本插件的设置面(profile 条目 id = `prompt-inject`)。 */
export interface Config {
  enabled: Volatile<boolean>
  text: Volatile<string>
  workspaces: Volatile<Record<string, string>>
}

/** 设置表单 schema(条目 id `prompt-inject`)。显式 z<S,T> 注解:z.dict 的推断类型不可移植(TS2742)。 */
export const Config: z<PromptInjectInput, Config> = z.object({
  enabled: z.boolean().default(true).description('启用全局提示词注入').volatile(),
  text: z.string().default('').description('全局注入文本:对所有会话生效(留空不注入)').volatile(),
  workspaces: z.dict(z.string()).default({})
    .description('工作区附加注入:键为 workspaceId,值为该工作区附加指令(留空=无附加)')
    .volatile(),
})

/**
 * 本插件注入消息的 source。
 *
 * 0.2.1 起 `MessageSourceMap` 是 merge-extensible 的:每个生产者在自己的
 * 模块里声明 kind,通用的 `'plugin'` 兜底已退役——会话格式 v4 的准入校验
 * (session-format-v3-to-v4 message-sources)明确拒绝 `kind: 'plugin'`,
 * 保留旧值会让**每个回合**的注入消息都被拒("format v4 message requires a
 * producer-owned source kind",0.2.1 升级实测)。UI 按
 * `form: 'notice' + summary` 渲染折叠行,与 kind 无关。
 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'prompt-inject': { kind: 'prompt-inject' } & ContextFormed
  }
}

/** 注入消息的插件标记(代际检测与调试识别)。 */
const PLUGIN_SOURCE = {
  kind: 'prompt-inject',
  form: 'notice',
  summary: '上下文注入',
} as const

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
function hasNewInput(messages: readonly Message[]): boolean {
  return messages.some(message => {
    // 0.2.1 起 RequestUserInput(如压缩旁路追加的指令)无 source——解引用
    // message.source.kind 会抛错,且无 source 的 user 消息仍是真实输入,
    // 必须算数(否则压缩旁路调用漏注入,见 dsh-0.2.1 迁移笔记)。
    const kind = message.source?.kind as string | undefined
    return message.role === 'user'
      && (kind === undefined || kind === 'user' || kind === 'agent-message')
  })
}

/** 当前生效设置的面(从 volatile 活引用读取)。 */
interface EffectiveConfig {
  enabled: boolean
  text: string
  workspaces: Record<string, string>
}

/** 工作区注册表的读取面(只取所需字段;服务可能未挂载)。 */
interface WorkspaceLookup {
  resolveByPath?: (path: string) => Promise<{ id: string } | undefined>
}

/**
 * 当前会话 cwd 所属工作区的附加文本——全链路防御,任何一步失败都回退空串:
 * 服务缺失 / cwd 缺失 / 目录不存在 / 相对路径(realpath 抛错)/ 该工作区未配置。
 * resolveByPath 内部已做 realpath 归一,插件不做二次处理(避免 Windows
 * 大小写/symlink 分歧)。**本函数绝不抛错**(抛错会 reject pre-step 打断整轮)。
 */
async function workspaceTextFor(
  ctx: Context,
  workspaces: Record<string, string>,
  cwd: string | undefined,
): Promise<string> {
  if (cwd === undefined || cwd === '') return ''
  try {
    const registry = ctx.get('workspaceRegistry') as WorkspaceLookup | undefined
    const resolved = await registry?.resolveByPath?.(cwd)
    if (resolved === undefined) return ''
    const value = workspaces[resolved.id]
    return typeof value === 'string' ? value.trim() : ''
  } catch {
    return ''
  }
}

/**
 * 全局 + 工作区两段文本合并为**一条**注入(空段丢弃;各带一行小标题区分,
 * 让模型知道后者更具体);两段皆空时返回空串(调用方据此跳过注入)。
 */
function joinSections(globalText: string, workspaceText: string): string {
  const global = globalText.trim()
  const workspace = workspaceText.trim()
  const parts: string[] = []
  if (global.length > 0) parts.push(`【全局指令】\n${global}`)
  if (workspace.length > 0) parts.push(`【工作区指令】\n${workspace}`)
  return parts.join('\n\n')
}

export function apply(ctx: Context, config: Config): void {
  /**
   * 当前生效配置(每次注入实时读取活引用;面板写入即时可见)。
   * 值由 schema 校验保证类型:enabled/text 必为 boolean/string,
   * workspaces 为 string→string 字典(逐键再防御一次,丢弃非串值)。
   */
  const read = (): EffectiveConfig => {
    const workspaces: Record<string, string> = {}
    for (const [id, item] of Object.entries(config.workspaces.get())) {
      if (typeof item === 'string') workspaces[id] = item
    }
    return { enabled: config.enabled.get(), text: config.text.get().trim(), workspaces }
  }

  // 设置面板:本插件自带页面(客户端 plugins.item,「插件列表」条目详情),关掉按 schema
  // 自动生成表单的策略(0.2.1 起替代旧 installSection;策略不移除配置读写)。
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })

  // 唯一注入通道:所有 agent 的 pre-step——本步认领到"新输入"时追加一条
  // (inbox 认领是消费式:每条输入恰好被一个 step 认领,天然不重复)。
  // 文本 = 全局 + 本会话 cwd 所属工作区的附加,合并为一条。
  ctx.on('agent/pre-step', async (payload, next) => {
    const downstream = await next()
    const { enabled, text, workspaces } = read()
    if (!enabled) return downstream
    if (downstream.kind !== 'enter') return downstream
    if (!hasNewInput(downstream.messages)) return downstream
    const cwd = (payload as { agent?: { session?: { header?: { cwd?: string } } } })
      .agent?.session?.header?.cwd
    const workspaceText = await workspaceTextFor(ctx, workspaces, cwd)
    const merged = joinSections(text, workspaceText)
    // 两段皆空(含纯空白)→ 跳过注入,绝不写入空消息。
    if (merged.trim().length === 0) return downstream
    // 框架语:裸文本会被当成"新任务/须回应的指令"——实测 AGY 子代理收到
    // "必须使用 X 技能"后先去加载技能、复述规范,而把派发的真实任务搁置。
    // 三条要点:①明示这是**自动注入、不是用户发言**;②明示不是任务、不要为
    // 示合规而复述/执行;③给出适用时机(涉及相关操作时才遵守)。
    // 配置文本自带 </system-reminder> 会提前闭合框架;替换为转义写法
    // (字符串里写 "<\\/system-reminder>",运行时即 <\/system-reminder>)。
    const safeMerged = merged.replaceAll('</system-reminder>', '<\\/system-reminder>')
    const framed = [
      '<system-reminder>',
      'The following are persistent workspace constraints (an automated context',
      'injection — NOT a user message, NOT a task). Do not acknowledge, restate, or',
      'act on them merely to demonstrate compliance; apply them only when the current',
      'work actually involves the described operations.',
      '',
      safeMerged,
      '</system-reminder>',
    ].join('\n')
    const ours = createUserMessage({
      content: [{ type: 'text', text: framed }],
      source: PLUGIN_SOURCE,
    })
    // 顺序:插到"本步最后一条真实输入"之前——注入若排在真实用户消息之后,
    // 模型回看历史时会把最后一条 user 消息(=注入)当成"用户的最新发言",
    // 真实消息被它盖住(实测:用户的插队消息被误读为"只包含全局指令提醒,
    // 没有实质内容"而搁置)。
    const list = downstream.messages
    let at = -1
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const kind = (list[i] as { source?: { kind?: unknown } } | undefined)?.source?.kind
      if (kind === 'user' || kind === 'agent-message') { at = i; break }
    }
    return {
      ...downstream,
      messages: at >= 0
        ? [...list.slice(0, at), ours, ...list.slice(at)]
        : [...list, ours],
    }
  })
}
