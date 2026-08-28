import { useStore } from '../lib/store'

export function Toasts() {
  const { toasts, dismissToast } = useStore()
  if (toasts.length === 0) return null
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.kind}`} onClick={() => dismissToast(toast.id)}>
          <span className="toast__mark" />
          <span className="grow">{toast.text}</span>
        </div>
      ))}
    </div>
  )
}
