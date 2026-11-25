import { useState } from "react";
import { saveAvatar } from "../api/client";
import { avatarStyleList, randomSeed, useAvatarUri, useAvatarUris } from "../utils/avatar";

const choicesPerStyle = 12;

function freshSeeds() {
  return Array.from({ length: choicesPerStyle }, randomSeed);
}

// Profile: pick an avatar (a DiceBear style and one of a few random
// variations) or go back to initials. onSaved gets the updated user.
export default function ProfileDialog({ user, initials, onClose, onSaved }) {
  const current = user.avatar ?? null;
  const [styleId, setStyleId] = useState(current?.style ?? avatarStyleList[0].id);
  const [seeds, setSeeds] = useState(() => {
    const seeds = freshSeeds();
    // Keep the current one in the grid so it can stay picked.
    if (current) {
      seeds[0] = current.seed;
    }
    return seeds;
  });
  const [picked, setPicked] = useState(current);
  const [error, setError] = useState("");
  const [isBusy, setIsBusy] = useState(false);

  const style = avatarStyleList.find((item) => item.id === styleId) ?? avatarStyleList[0];
  const uris = useAvatarUris(styleId, seeds, 72);
  const preview = useAvatarUri(picked, 96);
  const isUnchanged = (picked?.style ?? null) === (current?.style ?? null) && (picked?.seed ?? null) === (current?.seed ?? null);

  async function save(avatar) {
    setError("");
    setIsBusy(true);
    try {
      const updated = await saveAvatar(avatar);
      onSaved(updated);
      onClose();
    } catch (nextError) {
      setError(nextError.message || "Unable to save the avatar");
      setIsBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal profile-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Profile"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="panel-title">Profile</h2>
        <div className="profile-who">
          {preview ? (
            <img className="profile-preview" src={preview} alt="" />
          ) : (
            <span className="profile-preview profile-preview-initials" aria-hidden="true">{initials}</span>
          )}
          <div>
            <div className="user-menu-name">{user.fullName || user.username}</div>
            <div className="user-menu-username">{user.username}</div>
          </div>
        </div>

        {error ? <div className="repo-error">{error}</div> : null}

        <div className="form-group">
          <label className="form-label" htmlFor="avatar-style">Avatar style</label>
          <div className="profile-style-row">
            <select id="avatar-style" className="form-input" value={styleId} onChange={(event) => setStyleId(event.target.value)}>
              {avatarStyleList.map((item) => (
                <option key={item.id} value={item.id}>{item.title}</option>
              ))}
            </select>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setSeeds(freshSeeds())}>
              Shuffle
            </button>
          </div>
        </div>

        <div className="avatar-grid" role="radiogroup" aria-label="Avatars">
          {seeds.map((seed, index) => {
            const isPicked = picked?.style === styleId && picked?.seed === seed;
            return (
              <button
                key={seed}
                type="button"
                role="radio"
                aria-checked={isPicked}
                className={`avatar-choice${isPicked ? " picked" : ""}`}
                aria-label={`Avatar ${index + 1}`}
                onClick={() => setPicked({ style: styleId, seed })}
              >
                {uris[index] ? <img src={uris[index]} alt="" /> : <span className="avatar-choice-blank" />}
              </button>
            );
          })}
        </div>

        <div className="profile-credit">
          {style.title} by {style.creator}
          {style.license ? (
            <>
              {" · "}
              {style.licenseUrl ? (
                <a href={style.licenseUrl} target="_blank" rel="noreferrer">{style.license}</a>
              ) : (
                style.license
              )}
            </>
          ) : null}
          {" · drawn by DiceBear"}
        </div>

        <div className="form-actions">
          <button type="button" className="btn btn-primary btn-sm" disabled={isBusy || !picked || isUnchanged} onClick={() => save(picked)}>
            Save
          </button>
          {current ? (
            <button type="button" className="btn btn-secondary btn-sm" disabled={isBusy} onClick={() => save(null)}>
              Use initials
            </button>
          ) : null}
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
