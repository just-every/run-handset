import { Actions } from '../shell/Actions'
import { day } from './day'
import { Groups, Plate } from './parts'

/** 01: the owner's photogram (hero G) with every string set as type: the headline and the day's line over the plate's
 * black clearing at the lower left, the alternative line and the actions in the black at the upper right. */
export function Hero() {
  const { date, businesses, calls } = day
  return <section className="home-hero" aria-labelledby="hero-title">
    <Plate className="hero-plate" name="hero" widths={[768, 1152, 1536, 2304, 3072]} width={1536} height={1024} sizes="min(100vw, 1920px)" eager
      phone={{ name: 'hero-phone', widths: [390, 780, 976], media: '(max-width: 1023.98px)', sizes: '100vw' }} />
    <div className="hero-head">
      <h1 id="hero-title" className="outline"><span className="line">Handset </span><span className="line">picks up.</span></h1>
      <p className="hero-day"><Groups groups={[[date, `${businesses} businesses`, `${calls.total} calls`], [`${calls.people} by people + ${calls.receptionist} by the receptionist`]]} /></p>
    </div>
    <div className="hero-offer">
      <p className="hero-alt">100% free, open source alternative to <b>RingCentral</b>, <b>Zoom Phone</b> and <b>Dialpad</b></p>
      <Actions />
    </div>
  </section>
}
