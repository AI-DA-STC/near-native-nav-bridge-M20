import { useEffect, useState } from 'react'
import { fetchSiteMap, type SiteMap, type SiteMapKind } from '@/shared/api'

/** The site's SLAM map and the routes of the plan in use, fetched again whenever `version` changes (another plan, the
 * map read, the robots' roles); null until they arrive. `map`: the dogs' map, or the ALOHA's own */
export function useSiteMap(version?: string, map: SiteMapKind = 'dogs'): SiteMap | null {
  const [site, setSite] = useState<SiteMap | null>(null)
  useEffect(() => {
    let current = true
    fetchSiteMap(map).then(
      (map) => {
        if (current) setSite(map)
      },
      () => undefined,
    )
    return () => {
      current = false
    }
  }, [version, map])
  return site
}
