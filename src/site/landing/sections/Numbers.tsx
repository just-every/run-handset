import { day } from '../day'
import { Heading, Sentence, Plate, Rec, Screen } from '../parts'

/** 08: Hartwell Auto Service's move. One x-ray desk phone at the lower left, cropped by the left edge, with its tag. */
export function Numbers() {
  const { hartwell: h } = day
  return <Screen id="numbers" className="s-numbers">
    <div className="screen-copy">
      <Heading id="numbers-title" lines={['Your numbers', 'come with you.']} />
      <Sentence lines={['Hartwell Auto Service kept its', 'numbers, desk phones and call', 'flows when it left RingCentral.']} />
    </div>
    <Plate className="art numbers-art" name="numbers" widths={[334, 668]} width={668} height={445} sizes="(max-width: 1023.98px) 80vw, calc(min(100vw, 1600px) * 0.4347)" />
    <p className="tag numbers-tag">
      <Rec className="tag-line" parts={[h.moved, <>RingCentral&nbsp;→ Handset</>]} />
      <Rec className="tag-line" parts={[`${h.numbers} numbers ported`, `${h.phones} Poly desk phones re‑enrolled`]} />
      <span className="tag-line nw">0 missed test calls</span>
    </p>
  </Screen>
}
