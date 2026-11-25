import { useEffect, useState } from "react";
import { avatarStyles } from "talon-shared/avatars";

// Avatars are drawn here, in the browser, with DiceBear: no request leaves
// the site. Each style is its own chunk, loaded the first time it is needed,
// so someone showing initials downloads none of it.
const loaders = {
  lorelei: () => import("@dicebear/lorelei"),
  notionists: () => import("@dicebear/notionists"),
  "open-peeps": () => import("@dicebear/open-peeps"),
  adventurer: () => import("@dicebear/adventurer"),
  "big-smile": () => import("@dicebear/big-smile"),
  "fun-emoji": () => import("@dicebear/fun-emoji"),
  croodles: () => import("@dicebear/croodles"),
  bottts: () => import("@dicebear/bottts"),
  "pixel-art": () => import("@dicebear/pixel-art"),
  thumbs: () => import("@dicebear/thumbs"),
};

// Credits shown in the picker (CC BY 4.0 asks for them). From each style
// package's meta; the server only accepts ids in talon-shared/avatars.
const credits = {
  lorelei: { title: "Lorelei", creator: "Lisa Wischofsky", license: "CC0 1.0" },
  notionists: { title: "Notionists", creator: "Zoish", license: "CC0 1.0" },
  "open-peeps": { title: "Open Peeps", creator: "Pablo Stanley", license: "CC0 1.0" },
  adventurer: { title: "Adventurer", creator: "Lisa Wischofsky", license: "CC BY 4.0" },
  "big-smile": { title: "Big Smile", creator: "Ashley Seo", license: "CC BY 4.0" },
  "fun-emoji": { title: "Fun Emoji", creator: "Davis Uche", license: "CC BY 4.0" },
  croodles: { title: "Croodles", creator: "vijay verma", license: "CC BY 4.0" },
  bottts: { title: "Bottts", creator: "Pablo Stanley", license: "Free for personal and commercial use" },
  "pixel-art": { title: "Pixel Art", creator: "DiceBear", license: "CC0 1.0" },
  thumbs: { title: "Thumbs", creator: "DiceBear", license: "CC0 1.0" },
};

const licenseUrls = {
  "CC0 1.0": "https://creativecommons.org/publicdomain/zero/1.0/",
  "CC BY 4.0": "https://creativecommons.org/licenses/by/4.0/",
};

// [{ id, title, creator, license, licenseUrl }] in picker order.
export const avatarStyleList = avatarStyles
  .filter((id) => loaders[id] && credits[id])
  .map((id) => ({ id, ...credits[id], licenseUrl: licenseUrls[credits[id].license] || "" }));

// Pastel backgrounds (the seed picks one): several styles are dark line art
// on a transparent background, which the dark theme would swallow.
const backgroundColor = ["b6e3f4", "c0aede", "d1d4f9", "ffd5dc", "ffdfbf", "c7f0d8"];

let corePromise = null;
const stylePromises = new Map();

// Resolves to a function (seed, size) => data: URI for one style, or null
// if the style is unknown or fails to load.
function loadRenderer(styleId) {
  if (!loaders[styleId]) {
    return Promise.resolve(null);
  }
  if (!stylePromises.has(styleId)) {
    corePromise ??= import("@dicebear/core");
    const promise = Promise.all([corePromise, loaders[styleId]()])
      .then(([core, style]) => (seed, size) =>
        core.createAvatar(style, { seed, size, backgroundColor }).toDataUri(),
      )
      .catch(() => {
        stylePromises.delete(styleId);
        return null;
      });
    stylePromises.set(styleId, promise);
  }
  return stylePromises.get(styleId);
}

// data: URIs for several seeds of one style; [] until the style has loaded.
export function useAvatarUris(styleId, seeds, size = 64) {
  const [uris, setUris] = useState({ key: "", list: [] });
  const key = `${styleId}|${size}|${seeds.join(",")}`;
  useEffect(() => {
    let cancelled = false;
    loadRenderer(styleId).then((render) => {
      if (!cancelled) {
        setUris({ key, list: render ? seeds.map((seed) => render(seed, size)) : [] });
      }
    });
    return () => {
      cancelled = true;
    };
    // key covers styleId, size and seeds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return uris.key === key ? uris.list : [];
}

// The data: URI for an { style, seed } avatar, or "" (none, still loading,
// or unknown style): show initials meanwhile.
export function useAvatarUri(avatar, size = 64) {
  const list = useAvatarUris(avatar?.style ?? "", avatar ? [avatar.seed] : [], size);
  return avatar ? list[0] ?? "" : "";
}

// A short random seed (letters and digits), matching the server's rule.
export function randomSeed() {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

// Initials from the full name ("Ada Lovelace" -> AL), else the username.
export function initialsOf(user) {
  const value = String(user?.fullName || user?.username || "").trim();
  if (!value) {
    return "--";
  }
  const parts = value.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  }
  return value.slice(0, 2).toUpperCase();
}
