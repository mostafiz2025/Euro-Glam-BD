import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  images: {
    /**
     * The remote images the optimiser is allowed to fetch.
     *
     * `next/image` **throws** — it does not warn, and it does not fall
     * back — when a remote image's hostname is not listed here. The
     * error is `Invalid src prop … hostname "res.cloudinary.com" is
     * not configured under images in your next.config.js`, and because
     * it is thrown during the render it takes the whole page with it,
     * not just the one picture. The `onError` fallback in
     * `ProductImage` cannot catch it: the component never renders.
     *
     * The pattern is scoped to the project's own Cloudinary folder.
     * A bare `hostname` entry would allow the optimiser to be pointed
     * at *any* image on Cloudinary's CDN, which is an open proxy for
     * somebody else's traffic. Scoping to the folder means the
     * optimiser will only ever fetch this shop's own uploads.
     */
    remotePatterns: [
      {
        protocol: "https",
        hostname: "res.cloudinary.com",
        pathname: "/**/euro-glam-bd/**",
      },
    ],
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
