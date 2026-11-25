import { initialsOf, useAvatarUri } from "../utils/avatar";

// A user's picked avatar, or their initials until they pick one (or while
// the style loads). user: { fullName, username, avatar }.
export function UserAvatar({ user, size = 28, className = "" }) {
  const src = useAvatarUri(user?.avatar ?? null, size * 2);
  const classes = `avatar-circle${className ? ` ${className}` : ""}`;
  const style = { width: size, height: size };
  return src ? (
    <img className={`${classes} avatar-circle-image`} src={src} alt="" style={style} />
  ) : (
    <span className={classes} aria-hidden="true" style={{ ...style, fontSize: Math.round(size * 0.38) }}>
      {initialsOf(user)}
    </span>
  );
}

// The avatar on the left, then whatever the cell shows about the person
// (name, username, chips) stacked on the right.
export default function Person({ user, size = 28, children }) {
  return (
    <div className="person">
      <UserAvatar user={user} size={size} />
      <div className="person-text">{children}</div>
    </div>
  );
}
