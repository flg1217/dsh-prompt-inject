/**
 * dsh-prompt-inject 测试:
 * - 设置卡注册(namespace prompt-inject);
 * - system 通道:section 文本随设置实时变化,空文本/关闭时为空;
 * - agy 通道:pre-step 注入一条 message(代际控制:同一用户输入不重复;
 *   下一条用户输入后再次注入);非 agy provider 不注入(避免与 system 重复)。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message, UserMessage } from '@deepseek-ai/dsh-llm'
import { apply, PROMPT_INJECT_NAMESPACE } from '../src/index.ts'

interface SectionDef {
  name?: string
  order?: number
  text?: () => string
}

/** 假 ctx:捕获 section 注册与 pre-step 处理器;settings 由参数决定。 */
function setup(settings?: { enabled?: boolean; text?: string }): {
  section: SectionDef | undefined
  namespace: string | undefined
  preStep: ((payload: { agent: { options: { provider?: string } } }, next: () => Promise<{ kind: string; messages: Message[] }>) => Promise<{ kind: string; messages: Message[] }>) | undefined
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

/** 跑一次 pre-step(provider 决定走哪条通道)。 */
async function runPreStep(
  preStep: ReturnType<typeof setup>['preStep'],
  provider: string,
  messages: Message[],
): Promise<Message[]> {
  const result = await preStep!(
    { agent: { options: { provider } } },
    async () => ({ kind: 'enter', messages }),
  )
  return result.messages
}

describe('dsh-prompt-inject:设置卡与 system 通道', () => {
  it('注册 prompt-inject 设置卡与 section(order 5)', () => {
    const { section, namespace } = setup({ text: 'x' })
    expect(namespace).toBe(PROMPT_INJECT_NAMESPACE)
    expect(section?.name).toBe('inject:global-prompt')
    expect(section?.order).toBe(5)
  })

  it('system 文本随设置实时变化;空文本/关闭时为空串', () => {
    // 空文本 → ''
    const emptySetup = setup({ enabled: true, text: '   ' })
    expect(emptySetup.section?.text?.()).toBe('')
    // 有文本 → 含包装与内容
    const withText = setup({ enabled: true, text: '永远用中文回答' })
    const text = withText.section?.text?.() ?? ''
    expect(text).toContain('用户自定义指令')
    expect(text).toContain('永远用中文回答')
    // 关闭 → ''
    const disabled = setup({ enabled: false, text: '永远用中文回答' })
    expect(disabled.section?.text?.()).toBe('')
  })
})

describe('dsh-prompt-inject:agy 通道(pre-step message 注入)', () => {
  it('provider=agy:追加上一条注入消息(role user,插件标记)', async () => {
    const { preStep } = setup({ enabled: true, text: '每条回复末尾加"喵"' })
    const messages: Message[] = [userMessage('u1', '你好')]
    const after = await runPreStep(preStep, 'agy', messages)
    expect(after).toHaveLength(2)
    const injected = after[1] as UserMessage
    expect(injected.role).toBe('user')
    expect((injected.source as { plugin?: string }).plugin).toBe('prompt-inject')
    expect(injected.content).toEqual([{ type: 'text', text: '每条回复末尾加"喵"' }])
  })

  it('同一用户输入代际内不重复注入(多步工具循环只带一条)', async () => {
    const { preStep } = setup({ enabled: true, text: 'X 规则' })
    const first = await runPreStep(preStep, 'agy', [userMessage('u1', '你好')])
    // 第二步:消息里已有注入(在最后一条用户消息之后)→ 不再追加。
    const second = await runPreStep(preStep, 'agy', first)
    expect(second).toHaveLength(first.length)
    // 下一条用户输入之后 → 再次注入(对新输入也生效)。
    const nextUser = [...second, userMessage('u2', '继续')]
    const third = await runPreStep(preStep, 'agy', nextUser)
    expect(third).toHaveLength(nextUser.length + 1)
  })

  it('provider≠agy:不注入(该路径由 system 通道覆盖,避免双份)', async () => {
    const { preStep } = setup({ enabled: true, text: 'X 规则' })
    const messages: Message[] = [userMessage('u1', '你好')]
    const after = await runPreStep(preStep, 'deepseek', messages)
    expect(after).toHaveLength(1)
  })

  it('空文本 / 关闭开关:不注入', async () => {
    const emptyText = setup({ enabled: true, text: '  ' })
    expect(await runPreStep(emptyText.preStep, 'agy', [userMessage('u1', 'hi')])).toHaveLength(1)
    const disabled = setup({ enabled: false, text: 'X' })
    expect(await runPreStep(disabled.preStep, 'agy', [userMessage('u1', 'hi')])).toHaveLength(1)
  })

  it('settings 服务缺失时回退插件行内 config', async () => {
    let preStep: ReturnType<typeof setup>['preStep']
    const ctx = {
      get: () => undefined,
      inject: () => {},
      on: (event: string, handler: never) => { if (event === 'agent/pre-step') preStep = handler },
    } as unknown as Context
    apply(ctx, { text: '行内配置规则' })
    const after = await runPreStep(preStep, 'agy', [userMessage('u1', 'hi')])
    expect(after).toHaveLength(2)
    expect((after[1] as UserMessage).content).toEqual([{ type: 'text', text: '行内配置规则' }])
    void vi
  })
})
