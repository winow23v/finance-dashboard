import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useId, useRef, useState, type ReactNode } from 'react'

export function IndexCarousel({ slides, label = '시장지수' }: { label?: string; slides: { label: string; content: ReactNode }[] }) {
  const id = useId()
  const track = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(0)
  function go(index: number) {
    const viewport = track.current
    const slide = viewport?.children[index]
    if (!viewport || !slide) return
    viewport.scrollTo({ left: slide.getBoundingClientRect().left - viewport.getBoundingClientRect().left + viewport.scrollLeft,
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
  }
  return <div className="index-carousel" role="group" aria-roledescription="캐러셀" aria-label={label}>
    <div className="quote-grid market-index-quotes terminal-quotes overview-quotes" id={id} ref={track} tabIndex={0} aria-label={label + ' 카드 목록'}
      onKeyDown={event => {
        if (event.target !== event.currentTarget || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return
        event.preventDefault()
        go(active + (event.key === 'ArrowLeft' ? -1 : 1))
      }}
      onScroll={event => {
        const viewport = event.currentTarget
        const left = viewport.getBoundingClientRect().left
        const distances = Array.from(viewport.children, slide => Math.abs(slide.getBoundingClientRect().left - left))
        setActive(distances.indexOf(Math.min(...distances)))
      }}>
      {slides.map(({ label, content }, index) => <div className="index-slide" key={label} role="group"
        aria-roledescription="슬라이드" aria-label={label + ' (' + (index + 1) + '/' + slides.length + ')'}>{content}</div>)}
    </div>
    <div className="index-carousel-controls">
      <button type="button" className="icon-button" aria-label={label === '시장지수' ? '이전 지수' : label + ' 이전'} aria-controls={id} aria-disabled={active === 0}
        onClick={() => go(active - 1)}><ChevronLeft size={18} /></button>
      <div className="index-carousel-dots">
        {slides.map(({label}, index) => <button type="button" key={label} aria-label={label + ' 카드로 이동'}
          aria-current={index === active ? 'true' : undefined} aria-controls={id} onClick={() => go(index)} />)}
      </div>
      <button type="button" className="icon-button" aria-label={label === '시장지수' ? '다음 지수' : label + ' 다음'} aria-controls={id} aria-disabled={active === slides.length - 1}
        onClick={() => go(active + 1)}><ChevronRight size={18} /></button>
    </div>
  </div>
}
