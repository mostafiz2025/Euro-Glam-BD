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

type SeedProduct = {
  name: string;
  categorySlug: string;
  description: string;
  pricePaisa: number;
  discountPricePaisa?: number;
  discountPercentage?: number;
  stockQuantity: number;
  ingredients: string[];
  ingredientTags: string[];
  climateTips?: string;
  isNewArrival?: boolean;
  isBestSeller?: boolean;
};

const PRODUCTS: SeedProduct[] = [
  {
    name: "La Roche-Posay Effaclar Purifying Foaming Gel",
    categorySlug: "cleansers",
    description:
      "A gentle, non-stripping foaming cleanser formulated for oily and combination skin. Sulphate-free and tested under ophthalmological supervision.",
    pricePaisa: 285000,
    discountPricePaisa: 242250,
    discountPercentage: 15,
    stockQuantity: 40,
    ingredients: ["Aqua", "Sodium Cocoyl Isethionate", "Zinc PCA", "Niacinamide"],
    ingredientTags: ["NIACINAMIDE"],
    climateTips:
      "In Bangladesh's humidity, rinse with lukewarm water only. Hot water strips the barrier and leaves skin oilier by midday. Pat dry rather than rubbing.",
    isBestSeller: true,
  },
  {
    name: "Bioderma Sensibio H2O Micellar Water",
    categorySlug: "cleansers",
    description:
      "A pH-5.5 micellar cleansing water that removes make-up and impurities while respecting the skin's natural barrier. No rinsing required.",
    pricePaisa: 265000,
    stockQuantity: 55,
    ingredients: ["Aqua", "Glycerin", "Poloxamer 184", "Zinc PCA"],
    ingredientTags: [],
    climateTips:
      "Keep the bottle in a cool, shaded place. Humidity plus heat accelerates formula degradation — never leave it in a parked car.",
    isNewArrival: true,
  },
  {
    name: "The Ordinary Niacinamide 10% + Zinc 1%",
    categorySlug: "serums",
    description:
      "A high-strength niacinamide serum targeting excess oil, visible pores and uneven skin tone.",
    pricePaisa: 145000,
    stockQuantity: 60,
    ingredients: ["Aqua", "Niacinamide", "Zinc PCA", "Sodium Hyaluronate"],
    ingredientTags: ["NIACINAMIDE", "HYALURONIC_ACID"],
    climateTips:
      "Niacinamide works well in humid climates. Introduce it every other night for the first two weeks to avoid adjusting oil production.",
    isBestSeller: true,
  },
  {
    name: "The Ordinary Ascorbyl Glucoside Solution 12%",
    categorySlug: "serums",
    description:
      "A stabilised vitamin C derivative offering brightening and antioxidant protection without the irritation of pure ascorbic acid.",
    pricePaisa: 180000,
    discountPricePaisa: 162000,
    discountPercentage: 10,
    stockQuantity: 35,
    ingredients: ["Aqua", "Ascorbyl Glucoside", "Sodium Hyaluronate", "Tocopherol"],
    ingredientTags: ["VITAMIN_C", "HYALURONIC_ACID", "VITAMIN_E"],
    climateTips:
      "Vitamin C oxidises in heat. Store below 25°C, use within 3 months of opening, and discard if the solution turns deep orange.",
  },
  {
    name: "La Roche-Posay Anthelios UVMune 400 Invisible Fluid SPF50+",
    categorySlug: "sunscreens",
    description:
      "Ultra-light, invisible fluid with very high UVA protection (UVMune 400), developed for sun-sensitive skin.",
    pricePaisa: 420000,
    discountPricePaisa: 357000,
    discountPercentage: 15,
    stockQuantity: 30,
    ingredients: ["Aqua", "Tinosorb S", "Uvinul A Plus", "Vitamin E"],
    ingredientTags: ["SPF", "VITAMIN_E"],
    climateTips:
      "Critical in Bangladesh: apply 15 minutes before going outdoors and reapply every 2 hours. A sunscreen that is not re-applied does nothing in 35°C heat.",
    isBestSeller: true,
  },
  {
    name: "CeraVe Hydrating Facial Cleanser",
    categorySlug: "cleansers",
    description:
      "A non-foaming cleanser with three essential ceramides and hyaluronic acid, developed with dermatologists.",
    pricePaisa: 220000,
    stockQuantity: 45,
    ingredients: ["Aqua", "Glycerin", "Ceramide NP", "Sodium Hyaluronate"],
    ingredientTags: ["CERAMIDES", "HYALURONIC_ACID"],
    climateTips:
      "In humid conditions, use this as your morning cleanser only. Over-cleansing twice daily is the most common cause of post-acne hyperpigmentation in Bangladeshi skin.",
  },
  {
    name: "Vichy Pureté Thermale 3-in-1 Micellar Milk",
    categorySlug: "cleansers",
    description:
      "A gentle micellar milk that removes makeup, purifies and refreshes in a single step.",
    pricePaisa: 290000,
    stockQuantity: 28,
    ingredients: ["Aqua", "Glycerin", "Alcohol Denat.", "Perfume"],
    ingredientTags: ["ALCOHOL", "FRAGRANCE"],
    climateTips:
      "Contains alcohol, which can sting on broken skin. In humid weather, mist with a hydrating spray before removing makeup to reduce friction.",
  },
  {
    name: "The Ordinary Glycolic Acid 7% Toning Solution",
    categorySlug: "serums",
    description:
      "An alpha hydroxy acid exfoliant for textural improvement, resurfacing and the reduction of the appearance of blemishes.",
    pricePaisa: 195000,
    stockQuantity: 32,
    ingredients: ["Aqua", "Glycolic Acid", "Sodium Hydroxide", "Glycerin"],
    ingredientTags: ["AHA"],
    climateTips:
      "AHAs increase sun sensitivity. In Bangladesh, use at night only, and never without daily sunscreen. Reduce frequency if your skin feels tight after application.",
  },
  {
    name: "The Ordinary Salicylic Acid 2% Solution",
    categorySlug: "serums",
    description:
      "A beta hydroxy acid solution for unclogging congested pores, with a high concentration of salicylic acid.",
    pricePaisa: 175000,
    stockQuantity: 38,
    ingredients: ["Aqua", "Salicylic Acid", "Glycerin", "Sodium Hydroxide"],
    ingredientTags: ["BHA"],
    climateTips:
      "BHA is oil-soluble, which suits humid climates well. Start every other night and build up slowly.",
  },
  {
    name: "Neutrogena Retinol Boost Night Cream",
    categorySlug: "serums",
    description:
      "A retinol night cream that works overnight to smooth the look of fine lines and improve skin texture.",
    pricePaisa: 380000,
    stockQuantity: 26,
    ingredients: ["Aqua", "Retinol", "Glycerin", "Cetearyl Alcohol", "Perfume"],
    ingredientTags: ["RETINOL", "FRAGRANCE"],
    climateTips:
      "Retinol increases sun sensitivity by up to 10x. Apply only at night, and never combine with AHAs in the same routine. In Bangladesh, this means strict sunscreen use the next morning.",
  },
  {
    name: "CeraVe Moisturising Cream",
    categorySlug: "moisturisers",
    description:
      "A rich, non-greasy moisturiser with ceramides and hyaluronic acid for 24-hour hydration.",
    pricePaisa: 260000,
    discountPricePaisa: 234000,
    discountPercentage: 10,
    stockQuantity: 50,
    ingredients: ["Aqua", "Glycerin", "Ceramide NP", "Petrolatum", "Sodium Hyaluronate"],
    ingredientTags: ["CERAMIDES", "HYALURONIC_ACID", "MINERAL_OIL"],
    climateTips:
      "Humid air can make skin feel hydrated on the surface while dehydrated underneath. A ceramide cream seals that gap without feeling heavy.",
    isBestSeller: true,
  },
  {
    name: "La Roche-Posay Cicaplast B5 Soothing Repair Balm",
    categorySlug: "moisturisers",
    description:
      "A multi-purpose soothing balm for irritated skin, helping accelerate the recovery of compromised skin barriers.",
    pricePaisa: 340000,
    stockQuantity: 24,
    ingredients: ["Aqua", "Panthenol", "Madecassoside", "Zinc PCA"],
    ingredientTags: ["PANTHENOL", "CENTELLA", "NIACINAMIDE"],
    climateTips:
      "Excellent for post-sun exposure. Apply a thin layer after outdoor activity in high UV conditions.",
  },
  {
    name: "Musta Makeup HIMALAYA LIP BAR",
    categorySlug: "lipsticks",
    description:
      "A long-wearing, matte lip colour with 8-hour staying power and 12 bold shades.",
    pricePaisa: 85000,
    discountPricePaisa: 68000,
    discountPercentage: 20,
    stockQuantity: 70,
    ingredients: ["Ricinus Communis Seed Oil", "Candelilla Wax", "Tocopherol", "CI 15850"],
    ingredientTags: ["VITAMIN_E", "COLOURANTS"],
    climateTips:
      "High humidity softens matte formulas faster than usual. Blot with tissue before a second application to extend wear.",
  },
  {
    name: "Maybelline SuperStay Matte Ink",
    categorySlug: "lipsticks",
    description:
      "A high-pigment liquid matte ink with up to 12-hour wear and a precise applicator.",
    pricePaisa: 65000,
    stockQuantity: 80,
    ingredients: ["Isododecane", "Dimethicone", "Titanium Dioxide", "CI 15950"],
    ingredientTags: ["COLOURANTS"],
    isNewArrival: true,
  },
  {
    name: "Musta Makeup All Matte Waterproof Foundation",
    categorySlug: "makeup",
    description:
      "A lightweight, waterproof matte foundation with SPF 17 for a natural, long-lasting finish.",
    pricePaisa: 95000,
    discountPricePaisa: 76000,
    discountPercentage: 20,
    stockQuantity: 65,
    ingredients: ["Aqua", "Cyclopentasiloxane", "Titanium Dioxide", "Talc", "Silica"],
    ingredientTags: ["TALC", "COLOURANTS", "SPF"],
    climateTips:
      "Silicone-based formulas are heat-stable and perform well in high humidity. Set with a light powder to control midday shine.",
    isBestSeller: true,
  },
  {
    name: "Bioderma Atoderm Intensive Baume",
    categorySlug: "baby-care",
    description:
      "A rich, nourishing emollient for dry, irritated skin, suitable for infants and adults with sensitive skin.",
    pricePaisa: 320000,
    stockQuantity: 30,
    ingredients: ["Aqua", "Glycerin", "Shea Butter", "Cetearyl Alcohol", "Vitamin E"],
    ingredientTags: ["VITAMIN_E"],
    climateTips:
      "Babies in Bangladesh lose moisture quickly in air-conditioned rooms. Apply after every nappy change and bath.",
  },
  {
    name: "Musta Baby Gentle Foaming Shampoo & Wash",
    categorySlug: "baby-care",
    description:
      "A tear-free, hypoallergenic shampoo and body wash for newborns and infants, free from parabens.",
    pricePaisa: 55000,
    stockQuantity: 75,
    ingredients: ["Aqua", "Glycerin", "Coco-Glucoside", "Panthenol", "Parfum"],
    ingredientTags: ["PANTHENOL", "FRAGRANCE"],
    climateTips:
      "Babies in the humid tropics need bathing more often, but daily bathing strips natural oils. Every other day is sufficient for most infants.",
  },
  {
    name: "Vichy Dercos Anti-Dandruff Shampoo DS",
    categorySlug: "hair-care",
    description:
      "A purifying anti-dandruff shampoo with selenium disulfide that targets the root cause of dandruff.",
    pricePaisa: 310000,
    stockQuantity: 34,
    ingredients: ["Aqua", "Selenium Disulfide", "Salicylic Acid", "Glycerin"],
    ingredientTags: ["BHA", "SALICYLIC_ACID"],
    climateTips:
      "Scalp sweating accelerates dandruff in humid climates. Use the treatment shampoo twice weekly, and a gentle shampoo on other days.",
  },
  {
    name: "The Ordinary Niacinamide 10% + Zinc 1% — 30ml",
    categorySlug: "serums",
    description:
      "A high-strength niacinamide and zinc formula for oil control and pore refinement.",
    pricePaisa: 110000,
    discountPricePaisa: 99000,
    discountPercentage: 10,
    stockQuantity: 40,
    ingredients: ["Aqua", "Niacinamide", "Zinc PCA"],
    ingredientTags: ["NIACINAMIDE"],
  },
];

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

async function main() {
  console.log("Seeding Euro Glam BD...\n");

  // ── Admin user ──────────────────────────────────────────────
  const adminEmail = (process.env.SEED_ADMIN_EMAIL ?? "admin@euroglambd.com").toLowerCase();
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? "ChangeMe123!";
  const adminName = process.env.SEED_ADMIN_NAME ?? "Euro Glam Admin";

  const passwordHash = await bcrypt.hash(adminPassword, 12);

  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: { name: adminName, role: UserRole.ADMIN, passwordHash },
    create: {
      email: adminEmail,
      name: adminName,
      passwordHash,
      role: UserRole.ADMIN,
    },
  });
  console.log(`  admin        ${admin.email}`);

  // ── Demo customer ───────────────────────────────────────────
  const customerEmail = "customer@euroglambd.com";
  const customer = await prisma.user.upsert({
    where: { email: customerEmail },
    update: { passwordHash },
    create: {
      email: customerEmail,
      name: "Demo Customer",
      passwordHash,
      role: UserRole.CUSTOMER,
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

    const row = await prisma.product.create({
      data: {
        name: product.name,
        description: product.description,
        categoryId,
        pricePaisa: product.pricePaisa,
        discountPricePaisa: product.discountPricePaisa ?? null,
        discountPercentage: product.discountPercentage ?? null,
        stockQuantity: product.stockQuantity,
        ingredients: {
          ingredients: product.ingredients,
          source: "Manufacturer label",
        },
        ingredientTags: Array.from(tagSet),
        climateTips: product.climateTips ?? null,
        images: [],
        isNewArrival: product.isNewArrival ?? false,
        isBestSeller: product.isBestSeller ?? false,
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
