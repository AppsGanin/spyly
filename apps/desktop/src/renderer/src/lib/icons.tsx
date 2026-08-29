import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

/** The icons are drawn here: the set needed is small, and an extra dependency is expensive. */
function Icon({ children, size = 16, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  )
}

export const IconSearch = (p: IconProps) => (
  <Icon {...p}><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></Icon>
)
export const IconMic = (p: IconProps) => (
  <Icon {...p}><rect x="5.75" y="1.75" width="4.5" height="7.5" rx="2.25" /><path d="M3.25 7.5a4.75 4.75 0 0 0 9.5 0M8 12.25V14.5" /></Icon>
)
export const IconSpeaker = (p: IconProps) => (
  <Icon {...p}><path d="M2 6v4h2.5L8 12.5v-9L4.5 6H2z" /><path d="M10.5 6.25a2.5 2.5 0 0 1 0 3.5M12.5 4.5a5 5 0 0 1 0 7" /></Icon>
)
export const IconRecord = (p: IconProps) => (
  <Icon {...p}><circle cx="8" cy="8" r="5" fill="currentColor" stroke="none" /></Icon>
)
export const IconStop = (p: IconProps) => (
  <Icon {...p}><rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" stroke="none" /></Icon>
)
export const IconPause = (p: IconProps) => (
  <Icon {...p}><rect x="4.5" y="3.5" width="2.5" height="9" rx="1" fill="currentColor" stroke="none" /><rect x="9" y="3.5" width="2.5" height="9" rx="1" fill="currentColor" stroke="none" /></Icon>
)
export const IconPlay = (p: IconProps) => (
  <Icon {...p}><path d="M5 3.5l7 4.5-7 4.5v-9z" fill="currentColor" stroke="none" /></Icon>
)
export const IconSettings = (p: IconProps) => (
  <Icon {...p}><circle cx="8" cy="8" r="2.25" /><path d="M8 1.5v1.75M8 12.75v1.75M14.5 8h-1.75M3.25 8H1.5M12.6 3.4l-1.25 1.25M4.65 11.35L3.4 12.6M12.6 12.6l-1.25-1.25M4.65 4.65L3.4 3.4" /></Icon>
)
export const IconCheck = (p: IconProps) => (
  <Icon {...p}><path d="M3 8.5l3.5 3.5L13 4.5" /></Icon>
)
export const IconAlert = (p: IconProps) => (
  <Icon {...p}><circle cx="8" cy="8" r="6.25" /><path d="M8 5v3.5M8 10.75v.5" /></Icon>
)
export const IconCopy = (p: IconProps) => (
  <Icon {...p}><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" /></Icon>
)
export const IconFolder = (p: IconProps) => (
  <Icon {...p}><path d="M1.75 4.25a1 1 0 0 1 1-1h3l1.5 1.75h5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9.5a1 1 0 0 1-1-1v-7.75z" /></Icon>
)
export const IconTerminal = (p: IconProps) => (
  <Icon {...p}><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" /><path d="M4.75 6.5L6.75 8l-2 1.5M8.75 9.75h2.5" /></Icon>
)
export const IconTrash = (p: IconProps) => (
  <Icon {...p}><path d="M2.75 4.25h10.5M6.25 4.25v-1.5h3.5v1.5M4.25 4.25l.6 8.25a1 1 0 0 0 1 .95h4.3a1 1 0 0 0 1-.95l.6-8.25" /></Icon>
)
export const IconRefresh = (p: IconProps) => (
  <Icon {...p}><path d="M13.25 8a5.25 5.25 0 1 1-1.6-3.77M13.25 2.25v3h-3" /></Icon>
)
export const IconChevron = (p: IconProps) => (
  <Icon {...p}><path d="M6 3.5L10.5 8L6 12.5" /></Icon>
)
export const IconSparkle = (p: IconProps) => (
  <Icon {...p}><path d="M8 2l1.4 3.6L13 7l-3.6 1.4L8 12l-1.4-3.6L3 7l3.6-1.4L8 2z" /></Icon>
)
/** The voice was recognised from a print, a caption next to the participant's name. */
export const IconVoiceMatch = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 6.5v3M6 3.5v9M9 5.5v5M12 7v2" />
  </Icon>
)
/**
 * Append to a recording.
 *
 * A red recording dot plus an arrow to the right: a dot on its own among the
 * other icons simply reads as "record" rather than as continuing an existing one.
 */
export const IconContinueRecord = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="5" cy="8" r="2.6" fill="currentColor" stroke="none" />
    <path d="M9.5 8h4M11.8 6l2 2-2 2" />
  </Icon>
)
export const IconMore = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="4" cy="8" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="12" cy="8" r="1.1" fill="currentColor" stroke="none" />
  </Icon>
)
export const IconPencil = (p: IconProps) => (
  <Icon {...p}><path d="M11.5 2.5a1.4 1.4 0 0 1 2 2L6 12l-3 1 1-3z" /></Icon>
)
export const IconTag = (p: IconProps) => (
  <Icon {...p}><path d="M2.75 7.5V3.25a.5.5 0 0 1 .5-.5H7.5l5.75 5.75a1 1 0 0 1 0 1.4l-4.1 4.1a1 1 0 0 1-1.4 0L2 8.25" /><circle cx="5.5" cy="5.5" r=".9" fill="currentColor" /></Icon>
)
export const IconCalendar = (p: IconProps) => (
  <Icon {...p}><rect x="2.25" y="3.25" width="11.5" height="10.5" rx="1.5" /><path d="M2.25 6.5h11.5M5.5 1.75v2M10.5 1.75v2" /></Icon>
)
export const IconFlag = (p: IconProps) => (
  <Icon {...p}><path d="M4 14V2.5M4 3h8l-1.6 2.6L12 8.5H4" /></Icon>
)
export const IconClose = (p: IconProps) => (
  <Icon {...p}><path d="M4 4l8 8M12 4l-8 8" /></Icon>
)
export const IconUsers = (p: IconProps) => (
  <Icon {...p}><circle cx="6" cy="5.5" r="2.5" /><path d="M1.75 13.25c0-2.35 1.9-4.25 4.25-4.25s4.25 1.9 4.25 4.25" /><path d="M10.5 3.4a2.5 2.5 0 0 1 0 4.2M11.5 9.4a4.25 4.25 0 0 1 2.75 3.85" /></Icon>
)
