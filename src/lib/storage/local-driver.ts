import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { MIME_TYPE_EXTENSIONS } from "@/lib/upload/validate";

import {
  StorageError,
  isStorageScope,
  type PutInput,
  type StorageAdapter,
  type StoredObject,
} from "./adapter";

/**
 * The local filesystem storage driver.
 *
 * ── Design notes ─────────────────────────────────────────────────────────
 *
 * • **The filename is generated, never derived from user input.** A key
 *   looks like `advisor/2026/10/9f2c1a7b….webp`. The random part is 16
 *   bytes of CSPRNG output rendered as 32 hex characters — 128 bits of
 *   entropy, so two uploads can never collide and the name cannot be
 *   guessed. The extension is chosen from the **detected** MIME type, never
 *   from the client's filename.
 *
 * • **The path is asserted to be inside the upload root.** Every resolved
 *   path is checked against the resolved root before it is read or
 *   written. This is the second line of defence behind the generated
 *   filename: even a crafted key like `../../etc/passwd` cannot escape.
 *
 * • **`delete()` is idempotent.** The cleanup job calls it repeatedly for
 *   keys it has already tried to remove. An absent file is a success.
 *
 * • **This module requires the Node runtime.** It uses `node:fs` and
 *   `Buffer`, so it must never be imported from the Edge proxy.
 */

/**
 * The default upload root, relative to the project root.
 */
export const DEFAULT_UPLOAD_ROOT = "./public/uploads";

/**
 * The URL prefix the local driver serves uploads under.
 *
 * `public/uploads` is served by Next.js at `/uploads/…`, and the proxy
 * already excludes that prefix from its auth matcher.
 */
export const LOCAL_URL_PREFIX = "/uploads";

/**
 * The number of random bytes in a generated filename.
 *
 * 16 bytes = 128 bits of entropy, rendered as 32 hex characters.
 */
const RANDOM_BYTES = 16;

/**
 * Options for the local driver.
 */
export type LocalDriverOptions = {
  /**
   * The root directory uploads are written under.
   *
   * Defaults to `UPLOAD_ROOT` from the environment, then to
   * `./public/uploads`.
   */
  root?: string;
  /**
   * The URL prefix used by `getUrl()`.
   *
   * Defaults to `/uploads`. A deployment serving the files from a CDN
   * would override this without touching any call site.
   */
  urlPrefix?: string;
};

/**
 * Resolves the upload root.
 *
 * The root is resolved to an absolute path once, at construction, so every
 * later comparison is between two absolute paths. Comparing a relative
 * path against an absolute one is a classic source of traversal bugs.
 *
 * ── The `turbopackIgnore` comment ───────────────────────────────────────
 *
 * Turbopack's static analysis sees `path.resolve(process.cwd(), configured)`
 * and concludes that resolving an arbitrary path at runtime would force it
 * to trace **the whole project** into the server bundle — every source
 * file, and the `public` folder with it. That is a real cost: it bloats
 * the deployment and can push it past a size limit.
 *
 * But the analysis is wrong here, and the reason is worth writing down.
 * `configured` is not an arbitrary path — it is one of three values:
 * the `root` option passed to the constructor, the `UPLOAD_ROOT`
 * environment variable, or `./public/uploads`. In every case it names a
 * **directory the server writes to**, not a directory it reads source
 * from. Resolving it does not cause the bundler to include anything:
 * the upload root is written at runtime and served as static assets,
 * and nothing in the server bundle depends on its contents.
 *
 * The comment opts this one call out of the analysis. Everything else in
 * the file is unchanged.
 */
function resolveRoot(root?: string): string {
  const configured = root ?? process.env.UPLOAD_ROOT ?? DEFAULT_UPLOAD_ROOT;

  return path.resolve(
    /* turbopackIgnore: true */
    process.cwd(),
    configured,
  );
}

/**
 * The local filesystem driver.
 */
export class LocalStorageDriver implements StorageAdapter {
  private readonly root: string;
  private readonly urlPrefix: string;

  constructor(options: LocalDriverOptions = {}) {
    this.root = resolveRoot(options.root);
    this.urlPrefix = (
      options.urlPrefix ??
      process.env.STORAGE_URL_PREFIX ??
      LOCAL_URL_PREFIX
    ).replace(/\/+$/, "");
  }

  /**
   * The resolved upload root.
   *
   * Exposed for diagnostics and for the path-safety tests.
   */
  get uploadRoot(): string {
    return this.root;
  }

  /**
   * Writes an object and returns its key.
   *
   * @throws StorageError when the scope is not allowed, the MIME type has
   *         no known extension, or the write fails.
   */
  async put(input: PutInput): Promise<StoredObject> {
    const scope = input.scope.trim().toLowerCase();

    if (!isStorageScope(scope)) {
      throw new StorageError(
        "INVALID_SCOPE",
        `"${input.scope}" is not a valid storage scope.`,
      );
    }

    const extension = MIME_TYPE_EXTENSIONS[
      input.mimeType as keyof typeof MIME_TYPE_EXTENSIONS
    ];

    if (!extension) {
      throw new StorageError(
        "UNSUPPORTED_MIME_TYPE",
        `No file extension is defined for the MIME type "${input.mimeType}".`,
      );
    }

    const now = new Date();
    const year = String(now.getUTCFullYear()).padStart(4, "0");
    const month = String(now.getUTCMonth() + 1).padStart(2, "0");

    const random = randomBytes(RANDOM_BYTES).toString("hex");

    const key = `${scope}/${year}/${month}/${random}.${extension}`;

    const absolutePath = this.resolveKeyPath(key);

    try {
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, input.bytes, { flag: "wx" });
    } catch (error) {
      throw new StorageError(
        "WRITE_FAILED",
        `Could not write the file to storage (key: ${key}).`,
        error,
      );
    }

    return {
      key,
      byteSize: input.bytes.length,
      mimeType: input.mimeType,
    };
  }

  /**
   * Deletes an object.
   *
   * Idempotent: deleting a key that does not exist resolves successfully.
   */
  async delete(key: string): Promise<void> {
    const absolutePath = this.resolveKeyPath(key);

    try {
      await rm(absolutePath, { force: true });
    } catch (error) {
      // With the force option, a missing file is not an error - only a
      // permissions or I/O problem reaches this block.
      throw new StorageError(
        "READ_FAILED",
        `Could not delete the stored object (key: ${key}).`,
        error,
      );
    }
  }

  /**
   * Returns the public URL for a key.
   */
  getUrl(key: string): string {
    return `${this.urlPrefix}/${key}`;
  }

  /**
   * Returns true when the object exists on disk.
   */
  async exists(key: string): Promise<boolean> {
    const absolutePath = this.resolveKeyPath(key);

    try {
      const stats = await stat(absolutePath);
      return stats.isFile();
    } catch {
      return false;
    }
  }

  /**
   * Reads an object back.
   *
   * Not part of the `StorageAdapter` interface — the application serves
   * uploads through the static directory, not through a read API. It
   * exists for the round-trip verification script and for tests.
   */
  async read(key: string): Promise<Buffer> {
    const absolutePath = this.resolveKeyPath(key);

    try {
      return await readFile(absolutePath);
    } catch (error) {
      throw new StorageError(
        "READ_FAILED",
        `Could not read the stored object (key: ${key}).`,
        error,
      );
    }
  }

  /**
   * Resolves a key to an absolute path, asserting it stays inside the root.
   *
   * This is the path-traversal guard. `path.resolve` collapses `..`
   * segments, so a key like `../../etc/passwd` resolves outside the root —
   * and the prefix check below catches it.
   *
   * The check compares against `this.root` plus a separator, so a sibling
   * directory whose name merely starts with the root's name (e.g.
   * `public/uploads-evil`) does not pass.
   *
   * @throws StorageError when the key escapes the upload root.
   */
  private resolveKeyPath(key: string): string {
    if (typeof key !== "string" || key.trim().length === 0) {
      throw new StorageError("INVALID_KEY", "The storage key is empty.");
    }

    // A null byte truncates the path in some system calls. Reject it
    // outright rather than relying on the resolve check alone.
    if (key.includes("\0")) {
      throw new StorageError(
        "INVALID_KEY",
        "The storage key contains an invalid character.",
      );
    }

    const absolutePath = path.resolve(this.root, key);
    const rootWithSeparator = this.root.endsWith(path.sep)
      ? this.root
      : `${this.root}${path.sep}`;

    if (!absolutePath.startsWith(rootWithSeparator)) {
      throw new StorageError(
        "INVALID_KEY",
        "The storage key points outside the upload directory.",
      );
    }

    return absolutePath;
  }
}

/**
 * The shared driver instance.
 *
 * A module-level singleton, so the resolved root is computed once rather
 * than on every call.
 */
let sharedDriver: LocalStorageDriver | null = null;

/**
 * Returns the shared local driver, creating it on first use.
 */
export function getLocalStorageDriver(): LocalStorageDriver {
  if (!sharedDriver) {
    sharedDriver = new LocalStorageDriver();
  }

  return sharedDriver;
}
