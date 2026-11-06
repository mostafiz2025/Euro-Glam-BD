import {
  BabyIcon,
  BottleIcon,
  BrushIcon,
  DropletIcon,
  FlaskIcon,
  LipstickIcon,
  MoonIcon,
  SunIcon,
  type IconProps,
} from "./icons";
import {
  CATEGORY_FALLBACK,
  CATEGORY_ICONS,
  type CategoryIconKey,
} from "@/lib/format/taxonomy";

/**
 * The category icon.
 *
 * ── The rule that governs this file ──────────────────────────────────────
 *
 * **A category with no icon entry still renders.**
 *
 * The icon table is keyed by category *slug*, and it is a static module
 * while the categories live in the database. An admin who adds a
 * category the table has never heard of must not produce a broken tile
 * — so the fallback is a real, drawn icon, not a blank space.
 *
 * This is the difference between a table that *decorates* the catalogue
 * and one that *gates* it.
 */

/**
 * The icon for each key.
 */
const ICONS: Record<CategoryIconKey, (props: IconProps) => React.JSX.Element> = {
  cleanser: DropletIcon,
  serum: FlaskIcon,
  moisturiser: BottleIcon,
  sunscreen: SunIcon,
  makeup: BrushIcon,
  lipstick: LipstickIcon,
  baby: BabyIcon,
  hair: MoonIcon,
};

/**
 * The props for the category icon.
 *
 * The size props are forwarded to the underlying SVG, so the icon can be
 * sized at the call site rather than being locked to one size here.
 */
export type CategoryIconProps = {
  /** The category slug. */
  readonly slug: string;
  readonly className?: string;
  readonly width?: number;
  readonly height?: number;
};

export function CategoryIcon({
  slug,
  className,
  width,
  height,
}: CategoryIconProps) {
  const entry = CATEGORY_ICONS[slug];
  const key = entry?.icon ?? CATEGORY_FALLBACK.icon;
  const Icon = ICONS[key];

  return <Icon className={className} width={width} height={height} />;
}
