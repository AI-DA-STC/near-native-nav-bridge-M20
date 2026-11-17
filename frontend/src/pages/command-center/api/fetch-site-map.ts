import { useEffect, useState } from 'react'
import { fetchSiteMap, type SiteMap } from '@/shared/api'

/** The site's grid, zones and recorded routes, fetched once; null until they arrive */
export function useSiteMap(): SiteMap | null {
  const [site, setSite] = useState<SiteMap | null>(null)
  useEffect(() => {
    let current = true
    void fetchSiteMap().then((map) => {
      if (current) setSite(map)
    })
    return () => {
      current = false
    }
  }, [])
  return site
}
