/**
 * dsh-prompt-inject 测试(单一通道,pre-step 认领语义):
 * - 设置卡注册(namespace prompt-inject);不注册 system section;
 * - **本步认领到新输入**(kind=user 真实用户 / kind=agent-message 父代理派发)
 *   才注入——每条输入恰好一份;
 * - **工具结果步不注入**(kind=tool;修复"每次工具调用后都重复注入"的回归);
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

/** 真实用户消息(kind=user)。 */
function userMessage(id: string, text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } as never })
}

/** 父代理派发(kind=agent-message)。 */
function dispatchedMessage(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'agent-message' } as never })
}

/** 工具结果消息(kind=tool)——同一条输入的多步循环里 step 认领的就是它。 */
function toolResultMessage(callId: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'ok' }] }],
    source: { kind: 'tool', callId } as never,
  })
}

/** 跑一次 pre-step(claimed = 本步认领的新消息)。 */
async function runPreStep(
  preStep: ReturnType<typeof setup>['preStep'],
  claimed: Message[],
): Promise<{ messages: Message[]; injected: UserMessage[] }> {
  const result = await preStep!(
    { messages: claimed },
    async () => ({ kind: 'enter', messages: claimed }),
  )
  const injected = result.messages.filter(
    m => (m.source as { plugin?: string }).plugin === 'prompt-inject',
  ) as UserMessage[]
  return { messages: result.messages, injected }
}

describe('dsh-prompt-inject:pre-step 认领语义', () => {
  it('注册 prompt-inject 设置卡;不注册 system section(单通道)', () => {
    const { section, namespace } = setup({ text: 'x' })
    expect(namespace).toBe(PROMPT_INJECT_NAMESPACE)
    expect(section).toBeUndefined()
  })

  it('认领到用户消息 → 追加一条注入(插件标记)', async () => {
    const { preStep } = setup({ enabled: true, text: '每条回复末尾加"喵"' })
    const { injected } = await runPreStep(preStep, [userMessage('u1', '你好')])
    expect(injected).toHaveLength(1)
    expect(injected[0]!.role).toBe('user')
    expect(injected[0]!.content).toEqual([{ type: 'text', text: '每条回复末尾加"喵"' }])
  })

  it('只认领到工具结果 → 不注入(回归:不再每次工具调用后重复注入)', async () => {
    const { preStep } = setup({ enabled: true, text: 'X 规则' })
    // 一条输入之后,同一条输入的多步工具循环:每个 step 认领的是 tool 结果。
    const step1 = await runPreStep(preStep, [toolResultMessage('c1')])
    expect(step1.injected).toHaveLength(0)
    const step2 = await runPreStep(preStep, [toolResultMessage('c2')])
    expect(step2.injected).toHaveLength(0)
    // 空认领(收尾步)同样不注入。
    const step3 = await runPreStep(preStep, [])
    expect(step3.injected).toHaveLength(0)
  })

  it('认领到父代理派发(agent-message) → 注入(子代理每条续派都带)', async () => {
    const { preStep } = setup({ enabled: true, text: 'X 规则' })
    const { injected } = await runPreStep(preStep, [dispatchedMessage('继续改这个文件')])
    expect(injected).toHaveLength(1)
  })

  it('空文本 / 关闭开关:不注入', async () => {
    const emptyText = setup({ enabled: true, text: '  ' })
    expect((await runPreStep(emptyText.preStep, [userMessage('u1', 'hi')])).injected).toHaveLength(0)
    const disabled = setup({ enabled: false, text: 'X' })
    expect((await runPreStep(disabled.preStep, [userMessage('u1', 'hi')])).injected).toHaveLength(0)
  })

  it('settings 服务缺失时回退插件行内 config', async () => {
    let preStep: ReturnType<typeof setup>['preStep']
    const ctx = {
      get: () => undefined,
      inject: () => {},
      on: (event: string, handler: never) => { if (event === 'agent/pre-step') preStep = handler },
    } as unknown as Context
    apply(ctx, { text: '行内配置规则' })
    const { injected } = await runPreStep(preStep, [userMessage('u1', 'hi')])
    expect(injected).toHaveLength(1)
    expect(injected[0]!.content).toEqual([{ type: 'text', text: '行内配置规则' }])
  })
})
