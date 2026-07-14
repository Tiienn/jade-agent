/** Jade cloud logomark with a black-bordered square — inline SVG, no external assets. */
export default function Logo({
  size = 28,
  className = '',
}: {
  size?: number
  className?: string
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      {/* Jade cloud: six lobes on a ring + a center fill, unioned into one shape */}
      <g fill="#0F766E">
        <circle cx="70" cy="50" r="22" />
        <circle cx="60" cy="67.3" r="22" />
        <circle cx="40" cy="67.3" r="22" />
        <circle cx="30" cy="50" r="22" />
        <circle cx="40" cy="32.7" r="22" />
        <circle cx="60" cy="32.7" r="22" />
        <circle cx="50" cy="50" r="30" />
      </g>
      {/* Black-bordered square with a pure-white center (stays white in dark mode) */}
      <rect x="36" y="36" width="28" height="28" rx="2" fill="#000000" />
      <rect x="43" y="43" width="14" height="14" fill="#ffffff" />
    </svg>
  )
}
