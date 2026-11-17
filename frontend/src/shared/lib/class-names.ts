/** Joins the truthy class names: cx('cc-btn', pressed && 'is-pressed') */
export function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ')
}
