import { t } from '@spyly/core'
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from '../ui'

/**
 * The interface error boundary.
 *
 * Without it any rendering error leaves the user in front of an empty black
 * window, while the recording carries on in the main process and they never
 * find out. Here at least what happened is visible, and there is a way back.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Goes into the main process log, or there would be no trace at all.
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
