import { day } from '../day'
import { Heading, Sentence, Plate, Rec, Screen } from '../parts'

/** 02: Rivera Plumbing before opening. The receiver at the lower left, its cord level across the lower third to a 4P4C
 * plug; one hairline drops from the log to the cord. On phones the receiver stands upright and the log is ticked onto
 * the cord. */
export function Burst() {
  const { date, rivera } = day
  return <Screen id="burst" className="s-burst">
    <div className="screen-copy">
      <Heading id="burst-title" lines={['The burst pipe', 'goes to Luis.']} />
      <Sentence lines={['Before Rivera Plumbing', 'opened, the AI receptionist', 'answered and warm\u2011transferred', 'the caller to the on\u2011call plumber.']} />
    </div>
    <Plate className="art burst-art" name="burst" widths={[720, 1080, 1440]} width={1440} height={245} sizes="(max-width: 1023.98px) 1px, calc(min(100vw, 1600px) * 0.9375)"
      phone={{ name: 'burst-phone', widths: [95, 190], media: '(max-width: 1023.98px)', sizes: 'clamp(74px, 19vw, 120px)' }} />
    <span className="burst-wire" aria-hidden="true" />
    <ol className="log burst-log">
      <li><Rec className="when" parts={[date, `${rivera.answered}`]} /><span className="sep">{' · '}</span><span className="what">AI receptionist answers</span></li>
      <li><span className="when nw">{rivera.luis}</span><span className="sep">{' · '}</span><span className="what">Luis answers, hears the brief</span></li>
      <li><span className="when nw">{rivera.connected}</span><span className="sep">{' · '}</span><span className="what">caller connected, {rivera.seconds}&nbsp;s after hello</span></li>
    </ol>
  </Screen>
}
