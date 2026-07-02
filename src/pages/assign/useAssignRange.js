// ============================================================
// computeRange — from/to + day list for a view (Monday-start weeks)
// ============================================================
import { startOfWeek, endOfWeek, startOfMonth, endOfMonth, eachDayOfInterval, format } from 'date-fns'

/**
 * @param {'day'|'week'|'month'} view
 * @param {Date} anchor
 * @returns {{ from:string, to:string, days: {date:Date, iso:string, dow:number, isSunday:boolean}[] }}
 */
export function computeRange(view, anchor) {
  let start, end
  if (view === 'day') {
    start = anchor; end = anchor
  } else if (view === 'week') {
    start = startOfWeek(anchor, { weekStartsOn: 1 }) // Monday
    end   = endOfWeek(anchor,   { weekStartsOn: 1 }) // Sunday
  } else {
    start = startOfMonth(anchor); end = endOfMonth(anchor)
  }
  const days = eachDayOfInterval({ start, end }).map(d => ({
    date: d,
    iso: format(d, 'yyyy-MM-dd'),
    dow: d.getDay(),
    isSunday: d.getDay() === 0,
  }))
  return { from: format(start, 'yyyy-MM-dd'), to: format(end, 'yyyy-MM-dd'), days }
}
