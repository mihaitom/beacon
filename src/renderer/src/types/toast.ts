export default interface Toast {
  level: 'information' | 'success' | 'error'
  title: string
  message: string
  onClick?: () => void
  clickable?: boolean
  /** How long to stay up, in ms. Defaults to DEFAULT_TIMEOUT_MS in
   * toast.vue. Worth raising for a toast that asks for a decision rather
   * than just reporting something - the default is calibrated for "read it
   * and move on", which is not enough time to notice a question, read it,
   * and act on it. */
  timeoutMs?: number
}
