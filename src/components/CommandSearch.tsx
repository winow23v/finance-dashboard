import { Search, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

type SearchEntry = { label: string; detail: string; href: string; keywords?: string }
const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

function score(entry: SearchEntry, query: string) {
  if (!query) return 0
  const label = normalize(entry.label)
  const searchable = normalize(entry.label + (entry.keywords ?? ''))
  if (label === query) return 0
  if (label.startsWith(query)) return 1
  if (searchable.includes(query)) return 2
  let position = 0
  for (const character of query) {
    const match = searchable.indexOf(character, position)
    if (match === -1) return Infinity
    position = match + 1
  }
  return 3 + position
}

export function CommandSearch({ entries }: { entries: SearchEntry[] }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const previousFocus = useRef<HTMLElement>(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const normalizedQuery = normalize(query)
  const matches = entries.map(entry => ({ entry, rank: score(entry, normalizedQuery) }))
    .filter(({ rank }) => Number.isFinite(rank)).sort((a, b) => a.rank - b.rank)
  const active = Math.min(selected, matches.length - 1)
  const choose = (href: string) => {
    dialog.current?.close()
    if (location.hash === href) window.scrollTo(0, 0)
    else location.hash = href
  }
  function open() {
    const element = dialog.current
    if (!element || element.open || document.querySelector('dialog:modal')) return
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setQuery('')
    setSelected(0)
    element.showModal()
    input.current?.focus()
  }
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        open()
      }
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [])
  return <>
    <button type="button" className="icon-button command-trigger" aria-label="통합 검색 (⌘K)" aria-haspopup="dialog"
      aria-keyshortcuts="Meta+K Control+K" onClick={open}><Search size={18} aria-hidden="true" /><kbd aria-hidden="true">⌘K</kbd></button>
    <dialog className="panel command-dialog" ref={dialog} aria-label="통합 검색"
      onClose={() => previousFocus.current?.focus({ preventScroll: true })}
      onClick={event => { if (event.target === event.currentTarget) event.currentTarget.close() }}>
      <div className="command-content">
        <div className="command-field">
          <Search size={20} aria-hidden="true" />
          <input ref={input} type="search" role="combobox" aria-label="메뉴, 지수 또는 종목 검색" aria-expanded="true"
            aria-controls="command-results" aria-autocomplete="list" aria-activedescendant={active >= 0 ? 'command-result-' + active : undefined}
            placeholder="메뉴, 지수 또는 종목 검색" value={query} onChange={event => { setQuery(event.target.value); setSelected(0) }}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing) return
              if (event.key === 'Escape') {
                event.preventDefault()
                dialog.current?.close()
                return
              }
              if (active < 0) return
              if (event.key === 'Enter') {
                event.preventDefault()
                choose(matches[active].entry.href)
              }
              if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
              event.preventDefault()
              const next = (active + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length
              setSelected(next)
              document.getElementById('command-result-' + next)?.scrollIntoView({ block: 'nearest' })
            }} />
          <button type="button" className="icon-button" aria-label="검색 닫기" onClick={() => dialog.current?.close()}><X size={18} /></button>
        </div>
        <ul id="command-results" role="listbox" aria-label="검색 결과">
          {matches.map(({ entry }, index) => <li key={entry.href} id={'command-result-' + index} role="option"
            aria-selected={index === active} onMouseDown={event => event.preventDefault()} onClick={() => choose(entry.href)}>
            <strong>{entry.label}</strong><small>{entry.detail}</small>
          </li>)}
        </ul>
        {!matches.length && <p className="state" role="status">검색 결과가 없습니다.</p>}
      </div>
    </dialog>
  </>
}
