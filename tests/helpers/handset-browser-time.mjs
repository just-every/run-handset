// HTML normalizes zero seconds away; use the same value a person enters.
// https://html.spec.whatwg.org/multipage/common-microsyntaxes.html#local-dates-and-times
export const localDateTime=value=>new Date(value).toISOString().slice(0,19).replace(/:00$/,'')
