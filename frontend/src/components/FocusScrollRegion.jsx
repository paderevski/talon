import { useEffect, useRef, useState } from "react";

export default function FocusScrollRegion({ className = "", children, ariaLabel = "Scrollable panel" }) {
  const containerRef = useRef(null);
  const [isActive, setIsActive] = useState(false);

  useEffect(() => {
    const onDocumentPointerDown = (event) => {
      if (!containerRef.current?.contains(event.target)) {
        setIsActive(false);
      }
    };

    document.addEventListener("pointerdown", onDocumentPointerDown);

    return () => {
      document.removeEventListener("pointerdown", onDocumentPointerDown);
    };
  }, []);

  const onWheelCapture = (event) => {
    if (isActive) {
      return;
    }

    event.preventDefault();
    window.scrollBy({
      top: event.deltaY,
      left: event.deltaX,
      behavior: "auto",
    });
  };

  return (
    <div
      ref={containerRef}
      className={`table-scroll-region scroll-focus-region ${className} ${isActive ? "scroll-focus-active" : ""}`.trim()}
      onPointerDown={() => setIsActive(true)}
      onFocus={() => setIsActive(true)}
      onWheelCapture={onWheelCapture}
      tabIndex={0}
      aria-label={ariaLabel}
    >
      {children}
    </div>
  );
}
