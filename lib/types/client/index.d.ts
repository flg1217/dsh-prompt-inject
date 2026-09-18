// 提示词注入插件面板卡片(注册 settings.plugin.item,外观对齐官方 PluginCard)。
// 字段读写走官方 SettingsScope;无自定义探测,纯表单(开关 + 文本)。
// 注入行为:每条输入随行下发,主对话与所有子代理统一(host 侧 pre-step 实现)。
window.__ModuleLoader__.load({
  id: '@flg1217/dsh-prompt-inject',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const react = require('react')
    const P = require('@deepseek-ai/dsh-client-ui-primitives')
    const { Button, IconChevronDownOutline14 } = P

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
      badge: 'dshPI_badge',
    }

    /** 提示词注入设置卡:开关 + 注入文本(保存写回 settings namespace)。 */
    function PromptInjectCard(props) {
      const [open, setOpen] = react.useState(false)
      const scope = props.scope
      const [enabled, setEnabled] = react.useState(true)
      const [textDraft, setTextDraft] = react.useState('')
      const [savedText, setSavedText] = react.useState('')
      const [note, setNote] = react.useState('')

      const load = react.useCallback(() => {
        try {
          const v = scope.getSnapshot().value
          if (v?.enabled !== undefined) setEnabled(Boolean(v.enabled))
          const t = typeof v?.text === 'string' ? v.text : ''
          setTextDraft(t)
          setSavedText(t)
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

      return react.createElement('li', { className: `${C.card} ${open ? C.cardOpen : ''}` },
        react.createElement('button', {
          type: 'button', className: C.header, 'aria-expanded': open,
          'aria-label': `${open ? '收起' : '展开'}: 提示词注入`,
          onClick: () => setOpen(!open),
        },
          react.createElement('span', { className: C.headText },
            react.createElement('span', { className: C.name }, '提示词注入'),
            react.createElement('span', { className: C.description },
              '每条输入随行下发的自定义指令(主对话与所有子代理统一,留空不注入)'),
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
          // 注入文本
          react.createElement('div', { className: C.field },
            react.createElement('div', { className: C.fieldHead },
              react.createElement('span', { className: C.label }, '注入文本'),
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
              '对每条输入生效:真实用户消息、父代理向子代理派发的新任务都会在下一步带上;同一条输入的多步工具循环只带一份。'),
          ),
        ),
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
