/**
 * dsh-prompt-inject 测试(pre-step 认领语义 + 工作区级注入):
 * - 设置卡注册(namespace prompt-inject);不注册 system section;
 * - 本步认领到新输入(kind=user / agent-message)才注入——每条输入恰好一份;
 *   工具结果步(kind=tool)不注入(修复"每次工具调用后都重复注入"的回归);
 * - 工作区匹配:agent.session.header.cwd → workspaceRegistry.resolveByPath
 *   → settings.workspaces[id];全局与工作区文本合并为**一条**;
 * - 全链路失败(服务缺失/cwd 缺失/解析抛错/未配置)一律回退"仅全局",绝不 reject。
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message, UserMessage } from '@deepseek-ai/dsh-llm'
import { apply, PROMPT_INJECT_NAMESPACE } from '../src/index.ts'

type SettingsValue = {
  enabled?: boolean
  text?: string
  workspaces?: Record<string, unknown>
}

interface SetupOptions {
  settings?: SettingsValue
  /** workspaceRegistry 行为:resolved=命中;undefined=未命中;throw=抛错;缺省=无服务。 */
  registry?: { resolved?: { id: string }; throw?: boolean }
}

interface Setup {
  section: unknown
  namespace: string | undefined
  preStep: ((payload: unknown, next: () => Promise<{ kind: string; messages: Message[] }>) => Promise<{ kind: string; messages: Message[] }>) | undefined
}

/** 假 ctx:捕获设置卡注册与 pre-step;workspaceRegistry 由参数决定行为。 */
function setup(options: SetupOptions = {}): Setup {
  let section: unknown
  let namespace: string | undefined
  let preStep: Setup['preStep']
  const services: Record<string, unknown> = {
    settings: {
      get: (ns: string) => (ns === PROMPT_INJECT_NAMESPACE ? options.settings : undefined),
      installSection: (_owner: unknown, ns: string) => { namespace = ns },
    },
  }
  if (options.registry !== undefined) {
    services.workspaceRegistry = {
      resolveByPath: async (_path: string) => {
        if (options.registry!.throw === true) throw new Error('ENOENT: no such directory')
        return options.registry!.resolved
      },
    }
  }
  const ctx = {
    get: (key: string) => services[key],
    inject: (deps: string[], fn: (injected: Context) => void) => {
      if (deps.includes('settings')) fn({ get: (key: string) => services[key] } as unknown as Context)
      if (deps.includes('systemPrompt')) {
        fn({
          get: (key: string) => (key === 'systemPrompt'
            ? { section: (def: unknown) => { section = def; return () => {} } }
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

/** 跑一次 pre-step(claimed = 本步认领的新消息;cwd 可注)。 */
async function runPreStep(
  preStep: Setup['preStep'],
  claimed: Message[],
  cwd?: string,
): Promise<{ messages: Message[]; injected: UserMessage[] }> {
  const agent = { session: { header: cwd === undefined ? {} : { cwd } } }
  const result = await preStep!(
    { agent, messages: claimed },
    async () => ({ kind: 'enter', messages: claimed }),
  )
  const injected = result.messages.filter(
    m => (m.source as { plugin?: string }).plugin === 'prompt-inject',
  ) as UserMessage[]
  return { messages: result.messages, injected }
}

/** 注入消息的文本。 */
function injectedText(injected: UserMessage[]): string {
  return injected.flatMap(m => m.content.filter(b => b.type === 'text').map(b => b.text)).join('')
}

describe('dsh-prompt-inject:注册与基础语义', () => {
  it('注册 prompt-inject 设置卡;不注册 system section', () => {
    const { section, namespace } = setup({ settings: { text: 'x' } })
    expect(namespace).toBe(PROMPT_INJECT_NAMESPACE)
    expect(section).toBeUndefined()
  })

  it('认领到用户消息 → 追加一条注入,全局文本带【全局指令】小标题', async () => {
    const { preStep } = setup({ settings: { enabled: true, text: '每条回复末尾加"喵"' } })
    const { injected } = await runPreStep(preStep, [userMessage('u1', '你好')])
    expect(injected).toHaveLength(1)
    expect(injected[0]!.role).toBe('user')
    const text = injectedText(injected)
    expect(text).toContain('【全局指令】')
    expect(text).toContain('每条回复末尾加"喵"')
  })

  it('只认领到工具结果 → 不注入(回归:不再每次工具调用后重复注入)', async () => {
    const { preStep } = setup({ settings: { enabled: true, text: 'X 规则' } })
    expect((await runPreStep(preStep, [toolResultMessage('c1')])).injected).toHaveLength(0)
    expect((await runPreStep(preStep, [toolResultMessage('c2')])).injected).toHaveLength(0)
    expect((await runPreStep(preStep, [])).injected).toHaveLength(0)
  })

  it('认领到父代理派发(agent-message) → 注入', async () => {
    const { preStep } = setup({ settings: { enabled: true, text: 'X 规则' } })
    const { injected } = await runPreStep(preStep, [dispatchedMessage('继续改这个文件')])
    expect(injected).toHaveLength(1)
  })

  it('关闭开关 / 全局与工作区皆空:不注入', async () => {
    const disabled = setup({ settings: { enabled: false, text: 'X' } })
    expect((await runPreStep(disabled.preStep, [userMessage('u1', 'hi')])).injected).toHaveLength(0)
    const empty = setup({ settings: { enabled: true, text: '  ', workspaces: {} } })
    expect((await runPreStep(empty.preStep, [userMessage('u1', 'hi')])).injected).toHaveLength(0)
  })

  it('settings 服务缺失时回退插件行内 config', async () => {
    let preStep: Setup['preStep']
    const ctx = {
      get: () => undefined,
      inject: () => {},
      on: (event: string, handler: never) => { if (event === 'agent/pre-step') preStep = handler },
    } as unknown as Context
    apply(ctx, { text: '行内配置规则' })
    const { injected } = await runPreStep(preStep, [userMessage('u1', 'hi')])
    expect(injected).toHaveLength(1)
    expect(injectedText(injected)).toContain('行内配置规则')
  })

  it('settings 服务在场:空串/null/异常类型一律当空,不回退行内 config(防阴魂不散)', async () => {
    // text 显式空串(面板清空)→ 跳过,不注入行内 config 的旧值。
    const empty = setup({ settings: { enabled: true, text: '' }, registry: {} })
    expect((await runPreStep(empty.preStep, [userMessage('u1', 'hi')])).injected).toHaveLength(0)
    // text 为 null(手工编辑 YAML 的裸键)→ 跳过。
    const nulled = setup({ settings: { enabled: true, text: null as never }, registry: {} })
    expect((await runPreStep(nulled.preStep, [userMessage('u1', 'hi')])).injected).toHaveLength(0)
    // text 为异常类型(数字)→ 跳过。
    const odd = setup({ settings: { enabled: true, text: 3 as never }, registry: {} })
    expect((await runPreStep(odd.preStep, [userMessage('u1', 'hi')])).injected).toHaveLength(0)
    // workspaces 值全为空白 → 仅全局生效,不产生【工作区指令】段。
    const blankWs = setup({
      settings: { enabled: true, text: 'G', workspaces: { 'ws-1': '   ' } },
      registry: { resolved: { id: 'ws-1' } },
    })
    const text = injectedText((await runPreStep(blankWs.preStep, [userMessage('u1', 'hi')], 'D:/x')).injected)
    expect(text).toContain('G')
    expect(text).not.toContain('【工作区指令】')
  })
})

describe('dsh-prompt-inject:工作区级注入', () => {
  const settings: SettingsValue = {
    enabled: true,
    text: '全局规则',
    workspaces: { 'ws-1': '本工作区规则', 'ws-empty': '   ' },
  }

  it('命中工作区:全局 + 工作区合并为一条注入', async () => {
    const { preStep } = setup({ settings, registry: { resolved: { id: 'ws-1' } } })
    const { injected } = await runPreStep(preStep, [userMessage('u1', 'hi')], 'D:/proj/a')
    expect(injected).toHaveLength(1)
    const text = injectedText(injected)
    expect(text).toContain('【全局指令】')
    expect(text).toContain('【工作区指令】')
    expect(text.indexOf('全局规则')).toBeLessThan(text.indexOf('本工作区规则'))
  })

  it('命中工作区但该工作区无配置(键缺失/空白)→ 只注入全局', async () => {
    const miss = setup({ settings, registry: { resolved: { id: 'ws-unknown' } } })
    const missText = injectedText((await runPreStep(miss.preStep, [userMessage('u1', 'hi')], 'D:/proj/b')).injected)
    expect(missText).toContain('全局规则')
    expect(missText).not.toContain('【工作区指令】')

    const blank = setup({ settings, registry: { resolved: { id: 'ws-empty' } } })
    const blankText = injectedText((await runPreStep(blank.preStep, [userMessage('u1', 'hi')], 'D:/proj/b')).injected)
    expect(blankText).not.toContain('【工作区指令】')
  })

  it('仅工作区文本(全局为空)→ 注入【工作区指令】', async () => {
    const { preStep } = setup({
      settings: { enabled: true, text: '', workspaces: { 'ws-1': '仅工作区' } },
      registry: { resolved: { id: 'ws-1' } },
    })
    const text = injectedText((await runPreStep(preStep, [userMessage('u1', 'hi')], 'D:/proj/a')).injected)
    expect(text).toContain('【工作区指令】')
    expect(text).toContain('仅工作区')
    expect(text).not.toContain('【全局指令】')
  })

  it('registry 缺失 / 未命中 / 解析抛错 / cwd 缺失 → 只注入全局,不 reject', async () => {
    // 服务缺失
    const noService = setup({ settings })
    expect(injectedText((await runPreStep(noService.preStep, [userMessage('u1', 'hi')], 'D:/x')).injected))
      .toContain('全局规则')
    // 未命中
    const noMatch = setup({ settings, registry: {} })
    expect(injectedText((await runPreStep(noMatch.preStep, [userMessage('u1', 'hi')], 'D:/x')).injected))
      .not.toContain('【工作区指令】')
    // 解析抛错(目录不存在等)
    const throwing = setup({ settings, registry: { throw: true } })
    const thrown = await runPreStep(throwing.preStep, [userMessage('u1', 'hi')], 'D:/gone')
    expect(thrown.injected).toHaveLength(1)
    expect(injectedText(thrown.injected)).toContain('全局规则')
    // cwd 缺失
    const noCwd = setup({ settings, registry: { resolved: { id: 'ws-1' } } })
    expect(injectedText((await runPreStep(noCwd.preStep, [userMessage('u1', 'hi')])).injected))
      .not.toContain('【工作区指令】')
  })
})
