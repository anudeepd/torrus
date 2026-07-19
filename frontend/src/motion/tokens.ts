export const motionDuration = {
  instant: 0.1,
  micro: 0.18,
  surface: 0.28,
  spatial: 0.38,
} as const

export const motionEase = {
  move: [0.16, 1, 0.3, 1] as const,
  exit: [0.4, 0, 1, 1] as const,
} as const

export const motionDistance = { subtle: 6, surface: 14, spatial: 24 } as const
export const motionScale = { menu: 0.96, dialog: 0.97, press: 0.96 } as const

export const surfaceSpring = { type: 'spring', stiffness: 420, damping: 30, mass: 0.72 } as const
export const spatialSpring = { type: 'spring', stiffness: 340, damping: 27, mass: 0.82 } as const
export const exitTransition = { duration: motionDuration.micro, ease: motionEase.exit } as const
export const surfaceTransition = { duration: motionDuration.surface, ease: motionEase.move } as const
export const spatialTransition = { duration: motionDuration.spatial, ease: motionEase.move } as const
export const progressTransition = { duration: motionDuration.instant, ease: 'linear' } as const
export const completedTransferRetentionMs = 5_000

export const fade = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
} as const

export const surface = {
  initial: { opacity: 0, y: motionDistance.surface, scale: motionScale.dialog },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: motionDistance.subtle, scale: motionScale.dialog },
} as const

export const anchoredSurface = {
  initial: { opacity: 0, y: -motionDistance.subtle, scale: motionScale.menu },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: -motionDistance.subtle, scale: motionScale.menu },
} as const
