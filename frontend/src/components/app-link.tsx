"use client";

import NextLink from "next/link";
import { forwardRef, type ComponentProps } from "react";

import { useHref } from "@/lib/nav";

/**
 * `next/link` for app paths: inside the sandbox an app path (`/asset/1`) links to its sandbox
 * twin (`/sandbox/asset/1`). Use `next/link` directly only to leave the sandbox on purpose.
 */
const Link = forwardRef<HTMLAnchorElement, ComponentProps<typeof NextLink>>(
  function Link({ href, ...props }, ref) {
    const resolve = useHref();
    const target =
      typeof href === "string"
        ? resolve(href)
        : href.pathname
          ? { ...href, pathname: resolve(href.pathname) }
          : href;
    return <NextLink ref={ref} href={target} {...props} />;
  },
);

export default Link;
