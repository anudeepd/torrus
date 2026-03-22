interface LogoProps {
  size?: 'sm' | 'md' | 'lg'
  showText?: boolean
  className?: string
}

const sizeMap = {
  sm: 'w-6 h-6',
  md: 'w-8 h-8',
  lg: 'w-12 h-12',
}

const textSizeMap = {
  sm: 'text-xs',
  md: 'text-sm',
  lg: 'text-base',
}

export default function Logo({ size = 'md', showText = true, className = '' }: LogoProps) {
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <svg
        viewBox="0 0 128 128"
        xmlns="http://www.w3.org/2000/svg"
        className={`${sizeMap[size]} flex-shrink-0`}
      >
        {/* Rounded square background */}
        <rect x="4" y="4" width="120" height="120" rx="24" fill="#ecfdf5" />

        {/* Torus rings (donut front-view) */}
        <circle cx="64" cy="64" r="54" fill="none" stroke="#16a34a" strokeWidth="3.6" />
        <circle cx="64" cy="64" r="38" fill="none" stroke="#0d9488" strokeWidth="3.2" />
        <circle cx="64" cy="64" r="22" fill="none" stroke="#10b981" strokeWidth="2.8" />

        {/* Prompt chevron ">" inside the torus hole */}
        <polyline fill="none" stroke="#0d9488" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"
          points="52,56 64,64 52,72" />

        {/* Cursor block */}
        <rect x="70" y="58" width="8" height="12" rx="1.5" fill="#10b981" />
      </svg>

      {showText && (
        <span className={`font-semibold text-slate-100 ${textSizeMap[size]} tracking-tight`}>
          Torrus
        </span>
      )}
    </div>
  )
}
