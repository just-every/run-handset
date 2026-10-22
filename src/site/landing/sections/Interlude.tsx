import { day } from '../day'
import { Groups, Plate, Screen } from '../parts'

/** 06: the interlude, no heading. One x-ray desk phone from above at macro scale in the upper right quarter, its
 * display set as type, and one tag at the lower left. */
export function Interlude() {
  const { date, closing } = day
  return <Screen id="after-hours" className="s-interlude" label="Mon Oct 26, 6:00 pm PT">
    <div className="desk-phone">
      <Plate className="art interlude-art" name="interlude" widths={[345, 690]} width={690} height={690} sizes="(max-width: 1023.98px) 92vw, calc(min(100vw, 1600px) * 0.449)" />
      <p className="display"><span>{closing.display[0]}</span> <span>{closing.display[1]}</span></p>
    </div>
    <p className="tag interlude-tag"><Groups groups={[[date, closing.at], ['the last of nine front desks closes']]} /></p>
  </Screen>
}
