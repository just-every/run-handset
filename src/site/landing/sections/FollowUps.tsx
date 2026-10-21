import { day } from '../day'
import { Heading, Sentence, Rec, Screen } from '../parts'

/** 07: the one paper-white band, black ink only. "21" rhymes with 04's "20": the same size and baseline. */
export function FollowUps() {
  const { followUps: f } = day
  return <Screen id="follow-ups" className="s-follow s-number">
    <div className="screen-copy">
      <Heading id="follow-ups-title" lines={['The follow‑ups', 'get done.']} />
      <Sentence lines={['After each call, Handset writes down', 'every promise and chases it until', 'the customer\'s side is done.']} />
    </div>
    <figure className="number-figure">
      <p className="outline numeral" aria-label={`${f.done} of ${f.promised}`}>{f.done}</p>
      <figcaption className="caption">
        <span className="nw">of {f.promised} promised</span> <span className="nw">follow&#8209;ups done</span><br />
        <Rec parts={[f.on, `${f.due} due today`]} />
      </figcaption>
    </figure>
  </Screen>
}
