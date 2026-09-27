import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

/**
 * tailwind-merge does not know the project's z-index scale
 * (`tailwind.config.js` → `zIndex: rail/menu/dialog/confirm/overlay`), so
 * without this it treats `z-dialog` and `z-overlay` as unrelated classes and
 * keeps both, and cannot let a layer override another. Teaching it the scale is
 * what makes "the last class wins" true for the layer tokens too.
 */
const merge = extendTailwindMerge({
  extend: {
    classGroups: {
      z: [{ z: ['rail', 'menu', 'dialog', 'confirm', 'overlay'] }],
    },
  },
})

/**
 * Join class names, letting a later class win over an earlier one that sets the
 * same property. `clsx` alone only concatenates, so `cn('w-full', 'w-80')`
 * would leave both classes in place and let the stylesheet order decide — it
 * would not return `w-80`, and a component's base classes would beat the
 * `className` its consumer passed in. Every class list in the app goes through
 * here so "the last class wins" holds at the call site.
 */
export function cn(...inputs: ClassValue[]): string {
  return merge(clsx(inputs))
}
