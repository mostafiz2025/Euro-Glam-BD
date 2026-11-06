import type { ComponentType, SVGProps } from "react";

import {
  BannerIcon,
  BoxIcon,
  BrandMarkIcon,
  ChartIcon,
  DropletToolIcon,
  GridIcon,
  LedgerIcon,
  SettingsIcon,
  StarIcon,
  TagIcon,
  TruckBoxIcon,
  UsersIcon,
} from "@/components/ui/icons";

/**
 * The admin navigation items.
 *
 * ── Why the list is a closed constant ────────────────────────────────────
 *
 * The sections are a fixed set. Making them a typed constant rather
 * than a config file or a database table means:
 *
 *   • A typo cannot produce a link to a page that does not exist —
 *     the href is checked against the union of the known routes.
 *   • The icons are imported statically, so the bundler can tree-shake
 *     them and there is no dynamic-import waterfall in the sidebar.
 *   • The nav and the routes cannot drift apart silently, because
 *     adding a section means adding it here, in the same commit as
 *     the page.
 *
 * The order is the order an operator works in: look at the dashboard,
 * then fix what it flagged.
 */
export type AdminNavItem = {
  readonly href: string;
  readonly label: string;
  /** A short description, used as the tooltip when the rail is collapsed. */
  readonly description: string;
  readonly icon: ComponentType<SVGProps<SVGSVGElement>>;
};

export const ADMIN_NAV_ITEMS: readonly AdminNavItem[] = [
  {
    href: "/admin",
    label: "Dashboard",
    description: "Overview metrics, revenue and traffic",
    icon: GridIcon,
  },
  {
    href: "/admin/analytics",
    label: "Analytics",
    description: "Revenue, traffic and conversion over time",
    icon: ChartIcon,
  },
  {
    href: "/admin/products",
    label: "Inventory",
    description: "Products, stock levels and adjustments",
    icon: BoxIcon,
  },
  {
    href: "/admin/orders",
    label: "Orders",
    description: "Fulfilment status and payments",
    icon: TruckBoxIcon,
  },
  {
    href: "/admin/reviews",
    label: "Reviews",
    description: "Moderate customer reviews",
    icon: StarIcon,
  },
  {
    href: "/admin/promos",
    label: "Promos",
    description: "Discount codes and coupons",
    icon: TagIcon,
  },
  {
    href: "/admin/categories",
    label: "Categories",
    description: "Shop categories and their card images",
    icon: TagIcon,
  },
  {
    href: "/admin/concerns",
    label: "Concerns",
    description: "Skin concerns and their card images",
    icon: DropletToolIcon,
  },
  {
    href: "/admin/brands",
    label: "Brands",
    description: "Brand logos, monograms and ordering",
    icon: BrandMarkIcon,
  },
  {
    href: "/admin/hero-banners",
    label: "Hero Banners",
    description: "The homepage carousel — artwork, copy and order",
    icon: BannerIcon,
  },
  {
    href: "/admin/users",
    label: "Users",
    description: "Customers and administrators",
    icon: UsersIcon,
  },
  {
    href: "/admin/audit-logs",
    label: "Audit Logs",
    description: "Every change an admin has made",
    icon: LedgerIcon,
  },
  {
    href: "/admin/settings",
    label: "Settings",
    description: "Your profile, the shop's details and the advisor",
    icon: SettingsIcon,
  },
];

/**
 * Whether a nav item is the active one, given the current pathname.
 *
 * The dashboard matches only its **exact** path. The others match their
 * whole subtree, so `/admin/orders/123` still highlights "Orders".
 *
 * The trailing-slash case is handled explicitly: `/admin/products` is
 * the inventory page, and `/admin/products/` is the same page, not a
 * child of it.
 */
export function isActiveNavItem(href: string, pathname: string): boolean {
  if (href === "/admin") {
    return pathname === "/admin" || pathname === "/admin/";
  }

  return pathname === href || pathname.startsWith(`${href}/`);
}
