import { t } from '@spyly/core'
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from '../ui'

/**
 * Граница ошибок интерфейса.
 *
 * Без неё любая ошибка при отрисовке оставляет пользователя перед пустым
 * чёрным окном — при этом запись продолжает идти в главном процессе, и человек
 * об этом не узнает. Здесь хотя бы видно, что случилось, и можно вернуться.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Уходит в лог главного процесса — иначе следов не останется вовсе.
    console.error(t('Сбой интерфейса:'), error, info.componentStack)
  }

  override render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="empty" style={{ height: '100%' }}>
        <div className="empty__art" style={{ color: 'var(--ds-red-900)' }}>!</div>
        <div className="col" style={{ gap: 6, alignItems: 'center' }}>
          <div className="empty__title">{t('Что-то сломалось в интерфейсе')}</div>
          <p className="empty__text">
            {t('Запись, если она шла, не прервалась — она ведётся отдельно от окна. Попробуйте вернуться к списку; если не поможет, перезапустите приложение.')}
          </p>
          <p className="empty__text mono" style={{ fontSize: 'var(--text-sm)', color: 'var(--ds-gray-700)' }}>
            {error.message}
          </p>
        </div>
        <Button variant="primary" onClick={() => this.setState({ error: null })}>{t('Вернуться')}</Button>
      </div>
    )
  }
}
