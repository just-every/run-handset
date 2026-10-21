import { day } from '../day'
import { Heading, Sentence, Plate, Rec, Screen } from '../parts'

/** 03: Brightwater Dental's Spanish line. One call-flow node, drawn as the builder draws it, with the x-ray cord
 * dropping from it out of the frame; the heading and sentence right-aligned at the top right. */
export function PressTwo() {
  const { date, brightwater } = day
  return <Screen id="press-two" className="s-press">
    <div className="screen-copy">
      <Heading id="press-two-title" lines={['Press 2', 'reaches Ana.']} />
      <Sentence lines={['Spanish\u2011speaking patients at', 'Brightwater Dental press 2 and', 'ring Ana Ruiz directly.']} />
    </div>
    <div className="node-wrap">
      <div className="node">
        <p className="node-route"><span className="nw">2 · Español&nbsp;→</span> <span className="nw">Ana Ruiz</span></p>
        <p className="node-day"><Rec parts={[date, `${brightwater.calls} calls`, `${brightwater.answered} answered`]} /></p>
      </div>
      <Plate className="art press-cord" name="press-cord" widths={[65, 130]} width={130} height={510} sizes="(max-width: 1023.98px) 96px, calc(min(100vw, 1600px) * 0.0846)" />
    </div>
  </Screen>
}
