import type { SVGProps } from "react";

/**
 * The icon set.
 *
 * ── Why these are hand-written rather than pulled from a library ───────
 *
 * Two reasons, and both of them matter for this codebase:
 *
 *   1. **Bundle size.** A full icon library is tens of kilobytes of
 *      JavaScript for the dozen icons a storefront actually uses. These
 *      are tree-shakeable React components with no runtime dependency.
 *
 *   2. **No `node_modules` dependency in the client bundle.** Every icon
 *      is an inline SVG, so the components render identically on the
 *      server and the client — no hydration mismatch from a library that
 *      resolves its icons differently on each side.
 *
 * Every icon follows the same conventions:
 *
 *   • 24×24 viewBox, `currentColor` stroke, 1.75 stroke width.
 *   • `aria-hidden` by default — an icon is decorative unless it is the
 *     only content of a control, and in that case the *label* carries the
 *     accessible name.
 *   • `shrink-0` so an icon never squashes inside a flex row.
 */

/**
 * The props every icon accepts.
 */
export type IconProps = SVGProps<SVGSVGElement>;

/**
 * The shared attributes for a decorative icon.
 */
function iconProps(props: IconProps): IconProps {
  return {
    width: 20,
    height: 20,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
    focusable: false,
    ...props,
    className: ["shrink-0", props.className].filter(Boolean).join(" "),
  };
}

export function SearchIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

export function CartIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M3 4h2l2.4 11.4a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 2-1.6L21 8H6" />
      <circle cx="10" cy="20" r="1.4" />
      <circle cx="18" cy="20" r="1.4" />
    </svg>
  );
}

/**
 * The shopping bag.
 *
 * A bag rather than a basket or a trolley. The bag is the icon the
 * European beauty trade actually uses — the "add to bag" control on a
 * skincare boutique is a shopping bag — and a bag silhouette reads
 * unambiguously as *purchasing*, where a plus sign alone reads as
 * *more*.
 */
export function ShoppingBagIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M5.5 8h13l-1 11.5a1.5 1.5 0 0 1-1.5 1.4H8a1.5 1.5 0 0 1-1.5-1.4Z" />
      <path d="M9 10.5V6.8a3 3 0 0 1 6 0v3.7" />
    </svg>
  );
}

export function UserIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
    </svg>
  );
}

export function HeartIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M12 20.5S4 15.8 4 10a4.2 4.2 0 0 1 8-1.8A4.2 4.2 0 0 1 20 10c0 5.8-8 10.5-8 10.5Z" />
    </svg>
  );
}

export function StarIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.7l5.9-.9L12 3.5Z" />
    </svg>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function ChevronLeftIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="m15 6-6 6 6 6" />
    </svg>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function MinusIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M5 12h14" />
    </svg>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

export function FilterIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M4 6h16M7 12h10M10 18h4" />
    </svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="m5 12.5 4.5 4.5L19 7" />
    </svg>
  );
}

export function WalletIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M3 8.5A2.5 2.5 0 0 1 5.5 6H18a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V8.5Z" />
      <path d="M3 9h13.5a1.5 1.5 0 0 1 0 3H16" />
      <path d="M6.5 6 16 3.5" />
    </svg>
  );
}

export function CreditCardIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
      <path d="M2.5 10h19" />
      <path d="M6.5 14.5h3" />
    </svg>
  );
}

export function MobileIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <rect x="6.5" y="2.5" width="11" height="19" rx="2.5" />
      <path d="M10.5 18.5h3" />
      <path d="M9 7.5h6M9 10.5h6M9 13.5h3" />
    </svg>
  );
}

export function TrashIcon(props: IconProps) {  return (
    <svg {...iconProps(props)}>
      <path d="M4 7h16M10 7V5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

export function ShieldIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M12 3l7 3v6c0 4.2-2.9 7.8-7 9-4.1-1.2-7-4.8-7-9V6l7-3Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

export function TruckIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M3 7h11v9H3zM14 10h4l3 3v3h-7z" />
      <circle cx="7" cy="18" r="1.6" />
      <circle cx="17" cy="18" r="1.6" />
    </svg>
  );
}

export function SparkleIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M12 3.5 13.6 9 19 10.6 13.6 12.2 12 17.6 10.4 12.2 5 10.6 10.4 9 12 3.5Z" />
      <path d="M18.5 16.5 19 18l1.5.5L19 19l-.5 1.5-.5-1.5L16.5 18l1.5-.5.5-1.5Z" />
    </svg>
  );
}

/**
 * A headset — customer support.
 *
 * The signifier for "a human being will answer". The earpiece and the
 * microphone boom are what separate it from a plain bell; a bell reads
 * as "notifications", and this is the opposite — a person waiting to
 * take your call.
 */
export function HeadsetIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M4 14v-2a8 8 0 0 1 16 0v2" />
      <path d="M4 14a2 2 0 0 1 2-2h1v6H6a2 2 0 0 1-2-2v-2Z" />
      <path d="M20 14a2 2 0 0 0-2-2h-1v6h1a2 2 0 0 0 2-2v-2Z" />
      <path d="M18 18v.5a2.5 2.5 0 0 1-2.5 2.5H13" />
    </svg>
  );
}

/**
 * An envelope — email.
 */
export function MailIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
      <path d="m3.5 7 8.5 6 8.5-6" />
    </svg>
  );
}

export function HomeIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1v-9.5Z" />
    </svg>
  );
}

export function GridIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </svg>
  );
}

/**
 * A map pin.
 *
 * The marker for the shop's store address in the footer — and, on the
 * order-tracking page, for the delivery destination.
 */
export function MapPinIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M12 21s7-5.1 7-11a7 7 0 1 0-14 0c0 5.9 7 11 7 11Z" />
      <circle cx="12" cy="10" r="2.5" />
    </svg>
  );
}

export function MenuIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}

export function TruckBoxIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M4 8.5 12 4l8 4.5v7L12 20l-8-4.5v-7Z" />
      <path d="M4 8.5 12 13l8-4.5M12 13v7" />
    </svg>
  );
}

export function BabyIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <circle cx="12" cy="12" r="8" />
      <path d="M9 10.5h.01M15 10.5h.01" />
      <path d="M9.5 14.5a3.5 3.5 0 0 0 5 0" />
      <path d="M15.5 6.5 17 5" />
    </svg>
  );
}

export function DropletIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M12 3.5s6 6.2 6 10a6 6 0 0 1-12 0c0-3.8 6-10 6-10Z" />
    </svg>
  );
}

export function SunIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" />
    </svg>
  );
}

export function LipstickIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M9 20h6v-4H9v4Z" />
      <path d="M10.5 16V9.5L12 6l1.5 3.5V16" />
    </svg>
  );
}

export function BrushIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M14 4.5 19.5 10 11 18.5 5.5 13 14 4.5Z" />
      <path d="m9 12.5 2.5 2.5" />
      <path d="M5.5 13 3 20l7-2.5" />
    </svg>
  );
}

export function BottleIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M10 3h4v3l1.5 2.5V19a2 2 0 0 1-2 2h-3a2 2 0 0 1-2-2V8.5L10 6V3Z" />
      <path d="M8.5 12h7" />
    </svg>
  );
}

export function FlaskIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M10 3h4v5.5l4 8.5a2 2 0 0 1-1.8 3H7.8a2 2 0 0 1-1.8-3l4-8.5V3Z" />
      <path d="M7.5 14h9" />
    </svg>
  );
}

export function MoonIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
    </svg>
  );
}

export function LeafIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M5 19c0-8 5-13 14-13 0 9-5 13-11 13H5Z" />
      <path d="M5 19c3-4 6-6 10-7.5" />
    </svg>
  );
}

export function ZoomIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <circle cx="11" cy="11" r="7" />
      <path d="M11 8v6M8 11h6M20 20l-3.5-3.5" />
    </svg>
  );
}

export function WarningIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M12 4 2.5 20h19L12 4Z" />
      <path d="M12 10v4M12 17.2h.01" />
    </svg>
  );
}

export function InfoIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 7.8h.01" />
    </svg>
  );
}

/**
 * A group of people.
 *
 * Distinct from `UserIcon`, which is a single person. The admin's Users
 * section is about the *list* of people, so the icon is a group.
 */
export function UsersIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M15.5 20v-1.5a4 4 0 0 0-4-4h-3a4 4 0 0 0-4 4V20" />
      <circle cx="10" cy="7.5" r="3.5" />
      <path d="M19.5 20v-1.5a4 4 0 0 0-3-3.87" />
      <path d="M15.5 4.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

/**
 * The settings cog.
 *
 * A gear is the near-universal signifier for configuration, and it is
 * visually distinct from every other icon in the sidebar.
 */
export function SettingsIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6h.09A1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.09A1.65 1.65 0 0 0 20.91 10H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </svg>
  );
}

/**
 * A box on a shelf.
 *
 * The inventory signifier. A plain cube would read as "packages" (a
 * parcel, a shipment); the shelf line makes it read as *stock on a
 * shelf*, which is what the inventory section manages.
 */
export function BoxIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M20.5 7.5v9l-8.5 4.5-8.5-4.5v-9L12 3l8.5 4.5Z" />
      <path d="M3.5 7.5 12 12l8.5-4.5M12 12v9" />
    </svg>
  );
}

/**
 * A line chart on an axis.
 *
 * The analytics signifier. Distinct from `GridIcon` (a dashboard of
 * tiles) and from `BoxIcon` (inventory): this is a *trend* — an axis
 * with a line rising across it, which is what the Analytics section
 * actually reports.
 */
export function ChartIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M4 4v16h16" />
      <path d="M7.5 15.5l3.5-4 3 2.5L19 8" />
    </svg>
  );
}

/**
 * A stack of records — the audit trail.
 *
 * The audit-trail signifier. Distinct from `ChartIcon` (a trend) and
 * from `StarIcon` (reviews): this is a *list of what happened*, which
 * is what a ledger looks like. The three horizontal rules read as rows
 * of an entry, and the leading marks as their timestamps.
 */
export function LedgerIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M5 4.5h9M5 9.5h14M5 14.5h14M5 19.5h9" />
      <path d="M3 4.5h.01M3 9.5h.01M3 14.5h.01M3 19.5h.01" />
    </svg>
  );
}

/**
 * A price tag with a percentage — the promo / coupon signifier.
 *
 * The tag is the conventional mark for a discount; the small "%" inside
 * it is what separates it from a plain price tag, because the Promos
 * panel deals in discount *codes* rather than in prices.
 */
export function TagIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M3.5 11.6V5a1.5 1.5 0 0 1 1.5-1.5h6.6a1.5 1.5 0 0 1 1.06.44l7.4 7.4a1.5 1.5 0 0 1 0 2.12l-6.6 6.6a1.5 1.5 0 0 1-2.12 0l-7.4-7.4a1.5 1.5 0 0 1-.44-1.06Z" />
      <path d="M8 8h.01" />
      <path d="m10.5 13 4-4M12 9.5a1.5 1.5 0 0 1 3 0 1.5 1.5 0 0 1-1 1.4M14 14.5a1.5 1.5 0 0 1-3 0 1.5 1.5 0 0 1 1-1.4" />
    </svg>
  );
}

/**
 * A dropper over a droplet — the skin-concern signifier.
 *
 * A droplet alone is the shop's "liquid" motif, which the whole
 * cosmetics range shares. The dropper tip is what makes this read as
 * *a treatment applied to skin* rather than any bottle on the shelf.
 */
export function DropletToolIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M12 3.5s5 5.2 5 9a5 5 0 0 1-10 0c0-3.8 5-9 5-9Z" />
      <path d="M18.5 12.5 20 11" />
      <path d="m18.2 14.6 1.5-.9" />
      <path d="M9.7 12.4a2.4 2.4 0 0 0 2.3 3.3" />
    </svg>
  );
}

/**
 * A rosette-style brand mark — the brand signifier.
 *
 * A circle with a scalloped edge reads as a *maker's mark* — a stamp,
 * a seal, something a brand puts on its own products. A plain circle
 * would be indistinguishable from the other round glyphs in the set.
 */
export function BrandMarkIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <circle cx="12" cy="12" r="7.5" />
      <circle cx="12" cy="12" r="3.5" />
      <path d="M12 4.5v1.6M12 17.9v1.6M4.5 12h1.6M17.9 12h1.6" />
    </svg>
  );
}

/**
 * The collapse / expand chevron for the sidebar.
 *
 * A single chevron that points in the direction the sidebar will go,
 * rather than a generic "toggle" glyph. Its meaning is obvious without
 * a tooltip.
 */
export function PanelLeftIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9.5 4v16" />
    </svg>
  );
}

/**
 * The notification bell.
 *
 * The admin's inbox. Drawn with the clapper separated from the body so
 * the silhouette reads as a bell at 20px — a filled circle would read as
 * a badge, and the badge is a different thing entirely.
 */
export function BellIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M18 8a6 6 0 1 0-12 0c0 6-2 7-2 7h16s-2-1-2-7" />
      <path d="M13.7 20a2 2 0 0 1-3.4 0" />
    </svg>
  );
}

/**
 * A small clock — "how long ago", on a notification row.
 *
 * Decorative in context: the text beside it carries the readable time,
 * so the icon is never the only thing saying what it means.
 */
export function ClockIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  );
}

/**
 * An eye — "view this order".
 *
 * Distinct from the search glyph and from the box glyph: this one is
 * unambiguously about *seeing* something that already exists.
 */
export function EyeIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

/**
 * A pencil — "edit this order".
 */
export function PencilIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3Z" />
      <path d="M14.5 7.5 16.5 9.5" />
    </svg>
  );
}

/**
 * A wide banner panel with a picture in it — the hero-carousel
 * signifier.
 *
 * The shape is deliberately different from every other panel in the set
 * (the box, the ledger, the brand mark): it is a **landscape**
 * rectangle, because that is the shape of a homepage banner. The
 * little sun and hill inside say "artwork" rather than "document",
 * which is what distinguishes this from a generic panel icon.
 */
export function BannerIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <rect x="2.5" y="5" width="19" height="14" rx="2" />
      <circle cx="8" cy="10" r="1.6" />
      <path d="m3.5 17 4.6-4.6a1.6 1.6 0 0 1 2.3 0L13 15" />
      <path d="m11 15 2.2-2.2a1.6 1.6 0 0 1 2.3 0l4 4" />
    </svg>
  );
}

/**
 * A filter-and-sort funnel.
 *
 * The admin orders page's "Filter & Sort" control. A funnel with three
 * horizontal lines reads as "arrange", not merely "hide" — which is what
 * a sort option actually does.
 */
export function SortIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M4 6h16M7 12h10M10 18h4" />
    </svg>
  );
}

