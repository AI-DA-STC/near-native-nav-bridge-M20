import { useMediaQuery } from './use-media-query'

/** Below 1440×900 (1280×720 is the smallest supported window) the screen collapses: compact track, lanes as bars,
 * compact robot cards, History as one bar. Keep in step with the same query in app/styles/global.css. */
export const COMPACT_LAYOUT_QUERY = '(max-width: 1399px), (max-height: 859px)'

export function useCompactLayout(): boolean {
  return useMediaQuery(COMPACT_LAYOUT_QUERY)
}
