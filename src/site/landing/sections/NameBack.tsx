import { day } from '../day'
import { Heading, Sentence, Rec, Screen } from '../parts'

/** 05: the page's one failure and its recovery. "Spam Likely" is the page's only solid white label; the mint CLEARED
 * stamp closes the case. The legal step stays with the business's own representative. No picture. */
export function NameBack() {
  const { date, mesaRidge: m } = day
  return <Screen id="name-back" className="s-name">
    <div className="screen-copy">
      {/* Non-breaking hyphens: the number never splits across lines. */}
      <Heading id="name-back-title" lines={[m.number.replaceAll('-', '\u2011'), 'gets its', 'name back.']} phoneLines={[m.number.replaceAll('-', '\u2011'), 'gets its', 'name back.']} />
      <Sentence lines={['Handset spotted the Spam Likely label,', 'prepared every filing, and the number', 'was clean by Monday.']} />
    </div>
    <ol className="log name-log">
      <li><Rec className="when" parts={[m.labelled, m.labelledAt]} /><span className="sep">{' · '}</span><span className="what"><span className="label">Spam Likely</span> <span className="nw">on 1 of {m.networks}</span></span></li>
      <li><span className="when nw">{m.filed}</span><span className="sep">{' · '}</span><span className="what">Mesa Ridge's <span className="case-action">Keith Brennan files</span> <span className="case-object">the registration</span></span></li>
      <li><Rec className="when" parts={[date, m.clean]} /><span className="sep">{' · '}</span><span className="what"><span className="nw">clean on all {m.networks}</span> <span className="stamp">Cleared</span></span></li>
    </ol>
  </Screen>
}
