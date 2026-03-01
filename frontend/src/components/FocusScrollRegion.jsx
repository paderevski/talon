import { useEffect, useRef, useState } from "react";

export default function FocusScrollRegion({ className = "", children, ariaLabel = "Scrollable panel" }) {
  const containerRef = useRef(null);
  const [isActive, setIsActive] = useState(false);
  const isActiveRef = useRef(false);

  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

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

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return undefined;
    }

    const onWheel = (event) => {
      if (isActiveRef.current) {
        return;
      }

      event.preventDefault();
      window.scrollBy({
        top: event.deltaY,
        left: event.deltaX,
        behavior: "auto",
      });
    };

    container.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      container.removeEventListener("wheel", onWheel);
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className={`table-scroll-region scroll-focus-region ${className} ${isActive ? "scroll-focus-active" : ""}`.trim()}
      onPointerDown={() => setIsActive(true)}
      onFocus={() => setIsActive(true)}
      tabIndex={0}
      aria-label={ariaLabel}
    >
      {children}
    </div>
  );
}
