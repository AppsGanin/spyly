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
  label
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
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
 * Диалог на нативном <dialog>: он сам даёт фокус-ловушку, закрытие по Escape
 * и затемнение через ::backdrop — своя реализация была бы хуже.
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
 * Меню действий у элемента списка.
 *
 * Держим действия под одной кнопкой, а не выкладываем рядом: у каждой реплики
 * их четыре, и вынесенные наружу они превратили бы расшифровку в панель
 * инструментов.
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
   * Меню рисуется поверх окна, а не внутри своего места.
   *
   * Кнопка нередко стоит в прокручиваемом списке, и вложенный список пунктов
   * обрезался бы его краем. Поэтому список выносится в конец страницы, а место
   * ему считается по кнопке — и у нижнего края он разворачивается вверх.
   */
  const place = (): void => {
    const button = root.current?.getBoundingClientRect()
    if (!button) return
    const height = list.current?.offsetHeight ?? 0
    const flip = height > 0 && button.bottom + 4 + height > window.innerHeight - 8
    setAt({
      top: flip ? button.top - 4 : button.bottom + 4,
      left: align === 'end' ? button.right : button.left,
      flip
    })
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
    // Список висит на своих координатах, поэтому при прокрутке или изменении
    // размера окна место считается заново. Закрывать его на любую прокрутку
    // нельзя: прокрутиться может и соседняя часть окна, к меню не относящаяся.
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

  // Высота списка известна только после отрисовки: первый проход ставит его по
  // кнопке, второй — уточняет, хватает ли места снизу.
  useLayoutEffect(() => {
    if (!open || at.flip || !list.current) return
    const height = list.current.offsetHeight
    const button = root.current?.getBoundingClientRect()
    if (!button || button.bottom + 4 + height <= window.innerHeight - 8) return
    setAt({ top: button.top - 4, left: at.left, flip: true })
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

/** Полоска уровня из столбиков — читается лучше, чем одна линия. */
export function LevelMeter({ level, bars = 12 }: { level: number; bars?: number }) {
  // Логарифмическая шкала: линейная почти всё время выглядит как ноль.
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
