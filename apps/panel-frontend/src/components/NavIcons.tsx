/**
 * Sidebar icons, traced from the Paper artboard. They are drawn here rather
 * than pulled from an icon set because the set's versions differ in weight and
 * in what each glyph depicts (a globe for hosts, a hourglass for queues), and
 * a nav column is exactly where those small differences are visible: eleven
 * marks sit in one vertical lane and any odd one out reads as a mistake.
 *
 * Everything strokes `currentColor`, so the active item tints the icon cyan
 * through the parent without a second colour prop.
 */

type IconProps = { size?: number };

function Svg({ size = 16, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg"
      style={{ flexShrink: 0 }}
    >
      {children}
    </svg>
  );
}

export function NavHomeIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 4h6v8h-6z" />
      <path d="M4 16h6v4h-6z" />
      <path d="M14 12h6v8h-6z" />
      <path d="M14 4h6v4h-6z" />
    </Svg>
  );
}

export function NavUsersIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="9" cy="7" r="4" />
      <path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      <path d="M21 21v-2a4 4 0 0 0-3-3.85" />
    </Svg>
  );
}

// No squads icon here on purpose: the panel keeps its own (tabler's group of
// people). The artboard's three-nodes-on-a-stem mark reads as a topology, and
// a squad is a set of people, not a graph.

export function NavProfilesIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 4l-8 4l8 4l8-4z" />
      <path d="M4 12l8 4l8-4" />
      <path d="M4 16l8 4l8-4" />
    </Svg>
  );
}

export function NavHostsIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0 -18" />
    </Svg>
  );
}

export function NavNodesIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="3" y="4" width="18" height="7" rx="2" />
      <rect x="3" y="13" width="18" height="7" rx="2" />
      <path d="M7 8h.01" />
      <path d="M7 17h.01" />
    </Svg>
  );
}

export function NavMetadataIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 4a16 16 0 0 1 16 16" />
      <path d="M4 11a9 9 0 0 1 9 9" />
      <circle cx="5" cy="19" r="1" />
    </Svg>
  );
}

export function NavRoutesIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="5" cy="6" r="2.2" />
      <circle cx="19" cy="18" r="2.2" />
      <path d="M5 8.5v4a3 3 0 0 0 3 3h8.8" />
      <path d="M9 6h9" />
    </Svg>
  );
}

export function NavDeliveryIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 4h16v2.2a2 2 0 0 1-.6 1.4L15 12v7l-6-2v-5L4.6 7.6A2 2 0 0 1 4 6.2z" />
    </Svg>
  );
}

export function NavInsightsIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3 3v18h18" />
      <path d="M20 18v3" />
      <path d="M16 16v5" />
      <path d="M12 13v8" />
      <path d="M8 16v5" />
      <path d="M3 11c6 0 5-5 9-5s3 5 9 5" />
    </Svg>
  );
}

export function NavQueuesIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M6 3h12" />
      <path d="M6 21h12" />
      <path d="M6 3c0 6 6 5 6 9s-6 3-6 9" />
      <path d="M18 3c0 6-6 5-6 9s6 3 6 9" />
    </Svg>
  );
}

export function NavSettingsIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 0 0-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 0 0-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 0 0-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 0 0-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 0 0 1.066-2.573c-.94-1.543.826-3.31 2.37-2.37c1 .608 2.296.07 2.572-1.065z" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  );
}

export function NavLogoutIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M14 8V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2v-2" />
      <path d="M9 12h12" />
      <path d="M18 9l3 3l-3 3" />
    </Svg>
  );
}
