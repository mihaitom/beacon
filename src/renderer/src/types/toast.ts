export default interface Toast {
  level: 'information' | 'success' | 'error'
  title: string
  message: string
  /** Turns the toast into something you can act on: rendered as a real
   * button next to the message, the way UpdateToast.vue does it. Replaces
   * an earlier "the whole toast is clickable" flag — a toast that offers to
   * do something has to *look* like it does, and clicking anywhere on a
   * notification is both undiscoverable and easy to trigger by accident
   * while reaching for its close button. */
  action?: {
    label: string
    onClick: () => void
  }
  /** How long to stay up, in ms. Defaults to DEFAULT_TIMEOUT_MS in
   * toast.vue. Worth raising for a toast that asks for a decision rather
   * than just reporting something - the default is calibrated for "read it
   * and move on", which is not enough time to notice a question, read it,
   * and act on it. */
  timeoutMs?: number
}
