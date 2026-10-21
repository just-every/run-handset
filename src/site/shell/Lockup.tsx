import { links } from './links'

/** The mark and the Handset wordmark. On the black site the tile wears its thin grey keyline, so it does not sink into the ground. */
export const Lockup = ({ size }: { size: number }) =>
  <a className="lockup" href={links.home}><img src="/brand/mark-keyline.svg" alt="" width={size} height={size} /><span>Handset</span></a>
