import Link from "next/link";
import { Suspense } from "react";
 
import { ProductCard } from "@/components/commerce/product-card";
import { BrandBar } from "@/components/home/brand-bar";
import { CategoryGrid } from "@/components/home/category-grid";
import { ConcernGrid } from "@/components/home/concern-grid";
import { HERO_SLIDES } from "@/components/home/hero-slides";
import { HeroSlider } from "@/components/home/hero-slider";
import { ButtonLink } from "@/components/ui/button";
import { ChevronRightIcon } from "@/components/ui/icons";
import { SectionHeading } from "@/components/ui/section-heading";
import { toHeroSlides } from "@/lib/format/hero-banners";
import {
  fetchBrands,
  fetchCategories,
  fetchConcerns,
  fetchHeroBanners,
  fetchProducts,
} from "@/lib/format/server-data";
 
/**
 * The home page.
 *
 * ── How the data is fetched ──────────────────────────────────────────────
 *
 * The page is a **server component** and it calls the catalogue service
 * directly — not the API over HTTP. See
 * `src/lib/format/server-data.ts` for why.
 *
 * ── How the page is rendered ─────────────────────────────────────────────
 *
 * The page is split into a **static shell** and **streamed sections**.
 *
 * The hero, the section headings and the "View all" links do not depend
 * on the database, so they are prerendered at build time and served
 * instantly from the CDN. The sections that *do* read the catalogue —
 * the category grid, the two product grids — sit behind `<Suspense>`
 * boundaries, so their fallbacks ship with the shell and the real
 * content streams in behind them.
 *
 * That is the pattern Next.js 16's Cache Components rewards, and it is
 * the right one for a shop: a customer sees the layout, the headings
 * and the hero immediately, and the products arrive a moment later. A
 * page that blocks on three database round-trips before it renders
 * anything is a page that shows a blank screen on a slow connection.
 *
 * The reads inside the streamed part run **in parallel** with
 * `Promise.all`. They are independent, and issuing them sequentially
 * would make the customer wait for the sum of three round-trips
 * instead of the slowest one.
 *
 * ── The page's conversion zones ──────────────────────────────────────────
 *
 * The page is organised as a strict sequence of **conversion zones**,
 * each one doing exactly one job and separated by a tight, consistent
 * rhythm:
 *
 *   a) **Hero** — the brand carousel. The first thing on a multi-brand
 *      storefront is the brands themselves.
 *   b) **Top Categories** — soft, minimalist cards. The catalogue's
 *      own axes.
 *   c) **Shop By Skin Concern** — the same shelf, addressed by
 *      *problem* rather than by product type.
 *   d) **New Arrivals** — what is new.
 *   e) **Best Sellers** — what other people bought.
 *   f) **Featured Brands** — the houses themselves, as nameplates.
 *   g) **AI Skin Care Advisor** — the last thing on the page.
 *
 * Two sections were **removed** from this flow:
 *
 *   • **"Shop Your Way"** — it repeated the category grid and the
 *     concern grid that surround it. Three ways to say "browse the
 *     catalogue" in one screen is two too many.
 *   • **The duplicate AI Advisor band** — the advisor already has a
 *     hero slide and a header link. A third full-width banner further
 *     down the page repeated the same call to action and broke the
 *     rhythm of the zones. It now appears once, as the closing
 *     section of the page.
 *
 * ── What happens when a query fails ──────────────────────────────────────
 *
 * `fetchProducts` never throws — it returns an empty list with an error
 * message. A failed catalogue query must not take the storefront down.
 * The page renders the section with an honest empty state instead of
 * crashing, and the error is logged server-side.
 */
 
/**
 * The number of products in each grid.
 *
 * Two on a phone is a comfortable card size; eight fills a desktop row
 * of four, twice.
 */
const GRID_SIZE = 8;
 
/**
 * The three things the AI advisor actually does.
 *
 * Each one is a **capability the shop already ships**, not an ambition:
 * the advisor accepts a photo, it builds a skin profile, and the
 * conflict engine checks the routine before the shopper buys. Writing
 * it this way means the closing section cannot drift away from the
 * product it is describing.
 */
const ADVISOR_STEPS = [
  {
    title: "Send a photo, or just describe your skin",
    body: "A photograph or a sentence is enough to start. The advisor reads your skin type and the concerns you name.",
  },
  {
    title: "Get a routine, not a product list",
    body: "You are told what to use, in what order, and what to leave out — with a note on why each choice suits your skin.",
  },
  {
    title: "Conflicts are checked before checkout",
    body: "A deterministic rules engine flags the ingredient combinations that should not be layered together, before you spend anything.",
  },
] as const;
 
export default function HomePage() {
  return (
    <>
      {/*
        The brand slider.
 
        It is the first thing on the page because on a **multi-brand**
        storefront the brand is the organising idea. A shopper who trusts
        La Roche-Posay for their eczema wants to be shown more La
        Roche-Posay — not a generic serum. So the top of the page is a
        sequence of brand showcases, each leading to a real filtered view.
 
        ── Why the slides are read on the server ──────────────────────────
        *
        * The shop's campaigns live in the database, so the page reads
        * them and hands the slider a finished set of slides. A slide is
        * copy and a ground — the words, a gradient wash and an optional
        * photograph — so there is nothing else to resolve.
        *
        * And it is **streamed**, so the hero's copy — the headline, the
        * calls to action, the trust points — ships with the static shell
        * and paints immediately. The shop's own campaigns then stream in
        * behind them, so nothing on the page jumps.
      */}
      <Suspense fallback={<HeroSliderFallback />}>
        <HeroSection />
      </Suspense>
 
      {/*
        The page canvas.
 
        ── The order of the zones ───────────────────────────────────────────
        *
        * The page is a **funnel**, and it is ordered the way a shopper
        * actually walks a boutique:
        *
        *   a) **Hero** — the brand carousel. The first thing on a
        *      multi-brand storefront is the brands themselves.
        *   b) **Top Categories** — the catalogue's own axes. A shopper
        *      who knows *what kind of thing* they want starts here.
        *   c) **Shop By Skin Concern** — the same catalogue, but
        *      addressed by *problem* rather than by product type. It
        *      sits next to the categories because they are the two
        *      ways of browsing the same shelf.
        *   d) **New Arrivals** — what is new. A shopper who is not
        *      sure what they want reads the new shelf.
        *   e) **Best Sellers** — what other people bought. The
        *      single most trusted signal on any shop.
        *   f) **Featured Brands** — the houses themselves, as large
        *      marks. This is the *trust* section, and it comes last
        *      of the catalogue sections because a shopper who has
        *      already seen the products may now want to know whose
        *      products they are looking at.
        *   g) **AI Skin Care Advisor** — the last thing on the page,
        *      directly above the footer. It is the shop's offer of
        *      help, and it is what a shopper reaches for when nothing
        *      else on the page told them what to buy.
        *
        * The order is the page's argument: *here is what we carry, here
        * is what it does for your skin, here is what is new, here is
        * what people love, here is whose it is, and if you still do not
        * know — ask us.*
        *
        * ── The vertical rhythm ────────────────────────────────────────────
        *
        * One gap — `space-y-10` on the phone, `lg:space-y-12` on the
        * desktop — drives every boundary between zones. Not one section
        * gets its own extra air, because a section that is *bigger* than
        * its neighbours reads as more important, and here the ordering
        * is what carries the importance, not the spacing.
        *
        * The scale is **deliberately tight**. A boutique storefront is
        * a continuous editorial page, not a stack of air-separated
        * blocks — and on a long page the whitespace between sections
        * compounds: by the time a shopper reaches the fifth section
        * they have scrolled through four troughs of nothing, and the
        * page has stopped feeling like a *shop* and started feeling
        * like a menu.
        *
        * What keeps a tight scale from reading as *undifferentiated* is
        * the **hairline** above each heading (`SectionHeading` draws
        * one). The rule is what marks the boundary — not a trough of
        * empty space. Tight spacing plus a drawn rule says "these are
        * separate sections"; tight spacing alone says "this is one
        * long list".
        *
        * The two product grids are deliberately **not** nested inside one
        * another any more. Each is its own zone with its own heading and
        * its own rule, because the new order separates them — a
        * negative margin or a nested group would express a pairing the
        * page is no longer making.
      */}
      <div className="mx-auto max-w-7xl space-y-10 px-4 py-8 sm:px-6 sm:py-10 lg:space-y-12 lg:px-8 lg:py-12">
        {/* ── (b) Top categories ──────────────────────────────────────── */}
        <section aria-labelledby="top-categories">
          <SectionHeading
            eyebrow="Browse"
            title="Top Categories"
            subtitle="Everything for your routine, from European pharmacy brands."
            action={
              <Link
                href="/products"
                className="inline-flex items-center gap-1 text-sm font-medium text-brand-700 transition-colors hover:text-brand-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
              >
                View all
                <ChevronRightIcon width={16} height={16} />
              </Link>
            }
            className="mb-5"
          />
 
          <h2 id="top-categories" className="sr-only">
            Top Categories
          </h2>
 
          <Suspense fallback={<GridSkeleton />}>
            <CategorySection />
          </Suspense>
        </section>
 
        {/* ── (c) Shop by skin concern ────────────────────────────────── */}
        <section aria-labelledby="shop-by-concern">
          <SectionHeading
            eyebrow="Targeted"
            title="Shop By Skin Concern"
            subtitle="Targeted care for the problem you actually want solved."
            action={
              <Link
                href="/products?view=concerns"
                className="inline-flex items-center gap-1 text-sm font-medium text-brand-700 transition-colors hover:text-brand-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
              >
                View all
                <ChevronRightIcon width={16} height={16} />
              </Link>
            }
            className="mb-5"
          />
 
          <h2 id="shop-by-concern" className="sr-only">
            Shop By Skin Concern
          </h2>
 
          <Suspense fallback={<GridSkeleton />}>
            <ConcernSection />
          </Suspense>
        </section>
 
        {/* ── (d) New arrivals ────────────────────────────────────────── */}
        <section aria-labelledby="new-arrivals">
          <SectionHeading
            eyebrow="Just landed"
            title="New Arrivals"
            subtitle="Fresh from the European distributors."
            action={
              <Link
                href="/products?sort=newest"
                className="inline-flex items-center gap-1 text-sm font-medium text-brand-700 transition-colors hover:text-brand-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
              >
                View all
                <ChevronRightIcon width={16} height={16} />
              </Link>
            }
            className="mb-5"
          />
 
          <h2 id="new-arrivals" className="sr-only">
            New Arrivals
          </h2>
 
          <Suspense fallback={<GridSkeleton />}>
            <NewArrivalsSection />
          </Suspense>
        </section>
 
        {/* ── (e) Best sellers ────────────────────────────────────────── */}
        <section aria-labelledby="best-sellers">
          <SectionHeading
            eyebrow="Loved"
            title="Best Sellers"
            subtitle="The products our customers keep coming back for."
            action={
              <Link
                href="/products?isBestSeller=true"
                className="inline-flex items-center gap-1 text-sm font-medium text-brand-700 transition-colors hover:text-brand-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
              >
                View all
                <ChevronRightIcon width={16} height={16} />
              </Link>
            }
            className="mb-5"
          />
 
          <h2 id="best-sellers" className="sr-only">
            Best Sellers
          </h2>
 
          <Suspense fallback={<GridSkeleton />}>
            <BestSellersSection />
          </Suspense>
        </section>
 
        {/* ── (f) Featured brands ─────────────────────────────────────── */}
        <section aria-labelledby="featured-brands">
          <SectionHeading
            eyebrow="The labels"
            title="Featured Brands"
            subtitle="Authorised European labels, stocked and shipped locally."
            action={
              <Link
                href="/products?view=brands"
                className="inline-flex items-center gap-1 text-sm font-medium text-brand-700 transition-colors hover:text-brand-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
              >
                All brands
                <ChevronRightIcon width={16} height={16} />
              </Link>
            }
            className="mb-5"
          />
 
          <h2 id="featured-brands" className="sr-only">
            Featured Brands
          </h2>
 
          <Suspense fallback={<BrandBarSkeleton />}>
            <BrandSection />
          </Suspense>
        </section>
 
        {/* ── (g) The advisor — the last word ─────────────────────────── */}
        <AdvisorSection />
      </div>
    </>
  );
}
 
/**
 * The hero, with its slides resolved.
 *
 * ── Two sources, one carousel ─────────────────────────────────────────────
 *
 * The hero's slides come from **two** places, and the order is
 * deliberate:
 *
 *   1. **The admin's banners**, from the database. These are the shop's
 *      current campaigns, and they are what the admin panel manages.
 *   2. **The static slides**, from `hero-slides.ts`, when there are no
 *      banners at all.
 *
 * The static slides are the **fallback**, not the competitor. A shop
 * that has created banners shows only its banners; the code-defined
 * campaigns would otherwise fight the admin's for the same carousel.
 * But a shop with no banners — or a storefront whose banner query failed
 * — shows the four campaigns that ship with the code, so the homepage
 * is never empty and never worse than it was before the admin panel
 * existed.
 *
 * ── Why the hero reads the database at all ────────────────────────────────
 *
 * Only for the banners. A slide is copy and a ground — the words, the
 * gradient wash and an optional photograph whose key the banner already
 * carries — so nothing about a slide needs resolving against the
 * catalogue.
 *
 * That used to be false. The hero resolved each slide's **product
 * mockup** from the catalogue, which meant a page load spent four
 * database round-trips on photographs for a second column that is now
 * gone. The carousel is now one read: the banners.
 *
 * Streamed, because it reads the database. The copy is in the static
 * shell — this is only the banners.
 */
async function HeroSection() {
  const { banners } = await fetchHeroBanners();
 
  if (banners.length === 0) {
    return <HeroSlider slides={HERO_SLIDES} />;
  }
 
  return <HeroSlider slides={toHeroSlides(banners)} />;
}
 
/**
 * The hero shown while the banners load.
 *
 * It is the **static** slider, so the shopper sees the full hero
 * immediately: the headline, the calls to action and the trust points
 * all paint with the shell. The shop's own campaigns then stream in
 * behind them.
 *
 * The fallback is the real component rather than a placeholder,
 * because a hero is the one thing on the page that must never be
 * missing.
 */
function HeroSliderFallback() {
  return <HeroSlider slides={HERO_SLIDES} />;
}
 
/**
 * The category grid.
 *
 * Streamed, because the categories live in the database.
 */
async function CategorySection() {
  const categories = await fetchCategories();
 
  return <CategoryGrid categories={categories.categories} />;
}
 
/**
 * The concern grid.
 *
 * Streamed, because the concerns live in the database.
 */
async function ConcernSection() {
  const concerns = await fetchConcerns();
 
  return <ConcernGrid concerns={concerns.concerns} />;
}
 
/**
 * The featured brands bar.
 *
 * Streamed, because the brands live in the database.
 */
async function BrandSection() {
  const brands = await fetchBrands();
 
  return <BrandBar brands={brands.brands} />;
}
 
/**
 * The best sellers grid.
 */
async function BestSellersSection() {
  const bestSellers = await fetchProducts({
    isBestSeller: true,
    limit: GRID_SIZE,
    sort: "newest",
  });
 
  if (bestSellers.products.length === 0) {
    return (
      <EmptyState
        message={bestSellers.error ?? "No best sellers yet."}
        href="/products"
      />
    );
  }
 
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 sm:gap-x-5 lg:grid-cols-4">
      {bestSellers.products.map((product) => (
        <ProductCard key={product.id} product={product} />
      ))}
    </div>
  );
}
 
/**
 * The new arrivals grid.
 */
async function NewArrivalsSection() {
  const newArrivals = await fetchProducts({
    isNewArrival: true,
    limit: GRID_SIZE,
    sort: "newest",
  });
 
  if (newArrivals.products.length === 0) {
    return (
      <EmptyState
        message={newArrivals.error ?? "No new arrivals yet."}
        href="/products"
      />
    );
  }
 
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 sm:gap-x-5 lg:grid-cols-4">
      {newArrivals.products.map((product) => (
        <ProductCard key={product.id} product={product} />
      ))}
    </div>
  );
}
 
/**
 * The AI Skin Care Advisor — the closing section.
 *
 * ── Why it is last ────────────────────────────────────────────────────────
 *
 * This is the page's last word, and it is last for a **reason** rather
 * than by habit.
 *
 * Every zone above it is a way of choosing a product: browse by
 * category, by concern, by arrival date, by popularity, by house. The
 * advisor is the only zone that is *not* a way of choosing a product —
 * it is the shop's offer of help for the shopper who has already seen
 * all of those and still does not know.
 *
 * Placing it at the foot means it is met by exactly the shopper it is
 * for: someone who has scrolled the whole catalogue and found no
 * starting point. Putting it at the top would offer help to a shopper
 * who has not yet seen what the shop carries, and the offer would be
 * premature — they do not yet know the assistant has anything to advise
 * on.
 *
 * ── Why it is a full section and not a strip ──────────────────────────────
 *
 * It used to be a single line of copy between the product grids, and
 * then a quiet strip. Both were wrong for where it now lives.
 *
 * A **strip** is right for a mid-page interruption: it has to be small
 * enough not to interrupt the catalogue flow. But the closing section
 * is the page's **destination**. A shopper who reaches the bottom of a
 * long page has arrived at a decision point, and a decision point
 * deserves a proper answer — a heading, a sentence about what it does,
 * and the three things it actually does, so the shopper knows whether
 * it is worth opening.
 *
 * ── Why the three steps are real ──────────────────────────────────────────
 *
 * The copy describes what the advisor actually does — a photo, a skin
 * profile, and a conflict check — rather than a set of questions. That
 * distinction matters: "answer four questions" is a form to fill in,
 * and a shopper who thinks a form is what is being asked of them may
 * not bother. "Tell it about your skin" is a conversation, and it is
 * what the advisor is.
 */
function AdvisorSection() {
  return (
    <section aria-labelledby="skin-advisor">
      <SectionHeading
        eyebrow="Not sure yet?"
        title="AI Skin Care Advisor"
        subtitle="Tell it about your skin — or send a photo — and get a routine built for your skin, with ingredient conflicts checked before you buy."
        action={
          <Link
            href="/advisor"
            className="inline-flex items-center gap-1 text-sm font-medium text-brand-700 transition-colors hover:text-brand-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
          >
            Open the advisor
            <ChevronRightIcon width={16} height={16} />
          </Link>
        }
        className="mb-5"
      />
 
      <h2 id="skin-advisor" className="sr-only">
        AI Skin Care Advisor
      </h2>
 
      {/*
        The panel.
 
        A raised card on the brand's own gradient, and the only place on
        the page where the rose ground is used at this size. It is the
        shop making an offer, and it is set apart from the catalogue
        for the same reason the footer is dark: it is a different
        register of content, and it should not be mistaken for another
        grid of products.
      */}
      <div
        className={[
          "relative overflow-hidden rounded-[var(--radius-card)] bg-brand-gradient",
          "ring-1 ring-inset ring-brand-100/80",
          "shadow-[var(--shadow-card)]",
        ].join(" ")}
      >
        {/*
          The wash.
 
          A soft off-centre bloom in the top-right corner. The brand
          gradient alone is a flat diagonal wash, which is fine but
          generic; the bloom gives the panel a light source and a
          direction, so the eye enters at the top-right and travels down
          the copy.
        */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -right-16 -top-24 h-72 w-72 rounded-full bg-white/40 blur-3xl"
        />
 
        <div className="relative grid gap-7 p-6 sm:p-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:items-center lg:gap-10 lg:p-10">
          {/* ── The offer ───────────────────────────────────────────── */}
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-brand-600">
              Personal, in a minute
            </p>
 
            <p className="mt-3 max-w-lg font-serif text-xl font-bold leading-snug tracking-tight text-foreground sm:text-2xl">
              A routine that accounts for your skin — and for 35°C and 80%
              humidity.
            </p>
 
            <p className="mt-4 max-w-xl text-sm leading-relaxed text-foreground-muted">
              The advisor is built for a customer in Dhaka buying an imported
              formula they cannot test first. It knows that a heavy cream
              that suits a European winter can be the wrong choice here, and
              it says so before you spend money.
            </p>
 
            <div className="mt-7">
              <ButtonLink href="/advisor" size="md">
                Try the AI Skin Advisor
              </ButtonLink>
            </div>
          </div>
 
          {/* ── The three steps ─────────────────────────────────────── */}
          <ol className="grid gap-3">
            {ADVISOR_STEPS.map((step, index) => (
              <li
                key={step.title}
                className={[
                  "flex items-start gap-4 rounded-[var(--radius-card)] bg-surface/70 p-5",
                  "ring-1 ring-inset ring-black/[0.04]",
                  "backdrop-blur-sm",
                ].join(" ")}
              >
                <span
                  aria-hidden="true"
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-600 font-serif text-sm font-bold text-white"
                >
                  {index + 1}
                </span>
 
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground">
                    {step.title}
                  </p>
 
                  <p className="mt-1 text-[13px] leading-relaxed text-foreground-muted">
                    {step.body}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
 
/**
 * The placeholder shown while a grid loads.
 *
 * It reserves the same space the real grid will take, so the page does
 * not jump when the products arrive. A skeleton that is a different
 * height from the content it replaces is worse than no skeleton.
 */
function GridSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 sm:gap-x-5 lg:grid-cols-4"
    >
      {Array.from({ length: 8 }, (_, index) => (
        <div key={index}>
          <div className="aspect-square animate-pulse rounded-[var(--radius-card)] bg-stone-50" />
          <div className="mt-4 h-2.5 w-1/3 animate-pulse rounded-full bg-surface-muted" />
          <div className="mt-2.5 h-3 w-4/5 animate-pulse rounded-full bg-surface-muted" />
          <div className="mt-4 flex items-center justify-between gap-3">
            <div className="h-4 w-1/3 animate-pulse rounded-full bg-surface-muted" />
            <div className="h-8 w-16 animate-pulse rounded-full bg-surface-muted" />
          </div>
        </div>
      ))}
    </div>
  );
}
 
/**
 * The placeholder shown while the brands load.
 *
 * It mirrors the brand grid's shape exactly — the same column counts,
 * the same plate and the same label heights — so the section does not
 * jump when the real brands arrive.
 */
function BrandBarSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2 no-scrollbar sm:mx-0 sm:grid sm:grid-cols-2 sm:gap-4 sm:overflow-visible sm:px-0 lg:grid-cols-3 xl:grid-cols-3 xl:gap-5"
    >
      {Array.from({ length: 6 }, (_, index) => (
        <div
          key={index}
          className="flex w-[260px] shrink-0 snap-start items-center gap-4 rounded-[var(--radius-card)] border border-border/80 bg-surface p-3 sm:w-full sm:shrink"
        >
          <div className="h-16 w-16 shrink-0 animate-pulse rounded-[calc(var(--radius-card)*0.66)] bg-surface-muted" />
          <div className="min-w-0 flex-1">
            <div className="h-3 w-2/3 animate-pulse rounded-full bg-surface-muted" />
            <div className="mt-2 h-2.5 w-1/3 animate-pulse rounded-full bg-surface-muted" />
          </div>
        </div>
      ))}
    </div>
  );
}
 
/**
 * The honest empty state.
 *
 * Shown when a section has nothing to display. It says what happened
 * and offers a way forward, rather than leaving a blank rectangle that
 * looks like a rendering bug.
 */
function EmptyState({ message, href }: { message: string; href: string }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-dashed border-border bg-surface p-10 text-center">
      <p className="text-sm text-foreground-muted">{message}</p>
 
      <div className="mt-4">
        <ButtonLink href={href} variant="outline" size="sm">
          Browse the catalogue
        </ButtonLink>
      </div>
    </div>
  );
}
 
 