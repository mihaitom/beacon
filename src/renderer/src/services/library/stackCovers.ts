/** How many covers a RecordStack is handed to flip through. It only ever
 * loads the five it stands at once, so a longer list costs ids, not
 * downloads - and at a flip every 1.1s, 48 take most of a minute to come
 * round again, where 12 looped noticeably. */
export const STACK_COVERS = 48
