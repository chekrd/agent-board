import 'react';

declare module 'react' {
  interface ButtonHTMLAttributes<T> {
    commandfor?: string;
    command?: string;
  }
  interface DialogHTMLAttributes<T> {
    closedby?: 'any' | 'closerequest' | 'none';
  }
}

declare global {
  interface WebSocketStreamOptions {
    protocols?: string[];
    signal?: AbortSignal;
  }

  interface WebSocketStreamConnection {
    readable: ReadableStream<string | Uint8Array | ArrayBuffer>;
    writable: WritableStream<string | BufferSource>;
    extensions: string;
    protocol: string;
  }

  class WebSocketStream {
    constructor(url: string, options?: WebSocketStreamOptions);
    readonly url: string;
    readonly opened: Promise<WebSocketStreamConnection>;
    readonly closed: Promise<{ closeCode: number; reason: string }>;
    close(info?: { closeCode?: number; reason?: string }): void;
  }

  interface Element {
    setHTML(html: string, options?: { sanitizer?: unknown }): void;
  }
}
