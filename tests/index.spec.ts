/**
 * dsh-prompt-inject 测试(单一通道):
 * - 设置卡注册(namespace prompt-inject);
 * - **所有 provider** 统一走 pre-step message 注入(不再有 system section);
 * - 代际:同一输入的多步不重复;新用户输入 / 父代理续派(agent-message)
 *   之后重新注入;
 * - 空文本/关闭开关不注入;settings 服务缺失时回退插件行内 config。
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message, UserMessage } from '@deepseek-ai/dsh-llm'
import { apply, PROMPT_INJECT_NAMESPACE } from '../src/index.ts'

interface SectionDef {
  name?: string
  text?: () => string
}

/** 假 ctx:捕获设置卡注册与 pre-step 处理器,并记录是否注册过 system section。 */
function setup(settings?: { enabled?: boolean; text?: string }): {
  section: SectionDef | undefined
  namespace: string | undefined
  preStep: ((payload: unknown, next: () => Promise<{ kind: string; messages: Message[] }>) => Promise<{ kind: string; messages: Message[] }>) | undefined
} {
  let section: SectionDef | undefined
  let namespace: string | undefined
  let preStep: ReturnType<typeof setup>['preStep']
  const ctx = {
    get: (key: string) => (key === 'settings'
      ? { get: (ns: string) => (ns === PROMPT_INJECT_NAMESPACE ? settings : undefined) }
      : undefined),
    inject: (deps: string[], fn: (injected: Context) => void) => {
      if (deps.includes('settings')) {
        fn({
          get: (key: string) => (key === 'settings'
            ? { installSection: (_owner: unknown, ns: string) => { namespace = ns } }
            : undefined),
        } as unknown as Context)
      }
      if (deps.includes('systemPrompt')) {
        fn({
          get: (key: string) => (key === 'systemPrompt'
            ? { section: (def: SectionDef) => { section = def; return () => {} } }
            : undefined),
        } as unknown as Context)
      }
    },
    on: (event: string, handler: never) => { if (event === 'agent/pre-step') preStep = handler },
  } as unknown as Context
  apply(ctx, {})
  return { section, namespace, preStep }
}

/** 一条真实用户消息。 */
function userMessage(id: string, text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } as never })
}

/** 父代理派发的消息(agent-message)。 */
function dispatchedMessage(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'agent-message' } as never })
}

/** 跑一次 pre-step。 */
async function runPreStep(
  preStep: ReturnType<typeof setup>['preStep'],
  messages: Message[],
): Promise<Message[]> {
  const result = await preStep!(
    { agent: { options: { provider: 'x' } }, messages },
    async () => ({ kind: 'enter', messages }),
  )
  return result.messages
}

/** 取注入消息(按 source.plugin 识别)。 */
function injections(messages: readonly Message[]): UserMessage[] {
  return messages.filter(m => (m.source as { plugin?: string }).plugin === 'prompt-inject') as UserMessage[]
}

describe('dsh-prompt-inject:单一通道', () => {
  it('注册 prompt-inject 设置卡;不再注册 system section(单通道)', () => {
    const { section, namespace } = setup({ text: 'x' })
    expect(namespace).toBe(PROMPT_INJECT_NAMESPACE)
    expect(section).toBeUndefined()
  })

  it('任意 provider 统一注入一条消息(role user,插件标记)', async () => {
    const { preStep } = setup({ enabled: true, text: '每条回复末尾加"喵"' })
    const after = await runPreStep(preStep, [userMessage('u1', '你好')])
    expect(after).toHaveLength(2)
    const injected = injections(after)
    expect(injected).toHaveLength(1)
    expect(injected[0]!.role).toBe('user')
    expect(injected[0]!.content).toEqual([{ type: 'text', text: '每条回复末尾加"喵"' }])
  })

  it('同一输入代际内不重复;新用户输入后再次注入', async () => {
    const { preStep } = setup({ enabled: true, text: 'X 规则' })
    const first = await runPreStep(preStep, [userMessage('u1', '你好')])
    const second = await runPreStep(preStep, first)
    expect(injections(second)).toHaveLength(1) // 多步不累积
    const nextUser = [...second, userMessage('u2', '继续')]
    const third = await runPreStep(preStep, nextUser)
    expect(injections(third)).toHaveLength(2) // 新输入后再注入一条
  })

  it('父代理续派(agent-message)后同样重新注入——子代理每条输入都带', async () => {
    const { preStep } = setup({ enabled: true, text: 'X 规则' })
    const first = await runPreStep(preStep, [userMessage('u1', '初始任务')])
    expect(injections(first)).toHaveLength(1)
    const second = await runPreStep(preStep, [...first, dispatchedMessage('继续改这个文件')])
    expect(injections(second)).toHaveLength(2)
    const third = await runPreStep(preStep, second)
    expect(injections(third)).toHaveLength(2) // 同输入后续步不重复
  })

  it('空文本 / 关闭开关:不注入', async () => {
    const emptyText = setup({ enabled: true, text: '  ' })
    expect(await runPreStep(emptyText.preStep, [userMessage('u1', 'hi')])).toHaveLength(1)
    const disabled = setup({ enabled: false, text: 'X' })
    expect(await runPreStep(disabled.preStep, [userMessage('u1', 'hi')])).toHaveLength(1)
  })

  it('settings 服务缺失时回退插件行内 config', async () => {
    let preStep: ReturnType<typeof setup>['preStep']
    const ctx = {
      get: () => undefined,
      inject: () => {},
      on: (event: string, handler: never) => { if (event === 'agent/pre-step') preStep = handler },
    } as unknown as Context
    apply(ctx, { text: '行内配置规则' })
    const after = await runPreStep(preStep, [userMessage('u1', 'hi')])
    expect(injections(after)).toHaveLength(1)
    expect(injections(after)[0]!.content).toEqual([{ type: 'text', text: '行内配置规则' }])
  })
})
