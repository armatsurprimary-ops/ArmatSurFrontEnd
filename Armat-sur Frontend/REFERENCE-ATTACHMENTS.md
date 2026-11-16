# Reference attachments

Open **Settings → Add reference images**, beside the rulebook controls. Select
multiple PNG, JPEG or WebP files: maps, illustrations, diagrams, or document
pages all use the same library. Export PDF pages to images before importing.

- Use the inclusion checkbox beside each image to choose what to send.
- Use the arrows to set reading order, Preview to inspect an image, and Remove
  to delete it from the library.
- **Send enabled reference images with the rulebook** is the global switch;
  save Settings to apply it. Import, ordering, inclusion and removal save
  immediately, even if the settings dialog is cancelled.

The GM and all AI characters receive the enabled images alongside the text
rulebook on every model request, including regeneration and continuations.
Use this library for shared references, rather than private GM material.
An image-only rulebook can be supplied as ordered page images with the text
rulebook cleared; there is no requirement that an attachment depict a map.

Images are retained in this browser's IndexedDB storage for the current app
address. They survive reloads and session changes, including session resets,
but are not bundled into exported or server-saved sessions. Keep your original
files: clearing browser site data removes this library, and another browser
or app address has its own library.

Each image may be up to 20 MiB and 64 megapixels. There is no application-wide
image-count cap. Browser storage, available memory, and the selected model or
provider's payload, image-count and context limits still apply. Images retain
their original resolution; the app does not compress them or split large
collections across requests. Larger collections incur image input costs on
each request; provider caching may vary.

Fetch the model list in Settings to refresh image-support metadata. Known
text-only models are blocked when references are enabled. Models with unknown
capabilities are allowed to try; provider errors remain visible, and images
are never silently discarded to make a request succeed.

Image tokens depend on the model and resolution. The context meter and request/
chain cost projections include a resolution-based image estimate, marked as
approximate. Prices remain unknown when the model supplies no pricing information.
The context preflight counts text only. Reported usage and charges, when available,
feed the session Total; estimates never replace actual reported usage there.
Local traffic logs omit image payloads.
