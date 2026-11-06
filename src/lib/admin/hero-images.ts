import { deleteStoredObject, type StorageAdapter } from "@/lib/storage";
import { getLocalStorageDriver } from "@/lib/storage/local-driver";

/**
 * The homepage hero's artwork.
 *
 * ── Why this is its own tiny module ─────────────────────────────────────
 *
 * The hero banner's image lives under the `hero` storage scope, and the
 * discovery-image service already knows how to *write* into it — the
 * upload path is shared. What is missing there is the **delete** path,
 * because the discovery sections do not delete their artwork when the
 * row goes: a category's card image and a brand's logo are replaced
 * often enough that a cleanup job handles the orphans.
 *
 * The hero is different. A banner's artwork is referenced by exactly one
 * row — the banner — and a campaign's banner is the most frequently
 * replaced file in the shop. So when the banner goes, its file goes
 * with it.
 *
 * ── Why the deletion is best-effort ───────────────────────────────────────
 *
 * By the time this runs, the row and its audit entry have already
 * committed. The file is a **side effect** of that, not part of it. So a
 * file that cannot be deleted is logged rather than thrown: failing the
 * request here would report a failed deletion for a banner that is, in
 * fact, already gone.
 *
 * An orphaned file is disk space for a maintenance job. A broken
 * storefront is a customer-facing failure. The two are not comparable,
 * and this module always chooses the lesser one.
 */

/**
 * Deletes a hero banner's artwork.
 *
 * @param key    - The storage key to remove.
 * @param adapter - The storage adapter. Defaults to the local driver.
 */
export async function deleteHeroBannerImage(
  key: string,
  adapter: StorageAdapter = getLocalStorageDriver(),
): Promise<void> {
  try {
    await deleteStoredObject(key, adapter);
  } catch (error) {
    console.error(
      `[admin] Hero banner artwork cleanup failed for "${key}":`,
      error,
    );
  }
}
