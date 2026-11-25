import { useId, useState, type ReactNode } from 'react'

export function SegmentTabs({ label, items }: {
  label: string; items: { label: string; content: ReactNode }[]
}) {
  const id = useId()
  const [selected, setSelected] = useState(0)
  const active = Math.min(selected, items.length - 1)
  return <div className="segment-tabs">
    <div className="periods" role="tablist" aria-label={label} onKeyDown={event => {
      const next = { ArrowLeft: (active + items.length - 1) % items.length,
        ArrowRight: (active + 1) % items.length, Home: 0, End: items.length - 1 }[event.key]
      if (next === undefined) return
      event.preventDefault()
      setSelected(next)
      document.getElementById(id + '-tab-' + next)?.focus()
    }}>
      {items.map((item, index) => <button key={item.label} type="button" role="tab" id={id + '-tab-' + index}
        aria-selected={index === active} aria-controls={id + '-panel-' + index} tabIndex={index === active ? 0 : -1}
        onClick={() => setSelected(index)}>{item.label}</button>)}
    </div>
    {items.map((item, index) => <div key={item.label} role="tabpanel" id={id + '-panel-' + index}
      aria-labelledby={id + '-tab-' + index} hidden={index !== active} tabIndex={0}>{item.content}</div>)}
  </div>
}
