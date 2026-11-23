import { useEffect, useState } from 'react'
import { fetchSiteMap, type SiteMap } from '@/shared/api'

/** The site's SLAM map and the routes of the plan in use, fetched again whenever `version` changes (another plan, the
 * map read, the robots' roles); null until they arrive */
export function useSiteMap(version?: string): SiteMap | null {
  const [site, setSite] = useState<SiteMap | null>(null)
  useEffect(() => {
    let current = true
    fetchSiteMap().then(
      (map) => {
        if (current) setSite(map)
      },
      () => undefined,
    )
    return () => {
      current = false
    }
  }, [version])
  return site
}
