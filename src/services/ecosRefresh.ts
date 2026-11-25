type EcosIndicatorResult = {
  status: 'published' | 'unavailable'
  code?: string
}

export function ecosRefreshFailed(result: {
  data: readonly EcosIndicatorResult[] | null
  refreshFailed?: boolean
}) {
  // ECOS uses a code-less unavailable row when there is no published observation.
  return result.refreshFailed === true || result.data === null
    || result.data.some(row => row.status === 'unavailable' && !!row.code)
}
