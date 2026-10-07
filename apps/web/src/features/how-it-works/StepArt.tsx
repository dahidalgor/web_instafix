export function StepArt({ index }: { index: number }) {
  return (
    <svg
      viewBox="0 0 240 180"
      fill="none"
      stroke="currentColor"
      strokeWidth="4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {index === 0 && (
        <>
          <rect x="35" y="30" width="170" height="112" rx="15" />
          <path d="M85 160h70M120 142v18M55 55h55M55 75h35" />
          <circle cx="159" cy="97" r="27" />
          <path d="m147 97 9 9 16-20" />
        </>
      )}
      {index === 1 && (
        <>
          <rect x="48" y="30" width="144" height="130" rx="15" />
          <path d="M48 66h144M83 18v27M157 18v27M75 92h12M114 92h12M153 92h12M75 124h12" />
          <rect x="107" y="111" width="28" height="28" rx="7" />
        </>
      )}
      {index === 2 && (
        <>
          <path d="M142 141H65l-24 19V51a17 17 0 0 1 17-17h94a17 17 0 0 1 17 17v16M66 68h53M66 89h34" />
          <path d="M202 104c0 23-32 53-32 53s-32-30-32-53a32 32 0 0 1 64 0Z" />
          <circle cx="170" cy="103" r="10" />
        </>
      )}
      {index === 3 && (
        <g className="moto-drawing">
          <circle cx="58" cy="135" r="26" />
          <circle cx="186" cy="135" r="26" />
          <path d="m58 135 30-48h44l-18 48H58m56 0h38l-18-65h24l28 65M83 82h38M139 70l-8-15M28 74h29M20 94h25" />
          <path d="M104 88h25l15 15h-44Z" fill="currentColor" />
          <rect x="105" y="109" width="27" height="23" rx="5" />
          <path d="M90 145h61M165 110q21-15 39 3M72 83h30" strokeWidth="7" />
          <path d="M153 76h13v12h-10" />
          <circle cx="115" cy="29" r="14" />
          <path d="M115 19h14M105 47l-22 24 26 15 9 32M109 48l22 15h20" />
        </g>
      )}
    </svg>
  );
}
