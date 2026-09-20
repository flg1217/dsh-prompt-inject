// 提示词注入插件面板卡片(注册 settings.plugin.item,外观对齐官方 PluginCard)。
// 字段读写走官方 SettingsScope;注入行为:每条输入随行下发,主对话与所有
// 子代理统一(host 侧 pre-step 实现)。
// 文本 = 全局(本卡) + 每工作区附加(工作区管理区,键=workspaceId);
// host 按会话 cwd 经 workspaceRegistry.resolveByPath 匹配后合并为一条注入。
window.__ModuleLoader__.load({
  id: '@flg1217/dsh-prompt-inject',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const react = require('react')
    const P = require('@deepseek-ai/dsh-client-ui-primitives')
    const { Button, Modal, IconChevronDownOutline14 } = P

    // ── 官方 PluginCard CSS 子集(与 ui-settings-plugins 视觉一致) ──
    const CSS = {
      card: '.dshPI_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}',
      cardOpen: '.dshPI_cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}',
      header: '.dshPI_header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}',
      headText: '.dshPI_headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}',
      name: '.dshPI_name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}',
      description: '.dshPI_description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}',
      chevron: '.dshPI_chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}',
      chevronOpen: '.dshPI_chevronOpen{transform:rotate(180deg)}',
      body: '.dshPI_body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}',
      field: '.dshPI_field{flex-direction:column;gap:6px;padding:12px 0;display:flex}.dshPI_field+.dshPI_field{border-top:1px solid var(--dsw-alias-border-l2)}',
      fieldHead: '.dshPI_fieldHead{align-items:center;gap:8px;display:flex}',
      label: '.dshPI_label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}',
      hint: '.dshPI_hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}',
      textarea: '.dshPI_textarea{width:100%;box-sizing:border-box;min-height:96px;resize:vertical;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:8px;padding:8px 10px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.6;font-family:inherit}',
      row: '.dshPI_row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 0}',
      note: '.dshPI_note{color:var(--dsw-alias-label-tertiary);font-size:12px}',
      badge: '.dshPI_badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}',
      wsRow: '.dshPI_wsRow{display:flex;align-items:center;gap:8px;padding:8px 0}.dshPI_wsRow+.dshPI_wsRow{border-top:1px solid var(--dsw-alias-border-l2)}',
      wsText: '.dshPI_wsText{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}',
      wsTitle: '.dshPI_wsTitle{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      wsPath: '.dshPI_wsPath{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      wsOrphan: '.dshPI_wsOrphan{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:1.5}',
      // 弹窗卡片宽度:primitives 的 Modal 卡固定 min(380px,100%)+overflow:hidden,
      // 而编辑弹窗内容(路径/长文本/textarea)需要更宽——用 Modal 的 className
      // 加宽卡片本体(官方支持的入口),绝不靠撑大 body 内容(min-width 会把内容
      // 顶出卡片、被 overflow:hidden 裁掉;2026-09-19 用户截图实证)。
      wideDialog: '.dshPI_wideDialog{width:min(560px,100%)}',
      // 弹窗内路径行:长路径换行显示(卡片级 wsPath 是窄列单行省略,这里不适用)。
      modalPath: '.dshPI_modalPath{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;word-break:break-all}',
      modalBody: '.dshPI_modalBody{display:flex;flex-direction:column;gap:10px;width:100%;min-width:0}',
    }
    const cssText = Object.values(CSS).join('')
    const tagId = '@flg1217/dsh-prompt-inject/plugin-card.css'
    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = '@flg1217/dsh-prompt-inject'
      tag.dataset.pluginCss = tagId
      tag.textContent = cssText
      document.head.appendChild(tag)
    }
    const C = {
      card: 'dshPI_card', cardOpen: 'dshPI_cardOpen', header: 'dshPI_header',
      headText: 'dshPI_headText', name: 'dshPI_name', description: 'dshPI_description',
      chevron: 'dshPI_chevron', chevronOpen: 'dshPI_chevronOpen', body: 'dshPI_body',
      field: 'dshPI_field', fieldHead: 'dshPI_fieldHead', label: 'dshPI_label',
      hint: 'dshPI_hint', textarea: 'dshPI_textarea', row: 'dshPI_row', note: 'dshPI_note',
      badge: 'dshPI_badge', wsRow: 'dshPI_wsRow', wsText: 'dshPI_wsText',
      wsTitle: 'dshPI_wsTitle', wsPath: 'dshPI_wsPath', wsOrphan: 'dshPI_wsOrphan',
      wideDialog: 'dshPI_wideDialog', modalPath: 'dshPI_modalPath', modalBody: 'dshPI_modalBody',
    }

    /** 从 settings 现值取某工作区的注入文本(防御非 string)。 */
    function workspaceValue(scope, workspaceId) {
      try {
        const v = scope.getSnapshot().value
        const raw = v?.workspaces
        const item = raw !== null && typeof raw === 'object' ? raw[workspaceId] : undefined
        return typeof item === 'string' ? item : ''
      } catch {
        return ''
      }
    }

    /**
     * 工作区注入编辑弹窗(设置卡与其它入口共用)。
     * 保存/清除走 mutate 的嵌套 path——绝不整字典覆盖(避免并发丢键)。
     */
    function WorkspaceInjectModal(props) {
      const { open, onClose, scope, workspaceId, workspaceTitle, workspacePath } = props
      const [draft, setDraft] = react.useState('')
      const [note, setNote] = react.useState('')

      react.useEffect(() => {
        if (!open) return undefined
        setDraft(workspaceValue(scope, workspaceId))
        setNote('')
        return scope.subscribe(() => { /* 外部变化不覆盖草稿 */ })
      }, [open, workspaceId, scope])

      const save = react.useCallback(async () => {
        const value = draft.trim()
        try {
          if (value.length === 0) {
            await scope.mutate([{ op: 'unset', path: ['workspaces', workspaceId] }])
          } else {
            await scope.mutate([{ op: 'set', path: ['workspaces', workspaceId], value }])
          }
          setNote('已保存')
          setTimeout(() => setNote(''), 1500)
        } catch {
          setNote('保存失败')
        }
      }, [scope, workspaceId, draft])

      const clear = react.useCallback(async () => {
        try {
          await scope.mutate([{ op: 'unset', path: ['workspaces', workspaceId] }])
          setDraft('')
          setNote('已清除')
          setTimeout(() => setNote(''), 1500)
        } catch {
          setNote('清除失败')
        }
      }, [scope, workspaceId])

      return react.createElement(Modal, {
        open,
        onClose,
        title: `工作区注入:${workspaceTitle ?? ''}`,
        closeLabel: '关闭',
        className: C.wideDialog,
        footer: react.createElement(react.Fragment, null,
          react.createElement(Button, { size: 'md', onClick: save }, '保存'),
          react.createElement(Button, { size: 'md', variant: 'ghost', onClick: clear }, '清除'),
          react.createElement('span', { className: C.note }, note),
        ),
      },
        react.createElement('div', { className: C.modalBody },
          workspacePath !== undefined && workspacePath !== ''
            ? react.createElement('div', { className: C.modalPath }, workspacePath)
            : null,
          react.createElement('textarea', {
            className: C.textarea,
            value: draft,
            placeholder: '该工作区附加指令(留空并保存即清除)。',
            onChange: (e) => setDraft(e.target.value),
          }),
          react.createElement('p', { className: C.hint },
            '只对属于该工作区的会话生效(含其子代理);全局文本照常生效,两者合并为一条注入。'),
        ),
      )
    }

    /** 提示词注入设置卡:总开关 + 全局文本 + 每工作区注入管理。 */
    function PromptInjectCard(props) {
      const [open, setOpen] = react.useState(false)
      const scope = props.scope
      const [enabled, setEnabled] = react.useState(true)
      const [textDraft, setTextDraft] = react.useState('')
      const [savedText, setSavedText] = react.useState('')
      const [note, setNote] = react.useState('')
      // 工作区列表:root 槽 standard hook(ui-workspace provideRoot 交付);
      // 缺席时退化为空列表(不影响其余字段)。
      const wsItems = (typeof props.useWorkspaces === 'function'
        ? props.useWorkspaces(s => s.items)
        : undefined) ?? []
      // 弹窗编辑目标(null=关闭)。
      const [editing, setEditing] = react.useState(null)
      // settings 里已配置的工作区键(用于孤儿检测与徽标)。
      const [wsKeys, setWsKeys] = react.useState([])

      const load = react.useCallback(() => {
        try {
          const v = scope.getSnapshot().value
          if (v?.enabled !== undefined) setEnabled(Boolean(v.enabled))
          const t = typeof v?.text === 'string' ? v.text : ''
          setTextDraft(t)
          setSavedText(t)
          const raw = v?.workspaces
          setWsKeys(raw !== null && typeof raw === 'object' ? Object.keys(raw) : [])
        } catch { /* 镜像未就绪 */ }
      }, [scope])
      react.useEffect(() => {
        load()
        return scope.subscribe(load)
      }, [load])

      const toggle = react.useCallback(async () => {
        const next = !enabled
        setEnabled(next)
        try {
          await scope.set('enabled', next)
        } catch {
          setEnabled(!next)
        }
      }, [scope, enabled])

      const dirty = textDraft.trim() !== savedText.trim()
      const save = react.useCallback(async () => {
        const value = textDraft.trim()
        try {
          if (value.length === 0) await scope.unset('text')
          else await scope.set('text', value)
          setSavedText(value)
          setNote('已保存')
          setTimeout(() => setNote(''), 1500)
        } catch {
          setNote('保存失败')
        }
      }, [scope, textDraft])

      const clearWorkspace = react.useCallback(async (workspaceId) => {
        try {
          await scope.mutate([{ op: 'unset', path: ['workspaces', workspaceId] }])
        } catch { /* 忽略:subscribe 会回读真实状态 */ }
      }, [scope])

      const wsIds = new Set(wsItems.map(item => item.workspaceId))
      const orphans = wsKeys.filter(key => !wsIds.has(key))
      const clearAllOrphans = react.useCallback(async () => {
        if (orphans.length === 0) return
        try {
          await scope.mutate(orphans.map(id => ({ op: 'unset', path: ['workspaces', id] })))
        } catch { /* 同上 */ }
      }, [scope, orphans.join('\n')])

      return react.createElement('li', { className: `${C.card} ${open ? C.cardOpen : ''}` },
        react.createElement('button', {
          type: 'button', className: C.header, 'aria-expanded': open,
          'aria-label': `${open ? '收起' : '展开'}: 提示词注入`,
          onClick: () => setOpen(!open),
        },
          react.createElement('span', { className: C.headText },
            react.createElement('span', { className: C.name }, '提示词注入'),
            react.createElement('span', { className: C.description },
              '全局 + 每工作区附加指令,随每条输入下发(主对话与所有子代理统一)'),
          ),
          react.createElement(IconChevronDownOutline14, { className: `${C.chevron} ${open ? C.chevronOpen : ''}` }),
        ),
        open && react.createElement('div', { className: C.body },
          // 总开关
          react.createElement('div', { className: C.field },
            react.createElement('div', { className: C.fieldHead },
              react.createElement('span', { className: C.label }, '启用注入'),
              react.createElement('span', { className: C.badge }, enabled ? '已启用' : '已关闭'),
              react.createElement(Button, { size: 'md', onClick: toggle }, enabled ? '关闭' : '启用'),
            ),
            react.createElement('p', { className: C.hint },
              '关闭后不再向任何会话追加注入(文本保留)。'),
          ),
          // 全局注入文本
          react.createElement('div', { className: C.field },
            react.createElement('div', { className: C.fieldHead },
              react.createElement('span', { className: C.label }, '全局注入文本'),
              react.createElement('span', { className: C.note }, dirty ? '未保存的修改' : ''),
            ),
            react.createElement('textarea', {
              className: C.textarea,
              value: textDraft,
              placeholder: '例如:所有回复末尾附上简短的中文小结。',
              onChange: (e) => setTextDraft(e.target.value),
            }),
            react.createElement('div', { className: C.row },
              react.createElement(Button, { size: 'md', onClick: save, disabled: !dirty }, '保存'),
              react.createElement('span', { className: C.note }, note),
            ),
            react.createElement('p', { className: C.hint },
              '对所有会话生效;与工作区文本合并为一条注入(全局在前、工作区在后,各带小标题)。'),
          ),
          // 工作区注入管理
          react.createElement('div', { className: C.field },
            react.createElement('div', { className: C.fieldHead },
              react.createElement('span', { className: C.label }, '工作区注入'),
              react.createElement('span', { className: C.badge }, `${wsItems.length} 个工作区`),
            ),
            wsItems.length === 0
              ? react.createElement('p', { className: C.hint }, '暂无工作区(工作区列表为空或本客户端未交付列表)。')
              : wsItems.map(item => {
                  const value = workspaceValue(scope, item.workspaceId)
                  return react.createElement('div', { key: item.workspaceId, className: C.wsRow },
                    react.createElement('div', { className: C.wsText },
                      react.createElement('span', { className: C.wsTitle }, item.title),
                      react.createElement('span', { className: C.wsPath }, item.path),
                    ),
                    react.createElement('span', { className: C.badge },
                      value.trim().length > 0 ? `已设置 ${value.trim().length} 字` : '未设置'),
                    react.createElement(Button, {
                      size: 'sm', variant: 'ghost',
                      onClick: () => setEditing(item),
                    }, '编辑'),
                    react.createElement(Button, {
                      size: 'sm', variant: 'ghost',
                      onClick: () => { void clearWorkspace(item.workspaceId) },
                    }, '清除'),
                  )
                }),
            orphans.length > 0 && react.createElement('div', { className: C.row },
              react.createElement('span', { className: C.wsOrphan },
                `${orphans.length} 个已失效的工作区条目(工作区已删除)`),
              react.createElement(Button, { size: 'sm', variant: 'ghost', onClick: clearAllOrphans }, '全部清理'),
            ),
            react.createElement('p', { className: C.hint },
              '工作区文本只对属于该工作区的会话生效(含其子代理);host 按会话 cwd 匹配工作区。'),
          ),
        ),
        editing !== null && react.createElement(WorkspaceInjectModal, {
          open: true,
          scope,
          workspaceId: editing.workspaceId,
          workspaceTitle: editing.title,
          workspacePath: editing.path,
          onClose: () => setEditing(null),
        }),
      )
    }

    function apply(ctx) {
      const scope = ctx.settingsScope.bind({ namespace: 'prompt-inject' })
      const sectionInject = () => ({ scope })
      ctx.effect(() => {
        return ctx.slots.inject('settings.plugin.item', () => {
          return ctx.slots.register({
            name: 'settings.plugin.item',
            // id(rc.6 list 槽)与 key(rc.7 keyed 槽)都传,兼容两种槽类型。
            id: 'prompt-inject',
            key: 'prompt-inject',
            order: 40,
            label: () => '提示词注入',
            inject: sectionInject,
          }, PromptInjectCard)
        })
      }, 'prompt-inject-client: settings.plugin.item')
    }

    exports.apply = apply
    exports.inject = ['slots', 'settingsScope']
    exports.name = 'prompt-inject-client'
    return module.exports
  },
})
