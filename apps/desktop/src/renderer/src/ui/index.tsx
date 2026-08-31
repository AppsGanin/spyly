import { t } from '@spyly/core'
import { createPortal } from 'react-dom'
import {
  forwardRef,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes
} from 'react'

type ButtonVariant = 'default' | 'primary' | 'danger' | 'ghost'
type ButtonSize = 'sm' | 'md' | 'lg'

export function Button({
  variant = 'default',
  size = 'md',
  block,
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  size?: ButtonSize
  block?: boolean
}) {
  const classes = [
    'btn',
    variant !== 'default' && `btn--${variant}`,
    size !== 'md' && `btn--${size}`,
    block && 'btn--block',
    className
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <button type="button" className={classes} {...rest}>
      {children}
    </button>
  )
}

export function IconButton({
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={`btn btn--ghost btn--icon ${className}`} {...rest}>
      {children}
    </button>
  )
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className = '', ...rest }, ref) {
    return <input ref={ref} className={`input ${className}`} {...rest} />
  }
)

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { className = '', ...rest } = props
  return <textarea className={`textarea ${className}`} {...rest} />
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const { className = '', children, ...rest } = props
  return (
    <select className={`select ${className}`} {...rest}>
      {children}
    </select>
  )
}

export function Field({
  label,
  hint,
  children
}: {
  label?: string
  hint?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="field">
      {label && <span className="field__label">{label}</span>}
      {children}
      {hint && <span className="field__hint">{hint}</span>}
    </div>
  )
}

export function Switch({
  checked,
  onChange,
  label,
  disabled = false
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  /** A switch that cannot be on right now, because something it depends on is off. */
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`switch ${checked ? 'switch--on' : ''}`}
      onClick={() => onChange(!checked)}
    />
  )
}

export function Badge({
  tone = 'default',
  children
}: {
  tone?: 'default' | 'blue' | 'green' | 'amber' | 'red' | 'purple' | 'teal' | 'pink'
  children: ReactNode
}) {
  return <span className={`badge ${tone !== 'default' ? `badge--${tone}` : ''}`}>{children}</span>
}

export function Spinner() {
  return <span className="spin" role="status" aria-label={t('загрузка')} />
}

/**
 * A dialog on the native <dialog>: it provides the focus trap, closing on
 * Escape and the dimming through ::backdrop by itself, and our own
 * implementation would be worse.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  actions
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  actions?: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog ref={ref} className="modal" onClose={onClose} onCancel={onClose}>
      <div className="modal__body">
        <h3>{title}</h3>
        {children}
        {actions && <div className="modal__actions">{actions}</div>}
      </div>
    </dialog>
  )
}

/**
 * The action menu on a list item.
 *
 * The actions are kept under one button rather than laid out alongside: every
 * utterance has four of them, and out in the open they would turn the
 * transcript into a toolbar.
 */
export function Menu({
  trigger,
  items,
  align = 'end'
}: {
  trigger: ReactNode
  items: { label: string; onSelect: () => void; danger?: boolean; disabled?: boolean; hint?: string }[]
  align?: 'start' | 'end'
}) {
  const [at, setAt] = useState<{ top: number; left: number; flip: boolean } | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const open = at !== null

  /**
   * The menu is drawn over the window rather than inside its own place.
   *
   * The button often sits in a scrolling list, and a nested list of items would
   * be clipped by its edge. So the list is moved to the end of the page and its
   * place is computed from the button, opening upwards near the bottom edge.
   */
  const measure = (): { top: number; left: number; flip: boolean } | null => {
    const button = root.current?.getBoundingClientRect()
    if (!button) return null
    const height = list.current?.offsetHeight ?? 0
    const width = list.current?.offsetWidth ?? 0
    const flip = height > 0 && button.bottom + 4 + height > window.innerHeight - 8
    // The horizontal edge is computed here rather than left to a transform: a
    // menu is wider than the button that opens it, and next to the right edge of
    // the window it hung off the screen with its items cut in half.
    const wanted = align === 'end' ? button.right - width : button.left
    const left = width > 0 ? Math.max(8, Math.min(wanted, window.innerWidth - width - 8)) : wanted
    return { top: flip ? button.top - 4 : button.bottom + 4, left, flip }
  }

  const place = (): void => {
    const next = measure()
    if (next) setAt(next)
  }

  useEffect(() => {
    if (!open) return
    const away = (event: MouseEvent) => {
      const target = event.target as Node
      if (!root.current?.contains(target) && !list.current?.contains(target)) setAt(null)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAt(null)
    }
    // The list hangs at its own coordinates, so on a scroll or a window resize the
    // place is recomputed. Closing it on any scroll will not do: a neighbouring
    // part of the window, nothing to do with the menu, can scroll as well.
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', escape)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', escape)
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  /**
   * The size of the list is only known once it is in the page.
   *
   * The first pass places it against the button with nothing measured, the
   * second corrects it. That second pass used to look at the height alone and
   * return early whenever there was room below, so a menu wider than its button
   * kept the uncorrected left edge and ran off the side of the window.
   */
  useLayoutEffect(() => {
    if (!open || !list.current) return
    const next = measure()
    if (!next) return
    if (next.top === at.top && next.left === at.left && next.flip === at.flip) return
    setAt(next)
  }, [open, at])

  return (
    <div className="menu" ref={root}>
      <span onClick={() => (open ? setAt(null) : place())}>{trigger}</span>
      {open &&
        createPortal(
          <div
            ref={list}
            className={`menu__list menu__list--${align} ${at.flip ? 'menu__list--up' : ''}`}
            style={{ top: at.top, left: at.left }}
            role="menu"
          >
            {items.map((item) => (
              <button
                key={item.label}
                role="menuitem"
                className={`menu__item ${item.danger ? 'menu__item--danger' : ''}`}
                disabled={item.disabled}
                title={item.hint}
                onClick={() => {
                  setAt(null)
                  item.onSelect()
                }}
              >
                {item.label}
              </button>
            ))}
          </div>,
          document.body
        )}
    </div>
  )
}

export function EmptyState({
  icon,
  title,
  text,
  action
}: {
  icon: ReactNode
  title: string
  text: string
  action?: ReactNode
}) {
  return (
    <div className="empty">
      <div className="empty__art">{icon}</div>
      <div className="col" style={{ gap: 6, alignItems: 'center' }}>
        <div className="empty__title">{title}</div>
        <p className="empty__text">{text}</p>
      </div>
      {action}
    </div>
  )
}

/** A level meter made of bars: it reads better than a single line. */
export function LevelMeter({ level, bars = 12 }: { level: number; bars?: number }) {
  // A logarithmic scale: a linear one looks like zero almost all of the time.
  const normalized = Math.min(1, Math.max(0, Math.log10(1 + level * 60) / Math.log10(61)))
  const lit = Math.round(normalized * bars)
  return (
    <div className="level" aria-hidden="true">
      {Array.from({ length: bars }, (_, i) => {
        const height = 5 + (i / bars) * 13
        const on = i < lit
        const hot = on && i >= bars - 2
        return (
          <span
            key={i}
            className={`level__bar ${on ? 'level__bar--on' : ''} ${hot ? 'level__bar--hot' : ''}`}
            style={{ height }}
          />
        )
      })}
    </div>
  )
}

export function Meter({ level }: { level: number }) {
  const normalized = Math.min(1, Math.max(0, Math.log10(1 + level * 60) / Math.log10(61)))
  return (
    <div className="meter">
      <div
        className={`meter__fill ${level < 0.002 ? 'meter__fill--silent' : ''}`}
        style={{ width: `${normalized * 100}%` }}
      />
    </div>
  )
}
