import { SiteFooter } from '../shell/SiteFooter'
import { SiteHeader } from '../shell/SiteHeader'
import { Hero } from './Hero'
import { Burst } from './sections/Burst'
import { Closing } from './sections/Closing'
import { FollowUps } from './sections/FollowUps'
import { Interlude } from './sections/Interlude'
import { NameBack } from './sections/NameBack'
import { Numbers } from './sections/Numbers'
import { PressTwo } from './sections/PressTwo'
import { Surge } from './sections/Surge'
import '../styles/tokens.css'
import '../styles/site.css'
import '../styles/landing.css'
import '../styles/sections/hero.css'
import '../styles/sections/burst.css'
import '../styles/sections/press.css'
import '../styles/sections/numbers-screens.css'
import '../styles/sections/name.css'
import '../styles/sections/interlude.css'
import '../styles/sections/numbers.css'
import '../styles/sections/closing.css'
import '../styles/base-pages.css'

/**
 * run-handset.com's homepage, built from the desk's page round 2 (page-s2/STRUCTURE.md): nine US businesses on Handset
 * through one Monday, Mon Oct 26, in nine calm screens with one point each. The owner's photogram hero; the burst pipe;
 * press 2; the surge; the spam label and its recovery; the interlude at 6:00 pm; the follow-ups (the one paper-white
 * band); the move off RingCentral; Thanksgiving with the footer. The x-ray photogram is the only picture medium, at
 * most one object per screen; every string is HTML over a clean plate.
 */
export function Landing() {
  return <>
    <SiteHeader overArt />
    <main id="main" className="landing">
      <Hero />
      <Burst />
      <PressTwo />
      <Surge />
      <NameBack />
      <Interlude />
      <FollowUps />
      <Numbers />
      <Closing />
    </main>
    <SiteFooter />
  </>
}
