/**
 * Database seed.
 *
 * Idempotent: safe to run repeatedly. Uses upsert on stable natural keys
 * (email, slug, key) so re-seeding updates rather than duplicates.
 *
 * Run with:  npx prisma db seed
 */
import { PrismaClient, UserRole, SkinType } from "@prisma/client";
import bcrypt from "bcryptjs";

import { legacyPathToStorageKey } from "../src/lib/format/image";

const prisma = new PrismaClient();

/**
 * Canonical ingredient IDs. These are the values stored in
 * Product.ingredientTags and matched by the deterministic conflict engine.
 * The catalogue itself lives in src/lib/conflicts/catalogue.ts — this list
 * mirrors it for seeding purposes.
 */
const INGREDIENT_TAGS = {
  AHA: ["AHA", "AHAs", "GLYCOLIC_ACID", "LACTIC_ACID", "MANDELIC_ACID"],
  BHA: ["BHA", "BHAs", "SALICYLIC_ACID", "SUBCYLIC_ACID"],
  RETINOL: ["RETINOL", "RETINYL_PALMITATE", "RETINYL_PALMATE", "RETINAL"],
  VITAMIN_C: ["VITAMIN_C", "ASCORBIC_ACID", "SAP", "ETHYL_ASCORBATE"],
  NIACINAMIDE: ["NIACINAMIDE", "NICOTINAMIDE"],
  HYALURONIC_ACID: ["HYALURONIC_ACID", "HYDROLYZED_HYALURONIC_ACID", "SODIUM_HYALURONATE"],
  BENZOYL_PEROXIDE: ["BENZOYL_PEROXIDE", "BPO"],
  HYDROQUINONE: ["HYDROQUINONE"],
  SQUALANE: ["SQUALANE"],
  CERAMIDES: ["CERAMIDES", "CERAMIDE"],
  CENTELLA: ["CENTELLA", "CENTELLA_ASIATICA", "CICA"],
  PANTHENOL: ["PANTHENOL"],
  VITAMIN_E: ["VITAMIN_E", "TOCOPHEROL"],
  SPF: ["SPF", "SUNSCREEN", "UV_FILTERS"],
  FRAGRANCE: ["FRAGRANCE", "PARFUM", "AROMA"],
  ALCOHOL: ["ALCOHOL", "ALCOHOL_DENAT", "ETHANOL"],
  TALC: ["TALC", "TALCUM"],
  MINERAL_OIL: ["MINERAL_OIL", "PETROLATUM", "PARAFFINUM_LIQUIDUM"],
  COLOURANTS: ["COLOURANTS", "CI_", "PIGMENTS"],
} as const;

const CATEGORIES = [
  { name: "Cleansers", slug: "cleansers" },
  { name: "Serums", slug: "serums" },
  { name: "Moisturisers", slug: "moisturisers" },
  { name: "Sunscreens", slug: "sunscreens" },
  { name: "Makeup", slug: "makeup" },
  { name: "Lipsticks", slug: "lipsticks" },
  { name: "Baby Care", slug: "baby-care" },
  { name: "Hair Care", slug: "hair-care" },
];

/**
 * The brands the shop features.
 *
 * ── Why the names match `KNOWN_BRANDS` exactly ───────────────────────────
 *
 * `Brand.name` is the string `Product.brand` holds, so the two must
 * agree — a brand in the table whose name is not in the registry would
 * be a brand the product path could never produce.
 *
 * The monograms are the house convention: a brand tile shows two
 * letters, and there is no algorithm that turns "La Roche-Posay" into
 * "LR" that a person would agree with. So they are written out.
 *
 * The `logo` is deliberately **not** seeded. Shipping a trademarked logo
 * requires permission, and the shop holds that decision — the admin
 * uploads the logos the shop is licensed to display, and every brand
 * without one falls back to its monogram.
 */
const BRANDS = [
  { name: "Bioderma", slug: "bioderma", monogram: "BD", sortOrder: 10 },
  { name: "CeraVe", slug: "cerave", monogram: "CV", sortOrder: 20 },
  { name: "La Roche-Posay", slug: "la-roche-posay", monogram: "LR", sortOrder: 30 },
  { name: "Maybelline", slug: "maybelline", monogram: "MB", sortOrder: 40 },
  { name: "Musta Baby", slug: "musta-baby", monogram: "MB", sortOrder: 50 },
  { name: "Musta Makeup", slug: "musta-makeup", monogram: "MM", sortOrder: 60 },
  { name: "Neutrogena", slug: "neutrogena", monogram: "NG", sortOrder: 70 },
  { name: "The Ordinary", slug: "the-ordinary", monogram: "TO", sortOrder: 80 },
  { name: "Vichy", slug: "vichy", monogram: "VY", sortOrder: 90 },
];

/**
 * The skin concerns the shop features.
 *
 * The `tag` is the **canonical ingredient ID** the concern filters on —
 * the same list the conflict engine compares — so a concern filter and
 * a conflict rule always agree about what "BHA" means.
 *
 * The `relatedTags` are the other ingredients in the same family, offered
 * in the filter panel.
 *
 * The `image` is deliberately **not** seeded — the admin uploads the
 * card images, and a concern without one falls back to the plain chip.
 */
const CONCERNS = [
  {
    name: "Acne",
    slug: "acne",
    tag: "BHA",
    relatedTags: ["BHA", "SALICYLIC_ACID", "BENZOYL_PEROXIDE", "NIACINAMIDE"],
  },
  {
    name: "Dullness",
    slug: "dullness",
    tag: "VITAMIN_C",
    relatedTags: ["VITAMIN_C", "ASCORBYL_GLUCOSIDE", "NIACINAMIDE"],
  },
  {
    name: "Fine Lines",
    slug: "fine-lines",
    tag: "RETINOL",
    relatedTags: ["RETINOL", "RETINAL", "RETINYL_PALMITATE", "VITAMIN_C"],
  },
  {
    name: "Dryness",
    slug: "dryness",
    tag: "HYALURONIC_ACID",
    relatedTags: ["HYALURONIC_ACID", "GLYCERIN", "PANTHENOL", "CERAMIDES"],
  },
  {
    name: "Sensitivity",
    slug: "sensitivity",
    tag: "PANTHENOL",
    relatedTags: ["PANTHENOL", "CENTELLA", "CERAMIDES", "OAT_EXTRACT"],
  },
  {
    name: "Texture",
    slug: "texture",
    tag: "AHA",
    relatedTags: ["AHA", "GLYCOLIC_ACID", "LACTIC_ACID", "MANDELIC_ACID"],
  },
  {
    name: "Oil Control",
    slug: "oil-control",
    tag: "NIACINAMIDE",
    relatedTags: ["NIACINAMIDE", "BHA", "SULFUR"],
  },
  {
    name: "Redness",
    slug: "redness",
    tag: "CENTELLA",
    relatedTags: ["CENTELLA", "PANTHENOL", "NIACINAMIDE", "ALCOHOL"],
  },
  {
    name: "Sun Protection",
    slug: "protection",
    tag: "SPF",
    relatedTags: ["SPF", "VITAMIN_E", "VITAMIN_C"],
  },
];

type SeedProduct = {
  name: string;
  /**
   * The product's brand.
   *
   * The seed states the brand **explicitly** rather than letting it be
   * derived from the name — the same way the admin form does. A seed
   * that guessed its own brands would be a seed that could not be
   * trusted to seed a new brand, and it would hide a mistake in the
   * brand registry behind a plausible-looking row.
   */
  brand: string;
  categorySlug: string;
  description: string;
  pricePaisa: number;
  discountPricePaisa?: number;
  discountPercentage?: number;
  stockQuantity: number;
  ingredients: string[];
  ingredientTags: string[];
  /**
   * The skin concerns the product is tagged with — the **slugs**.
   *
   * These are the "Shop by Concern" axis: which browse pages the
   * product appears on. They are the slugs rather than the ids
   * because a slug survives a rename, and they are the slugs rather
   * than the ingredient tags because a shopper asking "which of these
   * are for acne?" is asking about the product, not about the
   * ingredients it happens to contain.
   */
  concernSlugs?: string[];
  climateTips?: string;
  isNewArrival?: boolean;
  isBestSeller?: boolean;
  /**
   * The product's photograph — a **storage key**.
   *
   * ── Why the seed names a key and does not upload anything ───────────────
   *
   * The uploads directory is not committed (`public/uploads/` is in the
   * gitignore), so the seed cannot guarantee that a file it points at is
   * on disk on every machine it runs on. What it *can* do is name the
   * key the shop's own photography uses, so a machine that has the
   * photographs gets a fully-illustrated catalogue, and a machine that
   * does not gets a catalogue whose rows still exist and still read
   * correctly — with the typographic placeholder where the picture
   * would be.
   *
   * The key is the **file name** under `public/uploads/products/`. A key
   * that resolves to nothing renders the placeholder rather than a
   * broken image, so a wrong key is a missing picture, never a fault.
   */
  image?: string;
};

const PRODUCTS: SeedProduct[] = [
  {
    name: "La Roche-Posay Effaclar Purifying Foaming Gel",
    brand: "La Roche-Posay",
    categorySlug: "cleansers",
    description:
      "A gentle, non-stripping foaming cleanser formulated for oily and combination skin. Sulphate-free and tested under ophthalmological supervision.",
    pricePaisa: 285000,
    discountPricePaisa: 242250,
    discountPercentage: 15,
    stockQuantity: 40,
    ingredients: ["Aqua", "Sodium Cocoyl Isethionate", "Zinc PCA", "Niacinamide"],
    ingredientTags: ["NIACINAMIDE"],
    concernSlugs: ["oil-control", "acne"],
    climateTips:
      "In Bangladesh's humidity, rinse with lukewarm water only. Hot water strips the barrier and leaves skin oilier by midday. Pat dry rather than rubbing.",
    isBestSeller: true,
    image: "products/La Roche-Posay Effaclar Purifying Foaming Gel.jpg",
  },
  {
    name: "Bioderma Sensibio H2O Micellar Water",
    brand: "Bioderma",
    categorySlug: "cleansers",
    description:
      "A pH-5.5 micellar cleansing water that removes make-up and impurities while respecting the skin's natural barrier. No rinsing required.",
    pricePaisa: 265000,
    stockQuantity: 55,
    ingredients: ["Aqua", "Glycerin", "Poloxamer 184", "Zinc PCA"],
    ingredientTags: [],
    concernSlugs: ["sensitivity"],
    climateTips:
      "Keep the bottle in a cool, shaded place. Humidity plus heat accelerates formula degradation — never leave it in a parked car.",
    isNewArrival: true,
    image: "products/Bioderma Sensibio.jpg",
  },
  {
    name: "The Ordinary Niacinamide 10% + Zinc 1%",
    brand: "The Ordinary",
    categorySlug: "serums",
    description:
      "A high-strength niacinamide serum targeting excess oil, visible pores and uneven skin tone.",
    pricePaisa: 145000,
    stockQuantity: 60,
    ingredients: ["Aqua", "Niacinamide", "Zinc PCA", "Sodium Hyaluronate"],
    ingredientTags: ["NIACINAMIDE", "HYALURONIC_ACID"],
    concernSlugs: ["oil-control", "dullness", "texture"],
    climateTips:
      "Niacinamide works well in humid climates. Introduce it every other night for the first two weeks to avoid adjusting oil production.",
    isBestSeller: true,
    /*
      No photograph, deliberately.

      The shop's picture of this formula is keyed by the file name, which
      carries the **30ml** size — and the catalogue has a separate row
      for the 30ml bottle. Putting that picture on this row would show a
      shopper a bottle of a different size under this row's own name
      and price.

      So the photograph belongs to the row it was taken for, and this one
      keeps the placeholder.
    */
  },
  {
    name: "The Ordinary Ascorbyl Glucoside Solution 12%",
    brand: "The Ordinary",
    categorySlug: "serums",
    description:
      "A stabilised vitamin C derivative offering brightening and antioxidant protection without the irritation of pure ascorbic acid.",
    pricePaisa: 180000,
    discountPricePaisa: 162000,
    discountPercentage: 10,
    stockQuantity: 35,
    ingredients: ["Aqua", "Ascorbyl Glucoside", "Sodium Hyaluronate", "Tocopherol"],
    ingredientTags: ["VITAMIN_C", "HYALURONIC_ACID", "VITAMIN_E"],
    concernSlugs: ["dullness", "fine-lines"],
    climateTips:
      "Vitamin C oxidises in heat. Store below 25°C, use within 3 months of opening, and discard if the solution turns deep orange.",
    image: "products/The Ordinary Ascorbyl Glucoside Solution 12%.jpg",
  },
  {
    name: "La Roche-Posay Anthelios UVMune 400 Invisible Fluid SPF50+",
    brand: "La Roche-Posay",
    categorySlug: "sunscreens",
    description:
      "Ultra-light, invisible fluid with very high UVA protection (UVMune 400), developed for sun-sensitive skin.",
    pricePaisa: 420000,
    discountPricePaisa: 357000,
    discountPercentage: 15,
    stockQuantity: 30,
    ingredients: ["Aqua", "Tinosorb S", "Uvinul A Plus", "Vitamin E"],
    ingredientTags: ["SPF", "VITAMIN_E"],
    concernSlugs: ["protection"],
    climateTips:
      "Critical in Bangladesh: apply 15 minutes before going outdoors and reapply every 2 hours. A sunscreen that is not re-applied does nothing in 35°C heat.",
    isBestSeller: true,
    image:
      "products/La Roche-Posay Anthelios UVMune 400 Invisible Fluid SPF50+.jpg",
  },
  {
    name: "CeraVe Hydrating Facial Cleanser",
    brand: "CeraVe",
    categorySlug: "cleansers",
    description:
      "A non-foaming cleanser with three essential ceramides and hyaluronic acid, developed with dermatologists.",
    pricePaisa: 220000,
    stockQuantity: 45,
    ingredients: ["Aqua", "Glycerin", "Ceramide NP", "Sodium Hyaluronate"],
    ingredientTags: ["CERAMIDES", "HYALURONIC_ACID"],
    concernSlugs: ["dryness", "sensitivity"],
    climateTips:
      "In humid conditions, use this as your morning cleanser only. Over-cleansing twice daily is the most common cause of post-acne hyperpigmentation in Bangladeshi skin.",
    image: "products/CeraVe Hydrating Facial Cleanser.jpg",
  },
  {
    name: "Vichy Pureté Thermale 3-in-1 Micellar Milk",
    brand: "Vichy",
    categorySlug: "cleansers",
    description:
      "A gentle micellar milk that removes makeup, purifies and refreshes in a single step.",
    pricePaisa: 290000,
    stockQuantity: 28,
    ingredients: ["Aqua", "Glycerin", "Alcohol Denat.", "Perfume"],
    ingredientTags: ["ALCOHOL", "FRAGRANCE"],
    concernSlugs: ["sensitivity"],
    climateTips:
      "Contains alcohol, which can sting on broken skin. In humid weather, mist with a hydrating spray before removing makeup to reduce friction.",
    image: "products/Vichy Pureté Thermale 3-in-1 Micellar Milk.jpg",
  },
  {
    name: "The Ordinary Glycolic Acid 7% Toning Solution",
    brand: "The Ordinary",
    categorySlug: "serums",
    description:
      "An alpha hydroxy acid exfoliant for textural improvement, resurfacing and the reduction of the appearance of blemishes.",
    pricePaisa: 195000,
    stockQuantity: 32,
    ingredients: ["Aqua", "Glycolic Acid", "Sodium Hydroxide", "Glycerin"],
    ingredientTags: ["AHA"],
    concernSlugs: ["texture", "dullness"],
    climateTips:
      "AHAs increase sun sensitivity. In Bangladesh, use at night only, and never without daily sunscreen. Reduce frequency if your skin feels tight after application.",
    image: "products/The Ordinary Glycolic Acid 7% Toning Solution.jpg",
  },
  {
    name: "The Ordinary Salicylic Acid 2% Solution",
    brand: "The Ordinary",
    categorySlug: "serums",
    description:
      "A beta hydroxy acid solution for unclogging congested pores, with a high concentration of salicylic acid.",
    pricePaisa: 175000,
    stockQuantity: 38,
    ingredients: ["Aqua", "Salicylic Acid", "Glycerin", "Sodium Hydroxide"],
    ingredientTags: ["BHA"],
    concernSlugs: ["acne", "texture"],
    climateTips:
      "BHA is oil-soluble, which suits humid climates well. Start every other night and build up slowly.",
    image: "products/The Ordinary Salicylic Acid 2% Solution.jpg",
  },
  {
    name: "Neutrogena Retinol Boost Night Cream",
    brand: "Neutrogena",
    categorySlug: "serums",
    description:
      "A retinol night cream that works overnight to smooth the look of fine lines and improve skin texture.",
    pricePaisa: 380000,
    stockQuantity: 26,
    ingredients: ["Aqua", "Retinol", "Glycerin", "Cetearyl Alcohol", "Perfume"],
    ingredientTags: ["RETINOL", "FRAGRANCE"],
    concernSlugs: ["fine-lines", "texture"],
    climateTips:
      "Retinol increases sun sensitivity by up to 10x. Apply only at night, and never combine with AHAs in the same routine. In Bangladesh, this means strict sunscreen use the next morning.",
    image: "products/Neutrogena Retinol Boost Night Cream.jpg",
  },
  {
    name: "CeraVe Moisturising Cream",
    brand: "CeraVe",
    categorySlug: "moisturisers",
    description:
      "A rich, non-greasy moisturiser with ceramides and hyaluronic acid for 24-hour hydration.",
    pricePaisa: 260000,
    discountPricePaisa: 234000,
    discountPercentage: 10,
    stockQuantity: 50,
    ingredients: ["Aqua", "Glycerin", "Ceramide NP", "Petrolatum", "Sodium Hyaluronate"],
    ingredientTags: ["CERAMIDES", "HYALURONIC_ACID", "MINERAL_OIL"],
    concernSlugs: ["dryness", "sensitivity"],
    climateTips:
      "Humid air can make skin feel hydrated on the surface while dehydrated underneath. A ceramide cream seals that gap without feeling heavy.",
    isBestSeller: true,
    image: "products/CeraVe Moisturising Cream.jpg",
  },
  {
    name: "La Roche-Posay Cicaplast B5 Soothing Repair Balm",
    brand: "La Roche-Posay",
    categorySlug: "moisturisers",
    description:
      "A multi-purpose soothing balm for irritated skin, helping accelerate the recovery of compromised skin barriers.",
    pricePaisa: 340000,
    stockQuantity: 24,
    ingredients: ["Aqua", "Panthenol", "Madecassoside", "Zinc PCA"],
    ingredientTags: ["PANTHENOL", "CENTELLA", "NIACINAMIDE"],
    concernSlugs: ["redness", "sensitivity"],
    climateTips:
      "Excellent for post-sun exposure. Apply a thin layer after outdoor activity in high UV conditions.",
    image: "products/La Roche-Posay Cicaplast B5 Soothing Repair Balm.jpg",
  },
  {
    name: "Musta Makeup HIMALAYA LIP BAR",
    brand: "Musta Makeup",
    categorySlug: "lipsticks",
    description:
      "A long-wearing, matte lip colour with 8-hour staying power and 12 bold shades.",
    pricePaisa: 85000,
    discountPricePaisa: 68000,
    discountPercentage: 20,
    stockQuantity: 70,
    ingredients: ["Ricinus Communis Seed Oil", "Candelilla Wax", "Tocopherol", "CI 15850"],
    ingredientTags: ["VITAMIN_E", "COLOURANTS"],
    concernSlugs: [],
    climateTips:
      "High humidity softens matte formulas faster than usual. Blot with tissue before a second application to extend wear.",
    image: "products/Musta Makeup HIMALAYA LIP BAR.jpg",
  },
  {
    name: "Maybelline SuperStay Matte Ink",
    brand: "Maybelline",
    categorySlug: "lipsticks",
    description:
      "A high-pigment liquid matte ink with up to 12-hour wear and a precise applicator.",
    pricePaisa: 65000,
    stockQuantity: 80,
    ingredients: ["Isododecane", "Dimethicone", "Titanium Dioxide", "CI 15950"],
    ingredientTags: ["COLOURANTS"],
    concernSlugs: [],
    isNewArrival: true,
    image: "products/Maybelline SuperStay Matte Ink.jpg",
  },
  {
    name: "Musta Makeup All Matte Waterproof Foundation",
    brand: "Musta Makeup",
    categorySlug: "makeup",
    description:
      "A lightweight, waterproof matte foundation with SPF 17 for a natural, long-lasting finish.",
    pricePaisa: 95000,
    discountPricePaisa: 76000,
    discountPercentage: 20,
    stockQuantity: 65,
    ingredients: ["Aqua", "Cyclopentasiloxane", "Titanium Dioxide", "Talc", "Silica"],
    ingredientTags: ["TALC", "COLOURANTS", "SPF"],
    concernSlugs: ["protection"],
    climateTips:
      "Silicone-based formulas are heat-stable and perform well in high humidity. Set with a light powder to control midday shine.",
    isBestSeller: true,
    image: "products/Musta Makeup All Matte Waterproof Foundation.jpg",
  },
  {
    name: "Bioderma Atoderm Intensive Baume",
    brand: "Bioderma",
    categorySlug: "baby-care",
    description:
      "A rich, nourishing emollient for dry, irritated skin, suitable for infants and adults with sensitive skin.",
    pricePaisa: 320000,
    stockQuantity: 30,
    ingredients: ["Aqua", "Glycerin", "Shea Butter", "Cetearyl Alcohol", "Vitamin E"],
    ingredientTags: ["VITAMIN_E"],
    concernSlugs: ["dryness", "sensitivity"],
    climateTips:
      "Babies in Bangladesh lose moisture quickly in air-conditioned rooms. Apply after every nappy change and bath.",
    image: "products/Bioderma atoderm.jpg",
  },
  {
    name: "Musta Baby Gentle Foaming Shampoo & Wash",
    brand: "Musta Baby",
    categorySlug: "baby-care",
    description:
      "A tear-free, hypoallergenic shampoo and body wash for newborns and infants, free from parabens.",
    pricePaisa: 55000,
    stockQuantity: 75,
    ingredients: ["Aqua", "Glycerin", "Coco-Glucoside", "Panthenol", "Parfum"],
    ingredientTags: ["PANTHENOL", "FRAGRANCE"],
    concernSlugs: ["sensitivity"],
    climateTips:
      "Babies in the humid tropics need bathing more often, but daily bathing strips natural oils. Every other day is sufficient for most infants.",
    image: "products/Musta Baby Gentle Foaming Shampoo & Wash.jpg",
  },
  {
    name: "Vichy Dercos Anti-Dandruff Shampoo DS",
    brand: "Vichy",
    categorySlug: "hair-care",
    description:
      "A purifying anti-dandruff shampoo with selenium disulfide that targets the root cause of dandruff.",
    pricePaisa: 310000,
    stockQuantity: 34,
    ingredients: ["Aqua", "Selenium Disulfide", "Salicylic Acid", "Glycerin"],
    ingredientTags: ["BHA", "SALICYLIC_ACID"],
    concernSlugs: ["texture", "oil-control"],
    climateTips:
      "Scalp sweating accelerates dandruff in humid climates. Use the treatment shampoo twice weekly, and a gentle shampoo on other days.",
    image: "products/Vichy Dercos Anti-Dandruff Shampoo DS.jpg",
  },
  {
    name: "The Ordinary Niacinamide 10% + Zinc 1% — 30ml",
    brand: "The Ordinary",
    categorySlug: "serums",
    description:
      "A high-strength niacinamide and zinc formula for oil control and pore refinement.",
    pricePaisa: 110000,
    discountPricePaisa: 99000,
    discountPercentage: 10,
    stockQuantity: 40,
    ingredients: ["Aqua", "Niacinamide", "Zinc PCA"],
    ingredientTags: ["NIACINAMIDE"],
    concernSlugs: ["oil-control", "texture"],
    image: "products/The Ordinary Niacinamide 10% + Zinc 1% — 30ml.jpg",
  },
];

/**
 * The storage keys the **seed** owns.
 *
 * ── Why this set exists ──────────────────────────────────────────────────
 *
 * A picture an admin uploaded through the panel carries a key under a
 * dated scope — `products/2026/11/9f2c….webp` — because that is what
 * the upload endpoint mints. The seed's own pictures carry the **file
 * name** instead, because they are the shop's photographs that were
 * already on disk.
 *
 * So the two are told apart by shape, and that is what lets the seed
 * correct its own pictures on a re-seed while leaving an admin's alone.
 *
 * A row may also hold a **legacy absolute path** — the path on the
 * machine that uploaded it, written before the storage adapter existed.
 * That path is rewritten to the key it was pointing at before the
 * comparison, so a row the shop filled in by hand is still recognised as
 * the seed's own rather than mistaken for an admin's upload.
 */
const SEED_OWNED_IMAGE_KEYS: ReadonlySet<string> = new Set(
  PRODUCTS.map((product) => product.image).filter(
    (key): key is string => key !== undefined,
  ),
);

/**
 * Whether a stored picture is one the **seed** planted.
 */
function isSeedOwnedImage(key: string): boolean {
  const storageKey = legacyPathToStorageKey(key) ?? key;

  return SEED_OWNED_IMAGE_KEYS.has(storageKey);
}

const REVIEWS = [
  {
    productIndex: 0,
    rating: 5,
    comment:
      "Been using this for three weeks and my midday oiliness has genuinely reduced. No tightness after washing.",
    isApproved: true,
  },
  {
    productIndex: 4,
    rating: 5,
    comment:
      "The only sunscreen that does not leave a white cast on my skin. I reapply every two hours and there is no burn.",
    isApproved: true,
  },
  {
    productIndex: 8,
    rating: 4,
    comment:
      "Good retinol but I bought it without realising it conflicts with my glycolic acid. Now I use them on alternate nights.",
    isApproved: true,
  },
  {
    productIndex: 7,
    rating: 4,
    comment:
      "Good for texture but I got a mild reaction combining this with a retinol. Used separately it is excellent.",
    isApproved: true,
  },
  {
    productIndex: 11,
    rating: 5,
    comment:
      "The Civaplast B5 is a lifesaver in this weather. My skin stopped flaking within a week.",
    isApproved: true,
  },
  {
    productIndex: 14,
    rating: 4,
    comment:
      "Great staying power even in our humidity. I blot with tissue before reapplying and it lasts much longer.",
    isApproved: false,
  },
];

/**
 * The homepage hero banners.
 *
 * ── Why the seed writes them ─────────────────────────────────────────────
 *
 * The four campaigns that used to ship as a hard-coded array in
 * `src/components/home/hero-slides.ts` are the shop's real editorial
 * campaigns. Now that the carousel reads from the database, a shop with
 * no banners would show nothing — so the seed writes the same four
 * campaigns as **rows**, which means:
 *
 *   - the storefront is unchanged the moment the seed has run, and
 *   - the admin panel opens on real content rather than on an empty
 *     table, so the panel can be seen working.
 *
 * They are keyed by a **stable slug** in the id, so re-seeding updates
 * the same four rows rather than appending four more. An admin who has
 * edited a campaign's copy and then re-runs the seed will find their
 * copy overwritten — which is the seed's contract everywhere else in
 * this file, and the reason `prisma db seed` is a deliberate act.
 */
const HERO_BANNERS = [
  {
    id: "seed-hero-laroche-posay",
    eyebrow: "La Roche-Posay",
    title: "Derm-science for skin that reacts",
    body: "Anthelios UVMune 400, Effaclar and Cicaplast — the French pharmacy range, authorised and stocked locally. Prescription-strength actives without a prescription.",
    ctaLabel: "Shop La Roche-Posay",
    ctaHref: "/products?search=La%20Roche-Posay",
    secondaryCtaLabel: "Explore sunscreens",
    secondaryCtaHref: "/products?category=sunscreens",
    trust: ["Dermatologist tested", "Authenticity guaranteed"],
    gradient: "bg-[linear-gradient(135deg,#fff1f5_0%,#ffe4ed_38%,#ffffff_78%)]",
    glow: "bg-brand-300/50",
    isActive: true,
    sortOrder: 0,
  },
  {
    id: "seed-hero-cerave",
    eyebrow: "CeraVe",
    title: "Ceramides that your barrier recognises",
    body: "Three essential ceramides and hyaluronic acid in every formula. The cleanser and the moisturiser were designed to work together — so use them together.",
    ctaLabel: "Shop CeraVe",
    ctaHref: "/products?search=CeraVe",
    secondaryCtaLabel: "Find a cleanser",
    secondaryCtaHref: "/products?category=cleansers",
    trust: ["Developed with dermatologists", "Fragrance free"],
    gradient: "bg-[linear-gradient(135deg,#eff6ff_0%,#e0e7ff_40%,#ffffff_80%)]",
    glow: "bg-indigo-300/40",
    isActive: true,
    sortOrder: 1,
  },
  {
    id: "seed-hero-the-ordinary",
    eyebrow: "The Ordinary",
    title: "One active. One price. No theatre.",
    body: "Niacinamide 10%, Salicylic Acid 2%, Ascorbyl Glucoside 12% — the formulations the whole industry copies, sold without the markup.",
    ctaLabel: "Shop The Ordinary",
    ctaHref: "/products?search=The%20Ordinary",
    secondaryCtaLabel: "Browse all serums",
    secondaryCtaHref: "/products?category=serums",
    trust: ["Single-ingredient focus", "Ingredient-led formulas"],
    gradient: "bg-[linear-gradient(135deg,#f7f5f0_0%,#eceae4_45%,#ffffff_82%)]",
    glow: "bg-stone-300/50",
    isActive: true,
    sortOrder: 2,
  },
  {
    id: "seed-hero-advisor",
    eyebrow: "AI Skin Advisor",
    title: "Your routine, built for your skin",
    body: "A photo, four questions, and a routine that accounts for 35°C and 80% humidity — with ingredient conflicts checked before you check out.",
    ctaLabel: "Try the AI Skin Advisor",
    ctaHref: "/advisor",
    secondaryCtaLabel: "Shop all products",
    secondaryCtaHref: "/products",
    trust: ["Climate-aware guidance", "Conflict checking"],
    gradient: "bg-[linear-gradient(135deg,#fdf2f8_0%,#fce7f3_40%,#fff7fb_80%)]",
    glow: "bg-brand-400/45",
    isActive: true,
    sortOrder: 3,
  },
] as const;

async function main() {
  console.log("Seeding Euro Glam BD...\n");

  // ── Admin user ──────────────────────────────────────────────
  const adminEmail = (process.env.SEED_ADMIN_EMAIL ?? "admin@euroglambd.com").toLowerCase();
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? "ChangeMe123!";
  const adminName = process.env.SEED_ADMIN_NAME ?? "Euro Glam Admin";

  const passwordHash = await bcrypt.hash(adminPassword, 12);

  /*
   * The seeded accounts are created **verified**.
   *
   * Verification exists to prove the shop can reach the customer. The
   * seeded accounts are created by the operator, who has already
   * checked the address — and an admin who cannot receive mail cannot
   * be reached by the shop either.
   *
   * The timestamp is the seed run's own time, so the state is honest:
   * it says "verified", and it says when.
   */
  const verifiedAt = new Date();

  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {
      name: adminName,
      role: UserRole.ADMIN,
      passwordHash,
      emailVerifiedAt: verifiedAt,
    },
    create: {
      email: adminEmail,
      name: adminName,
      passwordHash,
      role: UserRole.ADMIN,
      emailVerifiedAt: verifiedAt,
    },
  });
  console.log(`  admin        ${admin.email}`);

  // ── Demo customer ───────────────────────────────────────────
  const customerEmail = "customer@euroglambd.com";
  const customer = await prisma.user.upsert({
    where: { email: customerEmail },
    update: { passwordHash, emailVerifiedAt: verifiedAt },
    create: {
      email: customerEmail,
      name: "Demo Customer",
      passwordHash,
      role: UserRole.CUSTOMER,
      emailVerifiedAt: verifiedAt,
    },
  });
  console.log(`  customer     ${customer.email}`);

  // ── Skin profile for the demo customer ──────────────────────
  await prisma.userSkinProfile.upsert({
    where: { userId: customer.id },
    update: {},
    create: {
      userId: customer.id,
      skinType: SkinType.COMBINATION,
      concerns: ["OILY_T_ZONE", "ACNE", "DULLNESS"],
    },
  });
  console.log(`  skin profile for customer`);

  // ── Categories ──────────────────────────────────────────────
  //
  // The `image` is **not** written by the seed — neither on create nor
  // on update. It is the admin's upload, and a seed that reset it would
  // silently wipe the card image of every category the shop has
  // decorated. A category's image starts empty and stays whatever the
  // admin chose.
  const categoryBySlug = new Map<string, string>();
  for (const category of CATEGORIES) {
    const row = await prisma.category.upsert({
      where: { slug: category.slug },
      update: { name: category.name },
      create: { name: category.name, slug: category.slug },
    });
    categoryBySlug.set(category.slug, row.id);
  }
  console.log(`  categories   ${CATEGORIES.length}`);

  // ── Brands ──────────────────────────────────────────────────
  //
  // Seeded from the brand registry, so the carousel's tiles and the
  // products' stored brands always agree. The `logo` is **not** written
  // — it is the admin's upload, and a trademarked logo requires
  // permission the shop holds, not the seed. A brand with no logo falls
  // back to its monogram.
  for (const brand of BRANDS) {
    await prisma.brand.upsert({
      where: { slug: brand.slug },
      update: {
        name: brand.name,
        monogram: brand.monogram,
        sortOrder: brand.sortOrder,
      },
      create: {
        name: brand.name,
        slug: brand.slug,
        monogram: brand.monogram,
        sortOrder: brand.sortOrder,
      },
    });
  }
  console.log(`  brands       ${BRANDS.length}`);

  // ── Skin concerns ───────────────────────────────────────────
  //
  // The `image` is **not** written — it is the admin's upload, and a
  // seed that reset it would wipe the card image of every decorated
  // concern. A concern without one falls back to the plain chip.
  for (const concern of CONCERNS) {
    await prisma.skinConcern.upsert({
      where: { slug: concern.slug },
      update: {
        name: concern.name,
        tag: concern.tag,
        relatedTags: concern.relatedTags,
      },
      create: {
        name: concern.name,
        slug: concern.slug,
        tag: concern.tag,
        relatedTags: concern.relatedTags,
      },
    });
  }
  console.log(`  concerns     ${CONCERNS.length}`);

  // ── Products ────────────────────────────────────────────────
  const productIds: string[] = [];
  for (const product of PRODUCTS) {
    const categoryId = categoryBySlug.get(product.categorySlug);
    if (!categoryId) {
      throw new Error(
        `Unknown category slug "${product.categorySlug}" for product "${product.name}"`,
      );
    }

    // Normalise the ingredient tags to canonical IDs.
    // `Object.entries` on a const-asserted record yields a union of readonly
    // tuple types, so `includes` would narrow to `never`. Flatten the map
    // into a plain lookup instead.
    const aliasToCanonical = new Map<string, string>();
    for (const [canonical, aliases] of Object.entries(INGREDIENT_TAGS)) {
      for (const alias of aliases as readonly string[]) {
        aliasToCanonical.set(alias, canonical);
      }
    }

    const tagSet = new Set<string>();
    for (const tag of product.ingredientTags) {
      const canonical = aliasToCanonical.get(tag);
      if (canonical) {
        tagSet.add(canonical);
      }
    }

    // The product's **natural key** is its name. The `Product` table
    // has no unique column the seed could key on — the id is a cuid,
    // which changes on every run — so the name is what makes the seed
    // idempotent.
    //
    // It has to be idempotent. The file's own header says the seed is
    // "safe to run repeatedly", and it was — until the products were
    // created with `create` rather than looked up first. Every run then
    // doubled the catalogue: nineteen products became thirty-eight, and
    // the storefront showed every product twice.
    //
    // A `findFirst` + `create`/`update` is used rather than `upsert`,
    // because `upsert` needs a **unique** column and `Product.name` is
    // not one — two products may legitimately share a name. Adding a
    // unique constraint to the name would change what a product *is*
    // in the database, which is a bigger decision than a seed needs to
    // make.
    //
    // The lookup prefers a **live** row, and only falls back to an
    // archived one when there is no live row with that name.
    //
    // This matters because the storefront **hides archived products**. A
    // shop can hold an archived "The Ordinary Glycolic Acid" and a live
    // one of the same name — an admin withdrew the first and added the
    // second — and the seed must land on the live one. Matching the
    // oldest row regardless of its archive state meant the seed wrote
    // its catalogue fields (its brand, its concern slugs) onto a
    // withdrawn product and left the live one untagged, so the concern
    // browse pages came up empty for products the seed had plainly
    // tagged.
    //
    // The update writes the catalogue fields — including the **brand**,
    // so a seed that adds a brand column does not need a second
    // migration to backfill it. It deliberately leaves `stockQuantity`
    // alone: the stock is the shop's live state, not the seed's, and a
    // reseed must not hand a customer's reserved unit back onto the
    // shelf.
    /*
      The product's skin concerns.

      The slugs are checked against the seed's own concern vocabulary,
      for the same reason the ingredient tags are canonicalised: a slug
      that is not in the `SkinConcern` table would put the product on a
      browse page that does not exist, and the storefront's browse pages
      are built from that table.

      So a typo here is a **hard error**, not a silent drop. A seed that
      quietly dropped an unknown slug would leave the admin looking at a
      product that is missing from a page they had tagged it for, with
      no indication that anything went wrong.
    */
    const knownConcernSlugs = new Set(CONCERNS.map((concern) => concern.slug));

    for (const slug of product.concernSlugs ?? []) {
      if (!knownConcernSlugs.has(slug)) {
        throw new Error(
          `Unknown concern slug "${slug}" for product "${product.name}". ` +
            `Known slugs: ${Array.from(knownConcernSlugs).join(", ")}.`,
        );
      }
    }

    const catalogueFields = {
      description: product.description,
      brand: product.brand,
      categoryId,
      pricePaisa: product.pricePaisa,
      discountPricePaisa: product.discountPricePaisa ?? null,
      discountPercentage: product.discountPercentage ?? null,
      ingredientTags: Array.from(tagSet),
      concernSlugs: product.concernSlugs ?? [],
      climateTips: product.climateTips ?? null,
      isNewArrival: product.isNewArrival ?? false,
      isBestSeller: product.isBestSeller ?? false,
    };

    const existing = await prisma.product.findFirst({
      where: { name: product.name, archivedAt: null },
      select: { id: true, images: true },
      orderBy: { createdAt: "asc" },
    });

    /*
      No live row with this name — so either the product is genuinely
      new, or every row of that name has been withdrawn. The seed
      creates a **live** one in the first case, which is right; and in
      the second case it creates a live one too, which is also right:
      a withdrawn product is not in the catalogue, and the catalogue is
      what the seed is describing.

      (It does not *restore* the archived row. An archived product is
      withdrawn deliberately, and a seed that un-withdrew it would put
      a discontinued product back on the shelf without anyone asking.)
    */

    /*
      The photograph.

      On a **new** row the seed names the key. On an **existing** row it
      only touches the picture when the picture is one **the seed itself
      planted** — because a picture an admin uploaded is the admin's,
      and a re-seed that overwrote it would quietly undo their work. The
      seed's contract is "this is the catalogue"; it is not "the
      catalogue's pictures are the only pictures".

      So the rule is:

        • the row has no picture            → the seed's picture is used
        • the row has the seed's own picture → the seed's picture wins
          (the seed's catalogue changed, and the row follows it)
        • the row has an admin's picture     → it is left alone

      A row whose picture came from the upload endpoint has a key under
      a dated scope (`products/2026/11/…`), which is how the seed tells
      an admin's picture from its own.

      "The seed's picture wins" includes **no** picture. When the seed
      stops naming a photograph for a row, a picture the seed itself
      planted is cleared — so the catalogue and the seed cannot drift
      apart. An admin's picture is never cleared.

      One consequence is worth stating plainly. The shop's photographs
      are keyed by **file name**, and two catalogue rows can share one
      file — "The Ordinary Niacinamide 10% + Zinc 1%" and "…— 30ml" are
      the same formula in two sizes, and there is one photograph of it.
      The seed gives the photograph to the row it was taken for, and the
      other keeps the placeholder rather than showing a picture of a
      different bottle size under its own name and price. A wrong
      picture is worse than no picture.
    */
    const seededImages = product.image ? [product.image] : [];

    const pictureIsTheSeedsOwn =
      existing !== null && existing.images.every(isSeedOwnedImage);

    const row = existing
      ? await prisma.product.update({
          where: { id: existing.id },
          data: {
            ...catalogueFields,
            ...(pictureIsTheSeedsOwn ? { images: seededImages } : {}),
          },
        })
      : await prisma.product.create({
          data: {
            name: product.name,
            ...catalogueFields,
            stockQuantity: product.stockQuantity,
            ingredients: {
              ingredients: product.ingredients,
              source: "Manufacturer label",
            },
            images: seededImages,
          },
        });
    productIds.push(row.id);
  }
  console.log(`  products     ${PRODUCTS.length}`);

  // ── Reviews ─────────────────────────────────────────────────
  for (const review of REVIEWS) {
    const productId = productIds[review.productIndex];
    if (!productId) continue;
    const existing = await prisma.review.findFirst({
      where: { productId, userId: customer.id, comment: review.comment },
    });
    if (!existing) {
      await prisma.review.create({
        data: {
          productId,
          userId: customer.id,
          rating: review.rating,
          comment: review.comment,
          isApproved: review.isApproved,
        },
      });
    }
  }
  console.log(`  reviews      ${REVIEWS.length}`);

  // ── AI config (single row) ──────────────────────────────────
  const disclaimerText =
    process.env.DISCLAIMER_TEXT ??
    "This is an aesthetic/skincare suggestion, not a medical prescription from a doctor.";

  await prisma.aiConfig.upsert({
    where: { key: "default" },
    update: {},
    create: {
      key: "default",
      disclaimerText,
      disclaimerVersion: 1,
      enforceCartConflicts: true,
    },
  });
  console.log(`  ai config    default (disclaimer v1)`);

  // ── Site settings (single row) ──────────────────────────────
  //
  // The announcement marquee's switch and its text.
  //
  // The row is created with the **safe** defaults — the marquee off,
  // with no text — because an announcement with nothing to say is a
  // strip of coloured nothing at the top of every page.
  //
  // And the `update` is **empty**: a re-seed must never overwrite what
  // the admin has written. The seed establishes the row's *existence*;
  // the announcement is the admin's, and re-seeding the catalogue is
  // not a reason to unpublish the shop's own message. This is the same
  // rule the seed already follows for the discovery imagery — the
  // `image` / `logo` columns are not written by the seed, so a re-seed
  // cannot destroy a decorated category, concern or brand.
  await prisma.siteSettings.upsert({
    where: { key: "default" },
    update: {},
    create: {
      key: "default",
      isMarqueeEnabled: false,
      marqueeText: "",
      marqueeHref: null,
      marqueeBgColor: "#1c1917",
      marqueeTextColor: "#ffffff",
      supportEmail: "",
      supportPhone: "",
      supportHours: "",
      storeAddress: "",
    },
  });
  console.log(`  settings     default (marquee off)`);

  // ── Homepage hero banners ─────────────────────────────────
  //
  // The four campaigns that used to be a hard-coded array. They are
  // keyed by a stable id, so a re-seed updates the same four rows.
  for (const banner of HERO_BANNERS) {
    await prisma.heroBanner.upsert({
      where: { id: banner.id },
      update: {
        eyebrow: banner.eyebrow,
        title: banner.title,
        body: banner.body,
        ctaLabel: banner.ctaLabel,
        ctaHref: banner.ctaHref,
        secondaryCtaLabel: banner.secondaryCtaLabel,
        secondaryCtaHref: banner.secondaryCtaHref,
        trust: [...banner.trust],
        gradient: banner.gradient,
        glow: banner.glow,
        isActive: banner.isActive,
        sortOrder: banner.sortOrder,
      },
      create: {
        id: banner.id,
        eyebrow: banner.eyebrow,
        title: banner.title,
        body: banner.body,
        ctaLabel: banner.ctaLabel,
        ctaHref: banner.ctaHref,
        secondaryCtaLabel: banner.secondaryCtaLabel,
        secondaryCtaHref: banner.secondaryCtaHref,
        trust: [...banner.trust],
        image: null,
        gradient: banner.gradient,
        glow: banner.glow,
        isActive: banner.isActive,
        sortOrder: banner.sortOrder,
      },
    });
  }
  console.log(`  hero banners ${HERO_BANNERS.length}`);

  console.log("\nSeed complete.");
  console.log(`\n  Admin login:    ${adminEmail} / ${adminPassword}`);
  console.log(`  Customer login: ${customerEmail} / ${adminPassword}\n`);
}

main()
  .catch((error) => {
    console.error("\nSeed failed:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
