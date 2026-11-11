import type { NextConfig } from "next";

/**
 * The Cloudinary delivery host.
 *
 * Cloudinary serves every account's assets from the same host, with the
 * account's cloud name as the first path segment. So the pattern is
 * fixed and only the cloud name varies — which is why it is read from
 * the environment rather than written out.
 */
const cloudinaryCloudName = process.env.CLOUDINARY_CLOUD_NAME?.trim();

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  images: {
    /**
     * The remote hosts `next/image` is allowed to optimise.
     *
     * ── Why Cloudinary has to be here ─────────────────────────────────
     *
     * `next/image` refuses to optimise an image from a host it has not
     * been told about. The error is a runtime one — "hostname … is not
     * configured under images in next.config.js" — and the image renders
     * as a broken element rather than as a picture.
     *
     * So the Cloudinary host is allow-listed whenever the deployment is
     * configured to use Cloudinary. The pattern matches the whole
     * `res.cloudinary.com` host, with the cloud name as a path segment
     * that is validated against the environment.
     *
     * The local driver needs no entry: `/uploads/…` is a **relative**
     * path, so it is served by the app itself and never goes through the
     * remote optimiser.
     */
    remotePatterns: cloudinaryCloudName
      ? [
          {
            protocol: "https",
            hostname: "res.cloudinary.com",
            pathname: `/${cloudinaryCloudName}/**`,
          },
        ]
      : [],
  },
};

export default nextConfig;
