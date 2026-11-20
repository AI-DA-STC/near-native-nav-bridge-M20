import { Button } from '@/shared/ui/Button'
import nearLab from './near-lab.png'
import stEngineering from './st-engineering.png'
import './LandingPage.css'

export interface LandingPageProps {
  /** Into the console: the step the operator is at */
  onLaunch: () => void
}

/** What opens first: the hero video in a loop, the console's name and the two labs' logos, and Launch */
export function LandingPage({ onLaunch }: LandingPageProps) {
  // Reduced motion: the video's first frame, still
  const still = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  return (
    <div className="cc-landing">
      <video className="cc-landing__video" src="/Hero_video.mp4" autoPlay={!still} muted loop playsInline preload="auto" aria-hidden="true" tabIndex={-1} />
      <div className="cc-landing__scrim" />
      <main className="cc-landing__content">
        <h1 className="cc-landing__title">Command Center</h1>
        <div className="cc-landing__logos">
          <img className="cc-landing__logo cc-landing__logo--st" src={stEngineering} alt="ST Engineering" />
          <span className="cc-landing__rule" aria-hidden="true" />
          <img className="cc-landing__logo cc-landing__logo--near" src={nearLab} alt="NEAR LAB" />
        </div>
        <Button className="cc-landing__launch" variant="primary" size="lg" iconRight="chevronRight" autoFocus onClick={onLaunch}>
          Launch
        </Button>
      </main>
    </div>
  )
}
