// One Monday, Mon Oct 26, 2026, on nine US businesses' Handset: every figure the homepage prints, in one place, so the
// hero, the screens and the closing read the same records (desk page round 2, page-s2/STRUCTURE.md "Records").
// Times are each business's own zone. People appear only as names.
export const day = {
  date: 'Mon Oct 26',
  businesses: 9,
  calls: { total: '1,284', people: '1,226', receptionist: '58' },
  rivera: { answered: '6:12:04 am CT', luis: '6:12:31', connected: '6:12:44', seconds: 40 },
  brightwater: { calls: 31, answered: 31 },
  mesaRidge: { waiting: 20, at: '9:05 am MT', longest: '4:54', abandoned: 0, number: '303-555-0190', labelled: 'Fri Oct 23', labelledAt: '11:02 am MT', filed: '11:31 am', clean: '8:10 am', networks: 3 },
  closing: { display: ['MON 10/26 6:00 PM', 'AFTER HOURS'], at: '6:00 pm PT' },
  followUps: { done: 21, promised: 23, due: 2, on: 'Fri Oct 30' },
  hartwell: { moved: 'Tue Oct 13', numbers: 4, phones: 18 },
  thanksgiving: { date: 'Thu Nov 26' },
} as const

// The figures add up: people plus the receptionist make the day's calls, the warm transfer lands 40 s after hello,
// and the follow-ups still open are the ones not yet done.
const count = (text: string) => Number(text.replaceAll(',', ''))
if (count(day.calls.people) + count(day.calls.receptionist) !== count(day.calls.total)) throw new Error('The day\'s calls do not add up.')
if (day.followUps.promised - day.followUps.done !== day.followUps.due) throw new Error('The follow-ups do not add up.')
const seconds = (time: string) => { const [h, m, s] = time.split(' ')[0].split(':').map(Number); return h * 3600 + m * 60 + s }
if (seconds(day.rivera.connected) - seconds(day.rivera.answered) !== day.rivera.seconds) throw new Error('The burst-pipe log does not add up.')
