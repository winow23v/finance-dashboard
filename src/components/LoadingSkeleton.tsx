export function LoadingSkeleton({ message, shape = 'rows', contained = false }: {
  message: string; shape?: 'rows' | 'chart' | 'value' | 'detail'; contained?: boolean
}) {
  return <>
    <span className="sr-only" role="status">{message}</span>
    <span aria-hidden="true" className={shape === 'chart' && !contained ? 'chart-body' : undefined}>
      <span className={'loading-skeleton skeleton-' + shape}><i /><i /><i /></span>
    </span>
  </>
}
