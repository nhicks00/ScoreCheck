"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type ContextLink = {
  href: string;
  label: string;
};

const ADMIN_LINKS = [
  { href: "/admin/events", label: "Events" },
  { href: "/admin/monitor", label: "Monitor" },
  { href: "/admin/production", label: "Production" },
  { href: "/admin/commentary", label: "Commentary" },
  { href: "/chat", label: "Live Chat" },
  { href: "/", label: "Home" }
] as const;

export function AdminTopbar({
  contextLinks = [],
  contextLabel = "Related"
}: {
  contextLinks?: ContextLink[];
  contextLabel?: string;
}) {
  const pathname = usePathname();

  return (
    <div className="admin-navigation">
      <header className="topbar admin-topbar">
        <Link className="brand-mark" href="/admin/events">Score<em>Check</em></Link>
        <nav className="topbar-nav admin-global-nav" aria-label="Admin sections">
          {ADMIN_LINKS.map((link) => {
            const active = isActiveAdminLink(pathname, link.href);
            return (
              <Link
                className="admin-nav-link"
                href={link.href}
                key={link.href}
                aria-current={active ? "page" : undefined}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>
        <form className="admin-logout-form" action="/api/admin/logout" method="post">
          <button type="submit">Logout</button>
        </form>
      </header>

      {contextLinks.length > 0 ? (
        <nav className="admin-context-nav" aria-label={contextLabel}>
          <strong>{contextLabel}</strong>
          {contextLinks.map((link) => (
            <Link
              href={link.href}
              key={link.href}
              aria-current={pathname === link.href ? "page" : undefined}
            >
              {link.label}
            </Link>
          ))}
        </nav>
      ) : null}
    </div>
  );
}

function isActiveAdminLink(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  if (href === "/admin/events") {
    return pathname.startsWith("/admin/events") || pathname.startsWith("/admin/courts") || pathname.startsWith("/admin/avp-denver");
  }
  if (href === "/admin/production") {
    return pathname.startsWith("/admin/production") || pathname.startsWith("/admin/stream-preview");
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}
