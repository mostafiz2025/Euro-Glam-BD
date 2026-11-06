import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The admin panel's layout isolation.
 *
 * ── The bug this test exists to prevent ───────────────────────────────────
 *
 * The admin dashboard used to be rendered **inside** the storefront.
 *
 * The storefront's chrome — the header with its search bar, the
 * announcement bar, the category strip, the cart drawer, the footer —
 * was mounted in the **root layout**. Next.js nests every layout inside
 * the one above it, so `/admin/*` inherited all of it.
 *
 * The visible symptom was a layout collision: the storefront header is
 * `sticky top-0 z-50` and the admin rail was `z-40`, so the shop's
 * header painted **over** the operator's menu. The sidebar looked
 * broken — labels clipped, icons hidden — and the cause was a
 * z-index war between two components that had no business sharing a
 * page.
 *
 * The fix was structural rather than cosmetic: the shop's chrome moved
 * into the `(storefront)` route group, and the admin panel inherited
 * only its own shell.
 *
 * ── Why these tests read the source rather than the rendered page ────────
 *
 * The rendered page is the real proof, but it needs a running server
 * and a signed-in administrator — which makes it an integration test
 * that cannot run in an ordinary `vitest run`.
 *
 * The property being protected, though, is a property of the **layout
 * tree**, and the layout tree is the filesystem: which directories
 * live inside the `(storefront)` group, and what each layout imports.
 *
 * So these tests read the source tree. They are fast, they need no
 * database, and they fail the moment someone moves a page back into the
 * wrong group — which is exactly the edit that would reintroduce the
 * bug.
 */

const APP_DIR = path.join(process.cwd(), "src", "app");
const STOREFRONT_GROUP = path.join(APP_DIR, "(storefront)");

function read(file: string): string {
  return fs.readFileSync(file, "utf8");
}

/**
 * The file's **code**, with its comments removed.
 *
 * A comment that *mentions* a class name is not the class being used.
 * The old padding hack and the brand mark's `truncate` are both
 * discussed in prose — one to say it is gone, the other to say where
 * truncation is and is not allowed. So the assertions below look at the
 * code, not at the file.
 */
function readCode(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

/**
 * The directories under `src/app` that are **not** the storefront group,
 * the admin panel, the API routes or the payment callbacks.
 *
 * These are the pages that have no storefront chrome. Each of them must
 * either live inside the group — so it inherits the shop's layout — or
 * be a page that is deliberately chrome-free.
 */
const CHROMELESS_ROUTES = [
  "account",
  "advisor",
  "cart",
  "checkout",
  "forbidden",
  "login",
  "orders",
  "orders-not-found",
  "products",
  "products-not-found",
  "register",
  "track-order",
];

describe("the storefront route group", () => {
  it("exists", () => {
    expect(fs.existsSync(STOREFRONT_GROUP)).toBe(true);
  });

  it("holds the home page", () => {
    // The home page is the shop's front door. If it were left at the
    // root it would render with no header at all.
    expect(fs.existsSync(path.join(STOREFRONT_GROUP, "page.tsx"))).toBe(true);
  });

  it("holds every customer-facing page", () => {
    for (const route of CHROMELESS_ROUTES) {
      expect(
        fs.existsSync(path.join(STOREFRONT_GROUP, route)),
        `${route} should live inside the (storefront) group`,
      ).toBe(true);
    }
  });

  it("carries its own layout, and that layout mounts the shop's shell", () => {
    const layout = read(path.join(STOREFRONT_GROUP, "layout.tsx"));

    expect(layout).toContain("AppShell");
  });

  it("mounts the announcement bar in the shop's shell", () => {
    /*
     * The announcement is the shop's **voice**, so it belongs to the
     * shop's shell — which means it is on every storefront page and on
     * no admin page.
     *
     * The admin panel is a separate application (see the decision
     * above), and an operator staring at a scrolling advertisement
     * while they work is a bar in the wrong place.
     */
    const shell = read(
      path.join(process.cwd(), "src", "components", "layout", "app-shell.tsx"),
    );

    expect(shell).toContain("<MarqueeBannerSection />");
  });
});

describe("the root layout", () => {
  const layout = read(path.join(APP_DIR, "layout.tsx"));

  it("does not mount the storefront shell", () => {
    /*
     * This is the assertion that would have caught the original bug.

     * The root layout is the inheritance of every route in the app. If
     * it mounts the shop's chrome, the admin panel inherits the shop's
     * chrome too — and the two layouts end up fighting over the same
     * pixels.
     */
    expect(layout).not.toContain("AppShell");
  });

  it("does not import any storefront chrome component", () => {
    const storefrontImports = [
      "@/components/layout/header",
      "@/components/layout/footer",
      "@/components/layout/app-shell",
      "@/components/layout/bottom-nav",
      "@/components/layout/cart-button",
      "@/components/layout/marquee-banner-section",
      "@/components/commerce/cart-drawer",
      "@/components/commerce/cart-drawer-provider",
    ];

    for (const importPath of storefrontImports) {
      expect(layout).not.toContain(importPath);
    }
  });

  it("still renders the document shell and the theme script", () => {
    // The root layout is not *empty* — it owns <html>, <body> and the
    // no-flash theme script. Removing the shell must not take those
    // with it.
    expect(layout).toContain("<html");
    expect(layout).toContain("<body");
    expect(layout).toContain("THEME_SCRIPT");
  });
});

describe("the admin layout", () => {
  const layout = read(path.join(APP_DIR, "admin", "layout.tsx"));

  it("mounts the admin shell", () => {
    expect(layout).toContain("AdminShell");
  });

  it("does not mount the storefront shell", () => {
    expect(layout).not.toContain("AppShell");
  });

  it("does not import any storefront chrome component", () => {
    const storefrontImports = [
      "@/components/layout/header",
      "@/components/layout/footer",
      "@/components/layout/app-shell",
      "@/components/layout/bottom-nav",
      "@/components/commerce/cart-drawer",
      "@/components/commerce/cart-drawer-provider",
    ];

    for (const importPath of storefrontImports) {
      expect(layout).not.toContain(importPath);
    }
  });

  it("still performs the session gate", () => {
    // Isolation must not weaken the gate. The layout still reads the
    // session on the server and still redirects.
    expect(layout).toContain("getOptionalUser");
    expect(layout).toContain("redirect");
  });
});

describe("the admin shell's layout", () => {
  const shell = readCode(
    path.join(process.cwd(), "src", "components", "admin", "shell", "AdminShell.tsx"),
  );

  it("is a flex row, so the sidebar and the content share one track", () => {
    expect(shell).toContain("flex min-h-screen w-full");
  });

  it("does not take the sidebar out of the flow with position: fixed", () => {
    /*
     * The old rail was `fixed inset-y-0 left-0 z-40`, and the content
     * column carried a matching `lg:pl-[260px]`. Two pieces of
     * arithmetic that had to agree — and when they disagreed, the rail
     * and the content stopped being one layout and became two elements
     * fighting for the same pixels.
     *
     * A flex item cannot overlap its sibling. So the absence of `fixed`
     * here is the structural guarantee that the sidebar cannot mask the
     * content.
     */
    expect(shell).not.toContain("fixed inset-y-0 left-0 z-40");
  });

  it("does not reserve space with a hand-matched padding", () => {
    // The content column is `flex-1`, so it takes whatever is left.
    // There is no padding to keep in step with the rail's width.
    expect(shell).not.toContain("lg:pl-[260px]");
    expect(shell).not.toContain("lg:pl-[116px]");
  });

  it("lets the content column shrink, so a wide table cannot push the rail off screen", () => {
    /*
     * A flex item's default `min-width` is `auto`, which means it
     * refuses to shrink below the size of its own content. Without
     * `min-w-0`, a wide table in the page would push the content out of
     * the row and the sidebar off the left edge of the screen.
     */
    expect(shell).toContain("min-w-0");
    expect(shell).toContain("flex-1");
  });

  it("keeps the sidebar's own width explicit", () => {
    expect(shell).toContain("w-[260px]");
    expect(shell).toContain("w-[116px]");
    expect(shell).toContain("shrink-0");
  });
});

describe("the admin sidebar's labels", () => {
  const sidebar = read(
    path.join(process.cwd(), "src", "components", "admin", "shell", "AdminSidebar.tsx"),
  );

  const sidebarCode = readCode(
    path.join(process.cwd(), "src", "components", "admin", "shell", "AdminSidebar.tsx"),
  );

  /**
   * The markup of the nav item's **label**, from the opening of its
   * `<span>` to the text it renders.
   *
   * This is scoped deliberately. The sidebar file also contains the
   * brand mark, whose "Euro Glam BD" subtitle *is* truncated — and
   * that is fine, because it is a two-word caption in a box wide
   * enough to hold it, not a section name the operator has to read.
   *
   * The rule is about the **section labels**: "Audit Logs" and
   * "Inventory" are the names of places, and those must never be
   * clipped.
   */
  const labelMarkup = (() => {
    const labelIndex = sidebar.indexOf("{item.label}");

    expect(labelIndex).toBeGreaterThan(-1);

    // The `<span>` that wraps the label opens just before it.
    const openIndex = sidebar.lastIndexOf("<span", labelIndex);

    return sidebar.slice(openIndex, labelIndex);
  })();

  it("does not truncate a section label", () => {
    /*
     * A clipped label is worse than a hidden one, because it looks
     * present. "Audit Lo…" tells the operator a section exists without
     * telling them its name, and it makes the rail look broken rather
     * than narrow.
     */
    expect(labelMarkup).not.toContain("truncate");
  });

  it("wraps the label instead", () => {
    expect(labelMarkup).toContain("break-words");
  });

  it("renders both the icon and the label", () => {
    expect(sidebarCode).toContain("<Icon");
    expect(sidebarCode).toContain("{item.label}");
  });
});
