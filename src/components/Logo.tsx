/** Simple jade diamond/square logomark — inline SVG, no external assets. */
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
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <rect
        x="16"
        y="1.5"
        width="20.5"
        height="20.5"
        rx="4"
        transform="rotate(45 16 1.5)"
        fill="var(--color-jade-600)"
      />
      <rect
        x="16"
        y="8.2"
        width="11"
        height="11"
        rx="2.5"
        transform="rotate(45 16 8.2)"
        fill="var(--color-jade-300)"
      />
    </svg>
  )
}
