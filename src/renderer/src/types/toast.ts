export default interface Toast {
  level: 'information' | 'success' | 'error'
  title: string
  message: string
  onClick?: () => void
  clickable?: boolean
}
