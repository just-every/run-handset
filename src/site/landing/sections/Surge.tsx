import { day } from '../day'
import { Heading, Sentence, Rec, Screen } from '../parts'

/** 04: Mesa Ridge Internet's fiber-cut surge, told in one number. No picture. */
export function Surge() {
  const { date, mesaRidge } = day
  return <Screen id="surge" className="s-surge s-number">
    <div className="screen-copy">
      <Heading id="surge-title" lines={['Twenty callers,', 'each told', 'their place.']} phoneLines={['Twenty callers,', 'each told', 'their place.']} />
      <Sentence lines={['A fiber cut sent Mesa Ridge Internet’s', 'customers to the support line at once,', 'and nobody gave up.']} />
    </div>
    <figure className="number-figure">
      <p className="outline numeral" aria-label={`${mesaRidge.waiting} callers`}>{mesaRidge.waiting}</p>
      <figcaption className="caption">
        <span className="nw">waiting at {mesaRidge.at},</span> <span className="nw">{date}</span><br />
        <Rec parts={[`longest wait ${mesaRidge.longest}`, `${mesaRidge.abandoned} abandoned`]} />
      </figcaption>
    </figure>
  </Screen>
}
