import { Actions } from '../../shell/Actions'
import { day } from '../day'
import { Groups, Heading, Plate, Screen } from '../parts'

/** 09: the closing, ordered and still where the hero is scattered: nine small x-ray receivers in a strict 3 x 3 plate. */
export function Closing() {
  const { thanksgiving, businesses } = day
  return <Screen id="thanksgiving" className="s-closing">
    <div className="screen-copy">
      <Heading id="thanksgiving-title" lines={['Handset', 'picks up on', 'Thanksgiving.']} />
      <p className="statement">100% free and open source.</p>
      <Actions demo={false} />
    </div>
    <figure className="specimen">
      <Plate className="art closing-art" name="closing" widths={[273, 546]} width={546} height={542} sizes="(max-width: 1023.98px) 84vw, calc(min(100vw, 1600px) * 0.2868)" />
      <figcaption className="tag"><Groups groups={[[thanksgiving.date, `${businesses} offices closed`], ['every call picked up']]} /></figcaption>
    </figure>
  </Screen>
}
