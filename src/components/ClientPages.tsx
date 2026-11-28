import { useId, useRef, useState, type ReactNode } from 'react'

export function ClientPages<T>({ items, label, sizes = [10, 20, 50], pageSize = 10, countLabel = '전체', children }: {
  items: readonly T[]
  label: string
  sizes?: readonly number[]
  pageSize?: number
  countLabel?: string
  children: (visible: readonly T[]) => ReactNode
}) {
  const [size, setSize] = useState(pageSize)
  const [page, setPage] = useState(1)
  const id = useId()
  const status = useRef<HTMLSpanElement>(null)
  const pages = Math.max(1, Math.ceil(items.length / size))
  const active = Math.min(page, pages)
  const first = Math.max(1, Math.min(active - 2, pages - 4))
  const numbers = Array.from({ length: Math.min(pages, 5) }, (_, index) => first + index)
  function move(target: number) {
    setPage(target)
    if (target === 1 || target === pages) status.current?.focus({ preventScroll: true })
  }
  return <>
    <div id={id}>{children(items.slice((active - 1) * size, active * size))}</div>
    <nav className="list-pagination client-pages" aria-label={label}>
      <span ref={status} tabIndex={-1} role="status">{countLabel} {items.length.toLocaleString('ko-KR')}개 · {active}/{pages} 페이지</span>
      {sizes.length > 1 && <label>페이지 크기 <select value={size} onChange={event => { setSize(Number(event.target.value)); setPage(1) }}>
        {sizes.map(value => <option key={value} value={value}>{value}개</option>)}
      </select></label>}
      {pages > 1 && <div className="page-buttons">
        <button className="button" type="button" aria-controls={id} disabled={active === 1} onClick={() => move(active - 1)}>이전</button>
        {numbers.map(number => <button className="button" type="button" aria-controls={id} aria-current={active === number ? 'page' : undefined}
          aria-label={number + ' 페이지'} key={number} onClick={() => setPage(number)}>{number}</button>)}
        <button className="button" type="button" aria-controls={id} disabled={active === pages} onClick={() => move(active + 1)}>다음</button>
      </div>}
    </nav>
  </>
}
