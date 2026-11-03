import type { CSSProperties } from "react";

// HuskySwap's assistant mascot: an original cartoon husky face (not Northeastern's
// logo or the Paws mascot artwork). Gray and white fur, blue eyes, a red bandana.
// With `animated`, it blinks and now and then twitches an ear; both loops stop
// under prefers-reduced-motion (the motion-loop class in globals.css).

export function Husky({ className = "", animated = false, title }: { className?: string; animated?: boolean; title?: string }) {
  const loop = animated ? "motion-loop" : "";
  return (
    <svg viewBox="0 0 100 100" className={`${loop} ${className}`} role={title ? "img" : undefined} aria-hidden={title ? undefined : true}>
      {title && <title>{title}</title>}
      {/* ears: the left one twitches */}
      <g className={animated ? "animate-ear origin-[70%_100%] [transform-box:fill-box]" : ""}>
        <path className="fill-husky-fur-dark" d="M15 47 L21 7 Q23 4 26 7 L47 29 Z" />
        <path className="fill-husky-ear" d="M23 38 L25 15 L39 30 Z" />
      </g>
      <path className="fill-husky-fur-dark" d="M85 47 L79 7 Q77 4 74 7 L53 29 Z" />
      <path className="fill-husky-ear" d="M77 38 L75 15 L61 30 Z" />

      {/* head */}
      <ellipse className="fill-husky-fur" cx="50" cy="57" rx="35" ry="31" />
      {/* dark cap with a widow's peak */}
      <path className="fill-husky-fur-dark" d="M22 44 Q30 27 50 26 Q70 27 78 44 Q66 36 56 40 L50 50 L44 40 Q34 36 22 44 Z" />
      {/* white mask: muzzle, cheeks and eyebrow spots */}
      <path
        className="fill-husky-white"
        d="M50 44 C44 44 40 49 37 54 C27 54 19 62 22 72 C26 84 39 89 50 89 C61 89 74 84 78 72 C81 62 73 54 63 54 C60 49 56 44 50 44 Z"
      />
      <ellipse className="fill-husky-white" cx="36" cy="44" rx="5" ry="3.4" />
      <ellipse className="fill-husky-white" cx="64" cy="44" rx="5" ry="3.4" />

      {/* eyes: blue, with a glint; they blink together */}
      <g className={animated ? "animate-blink origin-center [transform-box:fill-box]" : ""}>
        <circle className="fill-husky-eye" cx="38.5" cy="56" r="6" />
        <circle className="fill-husky-nose" cx="39" cy="56.5" r="2.9" />
        <circle className="fill-husky-white" cx="40.3" cy="54.6" r="1.3" />
        <circle className="fill-husky-eye" cx="61.5" cy="56" r="6" />
        <circle className="fill-husky-nose" cx="61" cy="56.5" r="2.9" />
        <circle className="fill-husky-white" cx="62.3" cy="54.6" r="1.3" />
      </g>

      {/* nose and smile */}
      <path className="fill-husky-nose" d="M43.5 65 Q50 61.5 56.5 65 Q54 71.5 50 71.5 Q46 71.5 43.5 65 Z" />
      <ellipse className="fill-husky-white" cx="48" cy="64.6" rx="1.8" ry="0.9" opacity="0.7" />
      <path className="fill-none stroke-husky-nose" strokeWidth="1.8" strokeLinecap="round" d="M50 71.5 V74.5 M50 74.5 Q46 78.5 41.5 75.5 M50 74.5 Q54 78.5 58.5 75.5" />
      <path className="fill-husky-tongue" d="M47 77 Q50 82.5 53 77 Q50 78.2 47 77 Z" />

      {/* Northeastern-red bandana with a knot */}
      <path className="fill-accent" d="M20 83 Q50 98 80 83 L76 91.5 Q50 105 24 91.5 Z" />
      <path className="fill-accent-press" d="M43.5 93 L50 100 L56.5 93 Q50 95 43.5 93 Z" />
    </svg>
  );
}

// One paw print (pad and four toes), for the typing indicator
function Paw({ className = "", style }: { className?: string; style?: CSSProperties }) {
  return (
    <svg viewBox="0 0 24 24" className={className} style={style} aria-hidden>
      <ellipse cx="12" cy="16" rx="5.2" ry="4.4" />
      <ellipse cx="5.6" cy="10.4" rx="2.1" ry="2.7" />
      <ellipse cx="9.6" cy="6.6" rx="2.1" ry="2.8" />
      <ellipse cx="14.4" cy="6.6" rx="2.1" ry="2.8" />
      <ellipse cx="18.4" cy="10.4" rx="2.1" ry="2.7" />
    </svg>
  );
}

// Three paw prints stepping in turn: "the husky is typing"
export function PawTyping({ label = "Thinking" }: { label?: string }) {
  return (
    <span className="motion-loop inline-flex items-center gap-1.5 text-muted" role="status" aria-label={label}>
      {[0, 1, 2].map((i) => (
        <Paw
          key={i}
          className="size-4 animate-paw fill-current"
          style={{ animationDelay: `${i * 0.2}s`, ["--paw-tilt" as string]: `${i % 2 ? 12 : -12}deg` }}
        />
      ))}
    </span>
  );
}
