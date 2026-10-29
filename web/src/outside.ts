import { api } from './api.ts';

// A link to another site opens in the default browser, through the server's `open`, and never in the board's own
// window. A link inside the diff's shadow root counts too, so the anchor is looked up along the event's path.
export function openLinksOutside() {
  const open = (e: MouseEvent) => {
    if (e.defaultPrevented || e.button > 1) return;
    const a = e.composedPath().find((n): n is HTMLAnchorElement => n instanceof HTMLAnchorElement && n.hasAttribute('href'));
    if (!a || !/^https?:$/.test(a.protocol) || a.origin === location.origin) return;
    e.preventDefault();
    api('POST', '/api/open', { url: a.href }).catch(() => window.open(a.href, '_blank', 'noreferrer'));
  };
  addEventListener('click', open);
  addEventListener('auxclick', open);
}
