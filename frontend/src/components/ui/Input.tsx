import { type InputHTMLAttributes, forwardRef, useId, useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import clsx from 'clsx'

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
}

const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, className, id, type, ...props }, ref) => {
    const generatedId = useId()
    const inputId = id ?? generatedId
    const isPassword = type === 'password'
    const [passwordVisible, setPasswordVisible] = useState(false)

    return (
      <div className="flex flex-col gap-1">
        {label && (
          <label htmlFor={inputId} className="text-xs text-slate-400 font-medium">
            {label}
          </label>
        )}
        <div className="relative">
          <input
            ref={ref}
            id={inputId}
            type={isPassword && passwordVisible ? 'text' : type}
            className={clsx(
              'w-full bg-surface-900 border border-surface-700 rounded-md px-3 py-2 text-sm font-mono text-slate-200 placeholder-slate-500',
              'focus:outline-none focus:border-brand-500 transition-colors',
              { 'border-red-500': !!error, 'pr-10': isPassword, 'torrus-password-input': isPassword },
              className
            )}
            {...props}
          />
          {isPassword && (
            <button
              type="button"
              aria-label={passwordVisible ? 'Hide password' : 'Show password'}
              aria-controls={inputId}
              aria-pressed={passwordVisible}
              className="absolute inset-y-0 right-1 my-auto inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-surface-800 hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              onClick={event => {
                setPasswordVisible(visible => !visible)
                event.currentTarget.parentElement?.querySelector<HTMLInputElement>('input')?.focus()
              }}
            >
              {passwordVisible
                ? <EyeOff aria-hidden="true" className="h-4 w-4" />
                : <Eye aria-hidden="true" className="h-4 w-4" />}
            </button>
          )}
        </div>
        {error && <p className="text-xs text-red-400">{error}</p>}
      </div>
    )
  }
)

Input.displayName = 'Input'
export default Input
