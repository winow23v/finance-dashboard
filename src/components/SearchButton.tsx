import { LoaderCircle } from 'lucide-react'
import { useRef } from 'react'

export function useSearchComposition() {
  const composing = useRef(false)
  return {
    composing,
    inputEvents: {
      onCompositionStart: () => { composing.current = true },
      onCompositionEnd: () => { composing.current = false },
    },
  }
}

export function SearchButton({ pending, disabled }: { pending: boolean; disabled?: boolean }) {
  return <button type="submit" className="button" disabled={disabled}>
    {pending && <LoaderCircle size={16} className="refresh-spin" aria-hidden="true" />} 검색
  </button>
}
